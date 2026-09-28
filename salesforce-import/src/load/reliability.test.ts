import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoad } from './index.js';
import { dataPath, readJson, writeNdjson } from '../artifacts.js';
import { Ledger } from './ledger.js';
import { MondayClient } from './monday.js';
import { SF_ID_COLUMN } from './lookup.js';
import { createResponse, parseCreates, relationsIn } from './fakeCreates.js';

// Every guarantee here must hold for the batched default AND the --sequential fallback.
const MODES: [string, string[]][] = [['batched', []], ['sequential', ['--sequential']]];

// A stateful stand-in for Monday: boards hold items tagged by their Salesforce ID column, so
// lookups and scans see exactly what earlier create_item calls committed.
interface FakeItem { id: string; boardId: string; name: string; sfId?: string; archived: boolean;
  rel?: Record<string, number[]> }
class FakeMonday {
  items: FakeItem[] = [];
  lookups = 0;
  creates: string[][] = []; // item names per create request
  inFlight = 0;
  maxInFlight = 0;
  latencyMs = 0;
  archiveInFlight = 0;
  maxArchiveInFlight = 0;
  echoRelations = true; // false: create_item's response omits the relations it stored
  columnTitles = new Map<string, string>(); // column id → title
  links: { itemId: string; targetIds: number[] }[] = [];
  archived: string[] = [];
  nextId = 100;
  // Per item name: what the next create_item for it does. 'lost' commits then answers 502
  // (the response never reaches us); 'fail' answers 502 without committing; 'error' is a
  // definite GraphQL rejection.
  createFaults = new Map<string, ('lost' | 'fail' | 'error')[]>();

  client(): MondayClient {
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { query: string; variables: Record<string, unknown> };
      // In-flight tracking for the pooled writes: creates, and archives (tracked separately).
      const kind = /create_item/.test(body.query) ? 'create' : /archive_item/.test(body.query) ? 'archive' : null;
      if (kind === 'create') { this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight); }
      if (kind === 'archive') { this.archiveInFlight++; this.maxArchiveInFlight = Math.max(this.maxArchiveInFlight, this.archiveInFlight); }
      try {
        if (kind && this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
        return this.handle(body);
      } finally {
        if (kind === 'create') this.inFlight--;
        if (kind === 'archive') this.archiveInFlight--;
      }
    }) as typeof fetch;
    return new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
  }

  private active(boardId: string) {
    return this.items.filter((i) => i.boardId === boardId && !i.archived);
  }

  private handle({ query, variables }: { query: string; variables: Record<string, unknown> }): Response {
    if (/create_board/.test(query)) return Response.json({ data: { create_board: { id: String(this.nextId++), items_page: { items: [] } } } });
    if (/create_column/.test(query)) {
      const id = `col_${this.columnTitles.size}`;
      this.columnTitles.set(id, variables['title'] as string);
      return Response.json({ data: { create_column: { id } } });
    }
    if (/items_page_by_column_values/.test(query)) {
      this.lookups++;
      const vals = new Set((variables['vals'] as string[] | undefined) ?? [variables['val'] as string]);
      const found = this.active(variables['board'] as string).filter((i) => i.sfId && vals.has(i.sfId));
      return Response.json({ data: { items_page_by_column_values: { cursor: null,
        items: found.map((i) => ({ id: i.id, column_values: [{ text: i.sfId }] })) } } });
    }
    if (/next_items_page/.test(query)) throw new Error('fake returns a single page');
    if (/items_page \(limit: \$limit\)/.test(query)) {
      const boardId = (variables['ids'] as string[])[0]!;
      const items = this.active(boardId).map((i) => ({ id: i.id, column_values: [{ text: i.sfId ?? null }] }));
      return Response.json({ data: { boards: [{ items_page: { cursor: null, items } }] } });
    }
    if (/boards\s*\(/.test(query)) {
      const columns = [...this.columnTitles].map(([id, title]) => ({ id, title, type: 'text' }));
      return Response.json({ data: { boards: [{ columns }] } });
    }
    const calls = parseCreates(query, variables);
    if (calls) {
      // A batch shares one HTTP response: a 'fail'/'lost' fault on any entry hits them all.
      this.creates.push(calls.map((c) => c.name));
      const faults = calls.map((c) => this.createFaults.get(c.name)?.shift());
      if (faults.includes('fail')) return new Response('bad gateway', { status: 502 });
      const sfColId = [...this.columnTitles].find(([, t]) => t === SF_ID_COLUMN)?.[0];
      const replies = calls.map((c, i) => {
        if (faults[i] === 'error') return { error: `rejected: ${c.name}` };
        const rel = relationsIn(c.cols);
        const item: FakeItem = { id: String(this.nextId++), boardId: c.boardId, name: c.name,
          sfId: sfColId ? c.cols[sfColId] as string : undefined, archived: false, rel };
        this.items.push(item);
        return { id: item.id, rel: this.echoRelations ? rel : {} };
      });
      if (faults.includes('lost')) return new Response('bad gateway', { status: 502 });
      return createResponse(query, calls, replies);
    }
    if (/change_multiple_column_values/.test(query)) {
      const cols = JSON.parse(variables['cols'] as string) as Record<string, { item_ids: number[] }>;
      this.links.push({ itemId: variables['itemId'] as string, targetIds: Object.values(cols)[0]!.item_ids });
      return Response.json({ data: { change_multiple_column_values: { id: variables['itemId'] } } });
    }
    if (/archive_item/.test(query)) {
      const item = this.items.find((i) => i.id === variables['id'])!;
      item.archived = true;
      this.archived.push(item.id);
      return Response.json({ data: { archive_item: { id: item.id } } });
    }
    if (/delete_item/.test(query)) return Response.json({ data: { delete_item: { id: variables['id'] } } });
    throw new Error(`unexpected query: ${query.slice(0, 80)}`);
  }

  byName(name: string) { return this.items.filter((i) => i.name === name); }
}

