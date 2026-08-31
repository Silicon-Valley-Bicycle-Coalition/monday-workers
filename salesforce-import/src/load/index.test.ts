import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoad } from './index.js';
import { writeNdjson, dataPath } from '../artifacts.js';
import { Ledger } from './ledger.js';
import { MondayClient } from './monday.js';

let created: { name: string; board: number }[];
let linked: string[];
let archived: string[];
let createItemVariables: Record<string, unknown>[];
let linkVariables: Record<string, unknown>[];
let events: string[]; // interleaved create/link/archive record, e.g. 'create:Gift', 'archive:103'

function fakeClient(failFor: Set<string> = new Set(), failLinksFor: Set<string> = new Set()): MondayClient {
  const fetchFn = (async (_u: unknown, init: unknown) => {
    const { query, variables } = JSON.parse((init as { body: string }).body);
    if (/create_board/.test(query)) return Response.json({ data: { create_board: { id: '900' } } });
    if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
    if (/create_column/.test(query)) return Response.json({ data: { create_column: { id: `c_${Math.random().toString(36).slice(2, 8)}` } } });
    if (/archive_item/.test(query)) {
      archived.push(variables.id as string);
      events.push(`archive:${variables.id}`);
      return Response.json({ data: { archive_item: { id: variables.id } } });
    }
    if (/create_item/.test(query)) {
      createItemVariables.push(variables);
      const name = variables.itemName as string;
      if (failFor.has(name)) return Response.json({ errors: [{ message: `boom: ${name}` }] });
      created.push({ name, board: Number(variables.boardId) });
      events.push(`create:${name}`);
      return Response.json({ data: { create_item: { id: String(100 + created.length) } } });
    }
    if (/change_multiple_column_values/.test(query)) {
      linkVariables.push(variables);
      const itemId = variables.itemId as string;
      if (failLinksFor.has(itemId)) return Response.json({ errors: [{ message: `link boom: ${itemId}` }] });
      linked.push(itemId);
      events.push(`link:${itemId}`);
      return Response.json({ data: { change_multiple_column_values: { id: itemId } } });
    }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  }) as typeof fetch;
  return new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
}

async function seed() {
  await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
    { board: 'organizations', sfId: 'a1', name: 'Acme', columns: { 'Salesforce Debug': { text: 'SF ID: a1' } } },
    { board: 'people-live', sfId: 'c1', name: 'Ada', columns: { 'Salesforce Debug': { text: 'SF ID: c1' } },
      links: [{ column: 'Organization', targetSfIds: ['a1'] }] },
    { board: 'donations', sfId: 'o1', name: 'Gift', columns: { 'Salesforce Debug': { text: 'SF ID: o1' } },
      links: [{ column: 'Donor', targetSfIds: ['c1'] }] },
  ]);
}

