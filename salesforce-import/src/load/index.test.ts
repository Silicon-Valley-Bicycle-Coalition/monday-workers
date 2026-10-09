import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoad } from './index.js';
import { writeNdjson, dataPath } from '../artifacts.js';
import { Ledger } from './ledger.js';
import { MondayClient } from './monday.js';
import { createResponse, parseCreates } from './fakeCreates.js';

// Every behaviour here must hold for the batched default AND the --sequential fallback.
// 'sequential' is the default (no flags); batching is opt-in with --batched.
const MODES: [string, string[]][] = [['batched', ['--batched']], ['sequential', []]];

let created: { name: string; board: number }[];
let linked: string[];
let archived: string[];
let createRequests: { query: string; variables: Record<string, unknown> }[];
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
    const calls = parseCreates(query, variables);
    if (calls) {
      createRequests.push({ query, variables });
      return createResponse(query, calls, calls.map((c) => {
        if (failFor.has(c.name)) return { error: `boom: ${c.name}` };
        created.push({ name: c.name, board: Number(c.boardId) });
        events.push(`create:${c.name}`);
        return { id: String(100 + created.length) };
      }));
    }
    // Recovery lookups after a rejected alias: this fake never holds a rejected item.
    if (/items_page_by_column_values/.test(query)) {
      return Response.json({ data: { items_page_by_column_values: { cursor: null, items: [] } } });
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

describe.each(MODES)('runLoad (%s)', (_mode, flags) => {
  beforeEach(async () => {
    process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-')));
    created = []; linked = []; archived = []; createRequests = []; linkVariables = []; events = [];
    process.env['MONDAY_API_TOKEN'] = 'test-token';
    await seed();
  });

  it('creates items in dependency order then links', async () => {
    expect(await runLoad([...flags], { client: fakeClient() })).toBe(0);
    expect(created.map((c) => c.name)).toEqual(['Acme', 'Ada', 'Gift']); // orgs before people before donations
    expect(linked.length).toBe(2);
    expect(archived).toEqual([]); // no payload carried an archive flag
  });

  it('sends create_labels_if_missing: true on both create_item and change_multiple_column_values', async () => {
    expect(await runLoad([...flags], { client: fakeClient() })).toBe(0);
    expect(createRequests.length).toBeGreaterThan(0);
    for (const { query, variables } of createRequests) {
      // The sequential mutation passes it as a variable; the batch writes it into every alias.
      if ('create' in variables) expect(variables['create']).toBe(true);
      else expect(query.match(/create_item \(/g)!.length).toBe(query.match(/create_labels_if_missing: true/g)!.length);
    }
    expect(linkVariables.length).toBeGreaterThan(0);
    for (const v of linkVariables) expect(v['create']).toBe(true);
  });

  it('dry-run writes nothing', async () => {
    expect(await runLoad(['--dry-run', ...flags], { client: fakeClient() })).toBe(0);
    expect(created).toEqual([]);
  });

  it('dry-run reports old vs new request counts for the transform output (#22)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runLoad(['--dry-run', '--request-ms', '1000', ...flags], { client: fakeClient() })).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    log.mockRestore();
    expect(out).toMatch(flags.length ? /load: mode = batched \(size 10, concurrency 3, inline links on\)/
      : /load: mode = sequential \(default\)/);
    expect(out).toMatch(/old \(default \/ --sequential\): 3 create_item \+ 2 link \+ 0 archive = 5 requests/);
    // "new" always describes --batched's settings, even when this run is sequential.
    expect(out).toMatch(/new \(--batched\): 3 create requests \(3 create_item, 2 links inline\) \+ 0 link/);
    expect(out).toMatch(/1000 ms per request/);
    expect(out).toMatch(/batch 10\)/);
    expect(out).toMatch(/pool size does not change this/);
    expect(linked).toEqual([]);
  });

  it('failures are ledgered, exit 1, and only failures retry on re-run', async () => {
    expect(await runLoad([...flags], { client: fakeClient(new Set(['Gift'])) })).toBe(1);
    const l = new Ledger(); await l.load();
    expect(l.failures().map((f) => f.sfId)).toEqual(['o1']);

    created = [];
    expect(await runLoad([...flags], { client: fakeClient() })).toBe(0);
    expect(created.map((c) => c.name)).toEqual(['Gift']); // Acme/Ada skipped via ledger
  });

  it('link failures are ledgered distinctly, exit 1, and only the failed link retries', async () => {
    // Items are created in order Acme, Ada, Gift, so their ids are deterministically
    // 101/102/103 (id = 100 + created.length at the time of that create_item call). Failing
    // the change_multiple_column_values call for itemId '103' fails Gift's own Donor link
    // write without touching item creation for any of the three payloads.
    expect(await runLoad([...flags], { client: fakeClient(new Set(), new Set(['103'])) })).toBe(1);
    expect(created.map((c) => c.name)).toEqual(['Acme', 'Ada', 'Gift']); // all items still created

    const l = new Ledger(); await l.load();
    expect(l.failures().map((f) => f.sfId)).toEqual(['o1']); // link failure, not an item-create failure
    expect(l.linkDone('c1', 'Organization')).toBe(true); // Ada's link succeeded
    expect(l.linkDone('o1', 'Donor')).toBe(false); // Gift's link did not

    created = []; linked = [];
    expect(await runLoad([...flags], { client: fakeClient() })).toBe(0);
    expect(created).toEqual([]); // no items re-created
    expect(linked).toEqual(['103']); // only the previously-failed link retried
    const l2 = new Ledger(); await l2.load();
    expect(l2.failures()).toEqual([]);
    expect(l2.linkDone('o1', 'Donor')).toBe(true);
  });
});