let monday: FakeMonday;
beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-')));
  process.env['MONDAY_API_TOKEN'] = 'test-token';
  monday = new FakeMonday();
});

describe.each(MODES)('runLoad duplicate-safe creates (#19) (%s)', (mode, flags) => {
  beforeEach(async () => {
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
      { board: 'organizations', sfId: 'a1', name: 'Acme', columns: {} },
      { board: 'organizations', sfId: 'a2', name: 'Bolt', columns: {} },
    ]);
  });

  it('stamps every created item with its Salesforce ID', async () => {
    expect(await runLoad([...flags], { client: monday.client() })).toBe(0);
    expect(monday.items.map((i) => [i.name, i.sfId])).toEqual([['Acme', 'a1'], ['Bolt', 'a2']]);
  });

  it('adopts a create whose response was lost instead of creating a second item', async () => {
    monday.createFaults.set('Acme', ['lost']);
    expect(await runLoad([...flags], { client: monday.client() })).toBe(0);
    expect(monday.byName('Acme')).toHaveLength(1);
    const l = new Ledger(); await l.load();
    expect(l.itemId('a1')).toBe(monday.byName('Acme')[0]!.id);
    const report = await readJson<{ adopted: Record<string, number> }>(dataPath('load', 'report.json'));
    // A batch shares one response, so losing it strands both creates; both are adopted.
    expect(report.adopted['organizations']).toBe(mode === 'batched' ? 2 : 1);
    expect(monday.byName('Bolt')).toHaveLength(1);
  });

  it('re-creates after an ambiguous failure only once the lookup shows nothing landed', async () => {
    monday.createFaults.set('Acme', ['fail']);
    expect(await runLoad([...flags], { client: monday.client() })).toBe(0);
    expect(monday.byName('Acme')).toHaveLength(1);
  });

  it('ledgers a failure (no duplicate) when every attempt is ambiguous and nothing landed', async () => {
    monday.createFaults.set('Acme', ['fail', 'fail', 'fail']);
    expect(await runLoad([...flags], { client: monday.client() })).toBe(1);
    expect(monday.byName('Acme')).toHaveLength(0);
    const l = new Ledger(); await l.load();
    expect(l.failures().map((f) => f.sfId)).toEqual(['a1']);
  });

  it('adopts items created before a crash lost their ledger entries, on the next run', async () => {
    expect(await runLoad([...flags], { client: monday.client() })).toBe(0);
    // Simulate the crash window: Monday has both items, the ledger lost Bolt's entry.
    const { writeFileSync, readFileSync } = await import('node:fs');
    const path = dataPath('load', 'ledger.ndjson');
    writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter((l) => !l.includes('"a2"')).join('\n'));

    expect(await runLoad([...flags], { client: monday.client() })).toBe(0);
    expect(monday.byName('Bolt')).toHaveLength(1); // not re-created
    const l = new Ledger(); await l.load();
    expect(l.itemId('a2')).toBe(monday.byName('Bolt')[0]!.id);
  });

  it('reports (never deletes) Salesforce Ids already duplicated on Monday, and exits 1', async () => {
    expect(await runLoad([...flags], { client: monday.client() })).toBe(0);
    monday.items.push({ ...monday.byName('Bolt')[0]!, id: '999' }); // a pre-existing duplicate
    const { writeFileSync, readFileSync } = await import('node:fs');
    const path = dataPath('load', 'ledger.ndjson');
    writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter((l) => !l.includes('"a2"')).join('\n'));

    expect(await runLoad([...flags], { client: monday.client() })).toBe(1);
    expect(monday.byName('Bolt')).toHaveLength(2);
    const report = await readJson<{ duplicates: { sfId: string; itemIds: string[] }[] }>(dataPath('load', 'report.json'));
    expect(report.duplicates).toEqual([{ board: 'organizations', sfId: 'a2', itemIds: [monday.byName('Bolt')[0]!.id, '999'] }]);
  });

  it('rejects --limit without a positive number instead of silently loading nothing', async () => {
    expect(await runLoad(['--limit', ...flags], { client: monday.client() })).toBe(1);
    expect(await runLoad(['--limit', 'abc', ...flags], { client: monday.client() })).toBe(1);
    expect(monday.items).toEqual([]);
  });
});