describe('runLoad', () => {
  beforeEach(async () => {
    process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-')));
    created = []; linked = []; archived = []; createItemVariables = []; linkVariables = []; events = [];
    process.env['MONDAY_API_TOKEN'] = 'test-token';
    await seed();
  });

  it('creates items in dependency order then links', async () => {
    expect(await runLoad([], { client: fakeClient() })).toBe(0);
    expect(created.map((c) => c.name)).toEqual(['Acme', 'Ada', 'Gift']); // orgs before people before donations
    expect(linked.length).toBe(2);
    expect(archived).toEqual([]); // no payload carried an archive flag
  });

  it('sends create_labels_if_missing: true on both create_item and change_multiple_column_values', async () => {
    expect(await runLoad([], { client: fakeClient() })).toBe(0);
    expect(createItemVariables.length).toBeGreaterThan(0);
    for (const v of createItemVariables) expect(v['create']).toBe(true);
    expect(linkVariables.length).toBeGreaterThan(0);
    for (const v of linkVariables) expect(v['create']).toBe(true);
  });

  it('dry-run writes nothing', async () => {
    expect(await runLoad(['--dry-run'], { client: fakeClient() })).toBe(0);
    expect(created).toEqual([]);
  });

  it('failures are ledgered, exit 1, and only failures retry on re-run', async () => {
    expect(await runLoad([], { client: fakeClient(new Set(['Gift'])) })).toBe(1);
    const l = new Ledger(); await l.load();
    expect(l.failures().map((f) => f.sfId)).toEqual(['o1']);

    created = [];
    expect(await runLoad([], { client: fakeClient() })).toBe(0);
    expect(created.map((c) => c.name)).toEqual(['Gift']); // Acme/Ada skipped via ledger
  });

  it('link failures are ledgered distinctly, exit 1, and only the failed link retries', async () => {
    // Items are created in order Acme, Ada, Gift, so their ids are deterministically
    // 101/102/103 (id = 100 + created.length at the time of that create_item call). Failing
    // the change_multiple_column_values call for itemId '103' fails Gift's own Donor link
    // write without touching item creation for any of the three payloads.
    expect(await runLoad([], { client: fakeClient(new Set(), new Set(['103'])) })).toBe(1);
    expect(created.map((c) => c.name)).toEqual(['Acme', 'Ada', 'Gift']); // all items still created

    const l = new Ledger(); await l.load();
    expect(l.failures().map((f) => f.sfId)).toEqual(['o1']); // link failure, not an item-create failure
    expect(l.linkDone('c1', 'Organization')).toBe(true); // Ada's link succeeded
    expect(l.linkDone('o1', 'Donor')).toBe(false); // Gift's link did not

    created = []; linked = [];
    expect(await runLoad([], { client: fakeClient() })).toBe(0);
    expect(created).toEqual([]); // no items re-created
    expect(linked).toEqual(['103']); // only the previously-failed link retried
    const l2 = new Ledger(); await l2.load();
    expect(l2.failures()).toEqual([]);
    expect(l2.linkDone('o1', 'Donor')).toBe(true);
  });
});

