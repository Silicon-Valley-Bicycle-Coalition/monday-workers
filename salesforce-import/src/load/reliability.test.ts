import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoad } from './index.js';
import { dataPath, readJson, writeNdjson } from '../artifacts.js';
import { Ledger } from './ledger.js';
import { MondayClient } from './monday.js';
import { SF_ID_COLUMN } from './lookup.js';

// A stateful stand-in for Monday: boards hold items tagged by their Salesforce ID column, so
// lookups and scans see exactly what earlier create_item calls committed.
interface FakeItem { id: string; boardId: string; name: string; sfId?: string; archived: boolean }
class FakeMonday {
  items: FakeItem[] = [];
  columnTitles = new Map<string, string>(); // column id → title
  links: { itemId: string; targetIds: number[] }[] = [];
  archived: string[] = [];
  nextId = 100;
  // Per item name: what the next create_item for it does. 'lost' commits then answers 502
  // (the response never reaches us); 'fail' answers 502 without committing; 'error' is a
  // definite GraphQL rejection.
  createFaults = new Map<string, ('lost' | 'fail' | 'error')[]>();

  client(): MondayClient {
    const fetchFn = (async (_u: unknown, init: unknown) => this.handle(JSON.parse((init as { body: string }).body))) as typeof fetch;
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
      const found = this.active(variables['board'] as string).filter((i) => i.sfId === variables['val']);
      return Response.json({ data: { items_page_by_column_values: { items: found.map((i) => ({ id: i.id })) } } });
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
    if (/create_item/.test(query)) {
      const name = variables['itemName'] as string;
      const fault = this.createFaults.get(name)?.shift();
      if (fault === 'error') return Response.json({ errors: [{ message: `rejected: ${name}` }] });
      if (fault === 'fail') return new Response('bad gateway', { status: 502 });
      const cols = JSON.parse(variables['cols'] as string) as Record<string, unknown>;
      const sfColId = [...this.columnTitles].find(([, t]) => t === SF_ID_COLUMN)?.[0];
      const item: FakeItem = { id: String(this.nextId++), boardId: variables['boardId'] as string, name,
        sfId: sfColId ? cols[sfColId] as string : undefined, archived: false };
      this.items.push(item);
      if (fault === 'lost') return new Response('bad gateway', { status: 502 });
      return Response.json({ data: { create_item: { id: item.id } } });
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

describe('runLoad duplicate-safe creates (#19)', () => {
  beforeEach(async () => {
    await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
      { board: 'organizations', sfId: 'a1', name: 'Acme', columns: {} },
      { board: 'organizations', sfId: 'a2', name: 'Bolt', columns: {} },
    ]);
  });

  it('stamps every created item with its Salesforce ID', async () => {
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    expect(monday.items.map((i) => [i.name, i.sfId])).toEqual([['Acme', 'a1'], ['Bolt', 'a2']]);
  });

  it('adopts a create whose response was lost instead of creating a second item', async () => {
    monday.createFaults.set('Acme', ['lost']);
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    expect(monday.byName('Acme')).toHaveLength(1);
    const l = new Ledger(); await l.load();
    expect(l.itemId('a1')).toBe(monday.byName('Acme')[0]!.id);
    const report = await readJson<{ adopted: Record<string, number> }>(dataPath('load', 'report.json'));
    expect(report.adopted['organizations']).toBe(1);
  });

  it('re-creates after an ambiguous failure only once the lookup shows nothing landed', async () => {
    monday.createFaults.set('Acme', ['fail']);
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    expect(monday.byName('Acme')).toHaveLength(1);
  });

  it('ledgers a failure (no duplicate) when every attempt is ambiguous and nothing landed', async () => {
    monday.createFaults.set('Acme', ['fail', 'fail', 'fail']);
    expect(await runLoad([], { client: monday.client() })).toBe(1);
    expect(monday.byName('Acme')).toHaveLength(0);
    const l = new Ledger(); await l.load();
    expect(l.failures().map((f) => f.sfId)).toEqual(['a1']);
  });

  it('adopts items created before a crash lost their ledger entries, on the next run', async () => {
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    // Simulate the crash window: Monday has both items, the ledger lost Bolt's entry.
    const { writeFileSync, readFileSync } = await import('node:fs');
    const path = dataPath('load', 'ledger.ndjson');
    writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter((l) => !l.includes('"a2"')).join('\n'));

    expect(await runLoad([], { client: monday.client() })).toBe(0);
    expect(monday.byName('Bolt')).toHaveLength(1); // not re-created
    const l = new Ledger(); await l.load();
    expect(l.itemId('a2')).toBe(monday.byName('Bolt')[0]!.id);
  });

  it('reports (never deletes) Salesforce Ids already duplicated on Monday, and exits 1', async () => {
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    monday.items.push({ ...monday.byName('Bolt')[0]!, id: '999' }); // a pre-existing duplicate
    const { writeFileSync, readFileSync } = await import('node:fs');
    const path = dataPath('load', 'ledger.ndjson');
    writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter((l) => !l.includes('"a2"')).join('\n'));

    expect(await runLoad([], { client: monday.client() })).toBe(1);
    expect(monday.byName('Bolt')).toHaveLength(2);
    const report = await readJson<{ duplicates: { sfId: string; itemIds: string[] }[] }>(dataPath('load', 'report.json'));
    expect(report.duplicates).toEqual([{ board: 'organizations', sfId: 'a2', itemIds: [monday.byName('Bolt')[0]!.id, '999'] }]);
  });

  it('rejects --limit without a positive number instead of silently loading nothing', async () => {
    expect(await runLoad(['--limit'], { client: monday.client() })).toBe(1);
    expect(await runLoad(['--limit', 'abc'], { client: monday.client() })).toBe(1);
    expect(monday.items).toEqual([]);
  });
});

describe('runLoad partial and pending links (#21)', () => {
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
    expect(await runLoad([], { client: monday.client() })).toBe(1);
    const gift = monday.byName('OldGift')[0]!;
    expect(monday.archived).toEqual([]); // would otherwise strand the Bea link behind an archive
    expect(monday.links.at(-1)).toEqual({ itemId: gift.id, targetIds: [Number(monday.byName('Ada')[0]!.id)] });

    expect(await runLoad([], { client: monday.client() })).toBe(0);
    // The partial link was rewritten with the full resolvable set, then the gift archived.
    expect(monday.links.at(-1)).toEqual({ itemId: gift.id,
      targetIds: [Number(monday.byName('Ada')[0]!.id), Number(monday.byName('Bea')[0]!.id)] });
    expect(monday.archived).toEqual([gift.id]);
    const report = await readJson<{ links: { pending: number; skippedByDesign: number } }>(dataPath('load', 'report.json'));
    expect(report.links.pending).toBe(0);
  });

  it('treats targets that were never migrated as skipped by design, not pending', async () => {
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    expect(monday.archived).toHaveLength(1);
    const report = await readJson<{ links: { partial: number; pending: number } }>(dataPath('load', 'report.json'));
    expect(report.links).toMatchObject({ partial: 1, pending: 0 });
  });

  it('does not rewrite a link whose recorded targets already cover everything resolvable', async () => {
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    const writes = monday.links.length;
    expect(await runLoad([], { client: monday.client() })).toBe(0);
    expect(monday.links.length).toBe(writes);
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