describe.each(MODES)('runLoad partial and pending links (#21) (%s)', (_mode, flags) => {
  beforeEach(async () => {
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
      { board: 'people-live', sfId: 'c1', name: 'Ada', columns: {} },
      { board: 'people-live', sfId: 'c2', name: 'Bea', columns: {} },
      { board: 'donations', sfId: 'o1', name: 'OldGift', archive: true,
        columns: { 'Fiscal Year Ending': '2015' },
        links: [{ column: 'Donor', targetSfIds: ['c1', 'c2', 'c-never-migrated'] }] },
    ]);
  });

  it('does not archive a donation whose Donor create failed; links and archives it on re-run', async () => {
    monday.createFaults.set('Bea', ['error']);
    expect(await runLoad([...flags], { client: monday.client() })).toBe(1);
    const gift = monday.byName('OldGift')[0]!;
    expect(monday.archived).toEqual([]); // would otherwise strand the Bea link behind an archive
    expect(monday.links.at(-1)).toEqual({ itemId: gift.id, targetIds: [Number(monday.byName('Ada')[0]!.id)] });

    expect(await runLoad([...flags], { client: monday.client() })).toBe(0);
    // The partial link was rewritten with the full resolvable set, then the gift archived.
    expect(monday.links.at(-1)).toEqual({ itemId: gift.id,
      targetIds: [Number(monday.byName('Ada')[0]!.id), Number(monday.byName('Bea')[0]!.id)] });
    expect(monday.archived).toEqual([gift.id]);
    const report = await readJson<{ links: { pending: number; skippedByDesign: number } }>(dataPath('load', 'report.json'));
    expect(report.links.pending).toBe(0);
  });

  it('treats targets that were never migrated as skipped by design, not pending', async () => {
    expect(await runLoad([...flags], { client: monday.client() })).toBe(0);
    expect(monday.archived).toHaveLength(1);
    const report = await readJson<{ links: { partial: number; pending: number } }>(dataPath('load', 'report.json'));
    expect(report.links).toMatchObject({ partial: 1, pending: 0 });
  });

  it('does not rewrite a link whose recorded targets already cover everything resolvable', async () => {
    expect(await runLoad([...flags], { client: monday.client() })).toBe(0);
    const writes = monday.links.length;
    expect(await runLoad([...flags], { client: monday.client() })).toBe(0);
    expect(monday.links.length).toBe(writes);
  });
});