describe('runLoad donations archive-in-place (phase 3)', () => {
  beforeEach(async () => {
    process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-')));
    created = []; linked = []; archived = []; createItemVariables = []; linkVariables = []; events = [];
    process.env['MONDAY_API_TOKEN'] = 'test-token';
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
      { board: 'people-live', sfId: 'c1', name: 'Ada', columns: {} },
      { board: 'event-registrations', sfId: 'r1', name: 'Reg', columns: {},
        links: [{ column: 'Attendee', targetSfIds: ['c1'] }, { column: 'Payment', targetSfIds: ['o-old'] }] },
      { board: 'donations', sfId: 'o-old', name: 'OldGift', archive: true,
        columns: { 'Fiscal Year': '2015' }, links: [{ column: 'Donor', targetSfIds: ['c1'] }] },
      { board: 'donations', sfId: 'o-new', name: 'NewGift',
        columns: { 'Fiscal Year': '2027' }, links: [{ column: 'Donor', targetSfIds: ['c1'] }] },
    ]);
  });

  it('per fiscal year: creates, links both directions, then archives flagged years', async () => {
    expect(await runLoad([], { client: fakeClient() })).toBe(0);
    // Ada=101, Reg=102, OldGift=103, NewGift=104.
    expect(created.map((c) => c.name)).toEqual(['Ada', 'Reg', 'OldGift', 'NewGift']);
    expect(archived).toEqual(['103']); // only the flagged FY2015 gift
    // OldGift's Donor link AND Reg's Payment link (deferred out of phase 2) both land
    // strictly before the archive; the retained FY2027 gift is never archived.
    const archiveAt = events.indexOf('archive:103');
    expect(archiveAt).toBeGreaterThan(events.indexOf('create:OldGift'));
    const oldGiftLinks = events.filter((e, i) => e === 'link:103' && i < archiveAt);
    expect(oldGiftLinks.length).toBe(1); // Donor link on OldGift itself
    const regPaymentLink = events.filter((e, i) => e === 'link:102' && i < archiveAt);
    expect(regPaymentLink.length).toBeGreaterThanOrEqual(1); // Payment written pre-archive
    const l = new Ledger(); await l.load();
    expect(l.archivedDone('o-old')).toBe(true);
    expect(l.archivedDone('o-new')).toBe(false);
    expect(l.linkDone('r1', 'Payment')).toBe(true);
  });

  it('defers archiving an item whose links failed, then links and archives it on re-run', async () => {
    // OldGift is item 103 (Ada=101, Reg=102, OldGift=103); fail its Donor link write.
    expect(await runLoad([], { client: fakeClient(new Set(), new Set(['103'])) })).toBe(1);
    expect(archived).toEqual([]); // never archived with a missing link — that would strand the retry
    const l = new Ledger(); await l.load();
    expect(l.archivedDone('o-old')).toBe(false);
    expect(l.linkDone('r1', 'Payment')).toBe(true); // Reg's inbound link (source 102) still landed

    created = []; linked = []; archived = []; events = [];
    expect(await runLoad([], { client: fakeClient() })).toBe(0);
    expect(created).toEqual([]); // nothing re-created
    expect(linked).toEqual(['103']); // only the failed Donor link retried
    expect(archived).toEqual(['103']); // and the item archived right after it landed
    const l2 = new Ledger(); await l2.load();
    expect(l2.failures()).toEqual([]);
    expect(l2.archivedDone('o-old')).toBe(true);
  });

  it('archive failures are ledgered, exit 1, and only the archive retries on re-run', async () => {
    const archiveFailClient = (): MondayClient => {
      const fetchFn = (async (_u: unknown, init: unknown) => {
        const { query, variables } = JSON.parse((init as { body: string }).body);
        if (/create_board/.test(query)) return Response.json({ data: { create_board: { id: '900' } } });
        if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
        if (/create_column/.test(query)) return Response.json({ data: { create_column: { id: `c_${Math.random().toString(36).slice(2, 8)}` } } });
        if (/archive_item/.test(query)) return Response.json({ errors: [{ message: 'archive boom' }] });
        if (/create_item/.test(query)) {
          created.push({ name: variables.itemName as string, board: Number(variables.boardId) });
          return Response.json({ data: { create_item: { id: String(100 + created.length) } } });
        }
        if (/change_multiple_column_values/.test(query)) {
          return Response.json({ data: { change_multiple_column_values: { id: variables.itemId } } });
        }
        throw new Error(`unexpected query: ${query.slice(0, 60)}`);
      }) as typeof fetch;
      return new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
    };

    expect(await runLoad([], { client: archiveFailClient() })).toBe(1);
    const l = new Ledger(); await l.load();
    expect(l.failures().map((f) => f.board)).toEqual(['archive']);
    expect(l.archivedDone('o-old')).toBe(false);

    created = []; linked = []; archived = [];
    expect(await runLoad([], { client: fakeClient() })).toBe(0);
    expect(created).toEqual([]); // nothing re-created
    expect(archived).toEqual(['103']); // only the archive retried
    const l2 = new Ledger(); await l2.load();
    expect(l2.failures()).toEqual([]);
    expect(l2.archivedDone('o-old')).toBe(true);
  });
});

describe('runLoad link concurrency', () => {
  beforeEach(async () => {
    process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-')));
    process.env['MONDAY_API_TOKEN'] = 'test-token';
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
      { board: 'organizations', sfId: 'org-target', name: 'Hub', columns: {} },
      ...Array.from({ length: 12 }, (_, i) => ({
        board: 'people-live', sfId: `p${i}`, name: `P${i}`, columns: {},
        links: [{ column: 'Organization', targetSfIds: ['org-target'] }],
      })),
    ]);
  });

  it('runs link mutations concurrently while ledgering every link', async () => {
    let inFlight = 0, maxInFlight = 0, itemCount = 0;
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/create_board/.test(query)) return Response.json({ data: { create_board: { id: '900' } } });
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
      if (/create_column/.test(query)) return Response.json({ data: { create_column: { id: `c_${Math.random().toString(36).slice(2, 8)}` } } });
      if (/create_item/.test(query)) return Response.json({ data: { create_item: { id: String(++itemCount) } } });
      if (/change_multiple_column_values/.test(query)) {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return Response.json({ data: { change_multiple_column_values: { id: variables.itemId } } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });

    expect(await runLoad([], { client })).toBe(0);

    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    const ledger = new Ledger();
    await ledger.load();
    for (let i = 0; i < 12; i++) expect(ledger.linkDone(`p${i}`, 'Organization')).toBe(true);
  });
});