describe.each(MODES)('runLoad donations archive-in-place (phase 3) (%s)', (_mode, flags) => {
  beforeEach(async () => {
    process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-')));
    created = []; linked = []; archived = []; createRequests = []; linkVariables = []; events = [];
    process.env['MONDAY_API_TOKEN'] = 'test-token';
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
      { board: 'people-live', sfId: 'c1', name: 'Ada', columns: {} },
      { board: 'event-registrations', sfId: 'r1', name: 'Reg', columns: {},
        links: [{ column: 'Attendee', targetSfIds: ['c1'] }, { column: 'Payment', targetSfIds: ['o-old'] }] },
      { board: 'donations', sfId: 'o-old', name: 'OldGift', archive: true,
        columns: { 'Fiscal Year Ending': '2015' }, links: [{ column: 'Donor', targetSfIds: ['c1'] }] },
      { board: 'donations', sfId: 'o-new', name: 'NewGift',
        columns: { 'Fiscal Year Ending': '2027' }, links: [{ column: 'Donor', targetSfIds: ['c1'] }] },
    ]);
  });

  it('per fiscal year: creates, links both directions, then archives flagged years', async () => {
    expect(await runLoad([...flags], { client: fakeClient() })).toBe(0);
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
    expect(await runLoad([...flags], { client: fakeClient(new Set(), new Set(['103'])) })).toBe(1);
    expect(archived).toEqual([]); // never archived with a missing link — that would strand the retry
    const l = new Ledger(); await l.load();
    expect(l.archivedDone('o-old')).toBe(false);
    expect(l.linkDone('r1', 'Payment')).toBe(true); // Reg's inbound link (source 102) still landed

    created = []; linked = []; archived = []; events = [];
    expect(await runLoad([...flags], { client: fakeClient() })).toBe(0);
    expect(created).toEqual([]); // nothing re-created
    expect(linked).toEqual(['103']); // only the failed Donor link retried
    expect(archived).toEqual(['103']); // and the item archived right after it landed
    const l2 = new Ledger(); await l2.load();
    expect(l2.failures()).toEqual([]);
    expect(l2.archivedDone('o-old')).toBe(true);
  });

  it('defers archiving a donation that is the TARGET of a failed incoming link, then archives once it lands', async () => {
    // Reg is item 102; failing its change_multiple_column_values writes fails BOTH its links —
    // Attendee (phase 2) and the deferred incoming Payment link whose TARGET is OldGift (103).
    // The link failures are ledgered under Reg's sfId (r1), not the donation's (o-old), so the
    // archive gate must know link targets or OldGift archives with its Payment link missing.
    expect(await runLoad([...flags], { client: fakeClient(new Set(), new Set(['102'])) })).toBe(1);
    expect(archived).toEqual([]); // OldGift NOT archived — the failed Payment link points into it
    const l = new Ledger(); await l.load();
    expect(l.archivedDone('o-old')).toBe(false);
    expect(l.linkDone('r1', 'Payment')).toBe(false);
    expect(l.linkDone('o-old', 'Donor')).toBe(true); // the donation's own outgoing link landed

    // Recovery: the retry lands the Payment link, and only then does OldGift archive.
    created = []; linked = []; archived = []; events = [];
    expect(await runLoad([...flags], { client: fakeClient() })).toBe(0);
    expect(created).toEqual([]);
    expect(linked).toEqual(['102', '102']); // Attendee + Payment retried, nothing else
    expect(archived).toEqual(['103']);
    expect(events.indexOf('archive:103')).toBeGreaterThan(events.lastIndexOf('link:102'));
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
        const calls = parseCreates(query, variables);
        if (calls) {
          return createResponse(query, calls, calls.map((c) => {
            created.push({ name: c.name, board: Number(c.boardId) });
            return { id: String(100 + created.length) };
          }));
        }
        if (/change_multiple_column_values/.test(query)) {
          return Response.json({ data: { change_multiple_column_values: { id: variables.itemId } } });
        }
        throw new Error(`unexpected query: ${query.slice(0, 60)}`);
      }) as typeof fetch;
      return new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
    };

    expect(await runLoad([...flags], { client: archiveFailClient() })).toBe(1);
    const l = new Ledger(); await l.load();
    expect(l.failures().map((f) => f.board)).toEqual(['archive']);
    expect(l.archivedDone('o-old')).toBe(false);

    created = []; linked = []; archived = [];
    expect(await runLoad([...flags], { client: fakeClient() })).toBe(0);
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
      const calls = parseCreates(query, variables);
      if (calls) return createResponse(query, calls, calls.map(() => ({ id: String(++itemCount) })));
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