describe('runLoad batched creates (#22)', () => {
  const orgs = (n: number) => Array.from({ length: n }, (_, i) =>
    ({ board: 'organizations', sfId: `a${i}`, name: `Org${i}`, columns: {} }));
  const ledgerLines = async () => {
    const { readFileSync } = await import('node:fs');
    return readFileSync(dataPath('load', 'ledger.ndjson'), 'utf8').split('\n').filter(Boolean);
  };

  it('sends --batch-size creates per request with at most --concurrency requests in flight', async () => {
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), orgs(12));
    monday.latencyMs = 5;
    expect(await runLoad(['--batch-size', '5', '--concurrency', '2'], { client: monday.client() })).toBe(0);
    expect(monday.creates.map((c) => c.length)).toEqual([5, 5, 2]);
    expect(monday.maxInFlight).toBe(2);
    const l = new Ledger(); await l.load();
    for (let i = 0; i < 12; i++) expect(l.itemId(`a${i}`)).toBeDefined();
  });

  it('partial alias failure: ledgers the successes and the one failure; the re-run creates only that one', async () => {
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), orgs(3));
    monday.createFaults.set('Org1', ['error']);
    expect(await runLoad([], { client: monday.client() })).toBe(1);
    expect(monday.creates).toEqual([['Org0', 'Org1', 'Org2']]); // the rejected alias is not re-sent
    const l = new Ledger(); await l.load();
    expect(l.failures().map((f) => f.sfId)).toEqual(['a1']);
    expect(l.itemId('a0')).toBe(monday.byName('Org0')[0]!.id);
    expect(l.itemId('a2')).toBe(monday.byName('Org2')[0]!.id);

    expect(await runLoad([], { client: monday.client() })).toBe(0);
    expect(monday.creates.at(-1)).toEqual(['Org1']);
    for (const n of ['Org0', 'Org1', 'Org2']) expect(monday.byName(n)).toHaveLength(1);
  });

  it('ambiguous response after commit: every entry is looked up and adopted, none re-sent', async () => {
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), orgs(3));
    monday.createFaults.set('Org2', ['lost']);
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    expect(monday.creates).toHaveLength(1);
    expect(monday.lookups).toBe(1);
    for (const n of ['Org0', 'Org1', 'Org2']) expect(monday.byName(n)).toHaveLength(1);
    const report = await readJson<{ adopted: Record<string, number>; created: Record<string, number> }>(
      dataPath('load', 'report.json'));
    expect(report.adopted['organizations']).toBe(3);
    expect(report.created['organizations'] ?? 0).toBe(0);
  });

  it('crash between send and ledger write: the resumed run finds and adopts the whole batch', async () => {
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), orgs(4));
    // The process dies on the first ledger append after Monday committed the batch.
    const spy = vi.spyOn(Ledger.prototype, 'recordSuccess').mockRejectedValueOnce(new Error('SIGKILL'));
    await expect(runLoad(['--batch-size', '4'], { client: monday.client() })).rejects.toThrow('SIGKILL');
    spy.mockRestore();
    expect(monday.items).toHaveLength(4);
    // Nothing reached the ledger: the crash hit the very first append.
    expect(existsSync(dataPath('load', 'ledger.ndjson'))).toBe(false);

    const createsBefore = monday.creates.length;
    expect(await runLoad(['--batch-size', '4'], { client: monday.client() })).toBe(0);
    expect(monday.creates.length).toBe(createsBefore); // nothing re-created
    expect(monday.items).toHaveLength(4);
    const l = new Ledger(); await l.load();
    for (let i = 0; i < 4; i++) expect(l.itemId(`a${i}`)).toBe(monday.byName(`Org${i}`)[0]!.id);
  });

  it('never creates one Salesforce Id twice — not for a repeated payload, nor one already on Monday', async () => {
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
      ...orgs(3), { board: 'organizations', sfId: 'a1', name: 'Org1 again', columns: {} }]);
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    expect(monday.items.filter((i) => i.sfId === 'a1')).toHaveLength(1);

    // Org2 is on Monday but its ledger line is gone (crash); a new payload joins the run.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dataPath('load', 'ledger.ndjson'),
      (await ledgerLines()).filter((l) => !l.includes('"a2"')).join('\n') + '\n');
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), orgs(4));
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    expect(monday.creates.at(-1)).toEqual(['Org3']);
    for (let i = 0; i < 4; i++) expect(monday.items.filter((it) => it.sfId === `a${i}`)).toHaveLength(1);
  });

  it('archives a fiscal year --concurrency at a time, once its links are in; --sequential keeps it to one', async () => {
    const gifts = Array.from({ length: 8 }, (_, i) => ({ board: 'donations', sfId: `o${i}`, name: `G${i}`,
      archive: true, columns: { 'Fiscal Year Ending': '2015' }, links: [{ column: 'Donor', targetSfIds: ['c1'] }] }));
    await writeNdjson(dataPath('transform', 'payloads.ndjson'),
      [{ board: 'people-live', sfId: 'c1', name: 'Ada', columns: {} }, ...gifts]);
    monday.latencyMs = 3;
    expect(await runLoad(['--concurrency', '3'], { client: monday.client() })).toBe(0);
    expect(monday.archived).toHaveLength(8);
    expect(monday.maxArchiveInFlight).toBe(3);
    const l = new Ledger(); await l.load();
    for (let i = 0; i < 8; i++) expect(l.archivedDone(`o${i}`)).toBe(true);

    process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-')));
    monday = new FakeMonday();
    monday.latencyMs = 3;
    await writeNdjson(dataPath('transform', 'payloads.ndjson'),
      [{ board: 'people-live', sfId: 'c1', name: 'Ada', columns: {} }, ...gifts]);
    expect(await runLoad(['--sequential'], { client: monday.client() })).toBe(0);
    expect(monday.archived).toHaveLength(8);
    expect(monday.maxArchiveInFlight).toBe(1);
  });

  it('refuses an out-of-range --batch-size before touching Monday', async () => {
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), orgs(1));
    expect(await runLoad(['--batch-size', '26'], { client: monday.client() })).toBe(1);
    expect(monday.items).toEqual([]);
    expect(monday.columnTitles.size).toBe(0);
  });
});

describe('runLoad inline relations (#22)', () => {
  const seedGifts = () => writeNdjson(dataPath('transform', 'payloads.ndjson'), [
    { board: 'organizations', sfId: 'acme', name: 'Acme', columns: {} },
    { board: 'people-live', sfId: 'c1', name: 'Ada', columns: {} },
    { board: 'campaigns', sfId: 'camp', name: 'Gala', columns: {} },
    { board: 'recurring-gifts', sfId: 'rg', name: 'Monthly', columns: {},
      links: [{ column: 'Donor', targetSfIds: ['c1'] }] },
    { board: 'donations', sfId: 'o1', name: 'Gift', archive: true, columns: { 'Fiscal Year Ending': '2015' },
      links: [{ column: 'Donor', targetSfIds: ['c1'] }, { column: 'Campaign', targetSfIds: ['camp'] },
        { column: 'Recurring Gift', targetSfIds: ['rg'] }, { column: 'Matched By', targetSfIds: ['acme'] }] },
  ]);
  const id = (name: string) => Number(monday.byName(name)[0]!.id);
  const colId = (title: string) => [...monday.columnTitles].find(([, t]) => t === title)![0];

  it('sets Donor, Campaign, Recurring Gift and Matched By inside create_item — no separate link mutations', async () => {
    await seedGifts();
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    expect(monday.links).toEqual([]); // not one change_multiple_column_values
    const gift = monday.byName('Gift')[0]!;
    expect(gift.rel).toEqual({ [colId('Donor')]: [id('Ada')], [colId('Campaign')]: [id('Gala')],
      [colId('Recurring Gift')]: [id('Monthly')], [colId('Matched By')]: [id('Acme')] });
    expect(monday.archived).toEqual([gift.id]); // links complete, so #21's gate lets it archive
    const l = new Ledger(); await l.load();
    for (const c of ['Donor', 'Campaign', 'Recurring Gift', 'Matched By']) expect(l.linkDone('o1', c)).toBe(true);
    expect(l.linkCovers('o1', 'Donor', ['c1'])).toBe(true);
    const report = await readJson<{ links: Record<string, number> }>(dataPath('load', 'report.json'));
    expect(report.links).toMatchObject({ inline: 5, written: 0, inlineUnconfirmed: 0 });

    // validate reads the same ledger entries and passes link integrity.
    const { writeJson } = await import('../artifacts.js');
    await writeJson('config/svbc.json', { salesforceOrg: 'svbc', cutoverDateISO: '2026-10-09',
      peopleActiveSinceISO: '2019-01-01', activitySliceSinceISO: '2024-08-01', boardMaxItems: 9000,
      donationsActiveFiscalYears: 2, monday: { apiUrl: 'x', boardSuffix: '', boards: {} },
      localNews: { rules: [], defaultUrl: '', defaultName: '' }, reconciliation: {} });
    const { runValidate } = await import('../validate/index.js');
    expect(await runValidate([])).toBe(0);
  });

  it('a relation create_item did not echo back is written by the link pass instead', async () => {
    await seedGifts();
    monday.echoRelations = false;
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    const gift = monday.byName('Gift')[0]!;
    expect(monday.links.filter((l) => l.itemId === gift.id)).toHaveLength(4);
    const report = await readJson<{ links: Record<string, number> }>(dataPath('load', 'report.json'));
    expect(report.links).toMatchObject({ inline: 0, inlineUnconfirmed: 5, written: 5 });
  });

  it('an adopted item (response lost) gets its links from the link pass — never trusted blind', async () => {
    await seedGifts();
    monday.createFaults.set('Gift', ['lost']);
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    const gift = monday.byName('Gift');
    expect(gift).toHaveLength(1);
    expect(monday.links.filter((l) => l.itemId === gift[0]!.id)).toHaveLength(4);
  });

  it('--no-inline-links writes every relation through the link pass', async () => {
    await seedGifts();
    expect(await runLoad(['--no-inline-links'], { client: monday.client() })).toBe(0);
    expect(monday.byName('Gift')[0]!.rel).toEqual({});
    expect(monday.links).toHaveLength(5);
  });
});

describe('ensureBoards persistence', () => {
  it('saves each board id as soon as it exists, so a later failure never re-creates the board', async () => {
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
      { board: 'organizations', sfId: 'a1', name: 'Acme', columns: { 'No Such Column': 'x' } },
    ]);
    await expect(runLoad([], { client: monday.client() })).rejects.toThrow(/no COLUMN_TYPES entry/);
    expect(existsSync(dataPath('load', 'boards.json'))).toBe(true);
    const saved = await readJson<Record<string, { boardId: number }>>(dataPath('load', 'boards.json'));
    expect(saved['organizations']?.boardId).toBeGreaterThan(0);
  });
});
