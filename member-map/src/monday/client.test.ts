import { describe, expect, it } from 'vitest';
import { HttpMondayClient } from './client';
import type { MapConfig } from '../config';

const COLUMNS: MapConfig['columns'] = {
  address: 'Address', city: 'City', zip: 'Zip', lat: 'Lat', lng: 'Lng',
  membershipStatus: 'Membership Status', doNotSolicit: 'Do Not Solicit',
};

type Cell = Record<string, string>;
interface Raw { id: string; name: string; cells: Cell }

const boardColumns = (titles: [string, string][]) => titles.map(([id, title]) => ({ id, title, type: 'text' }));
const FULL = boardColumns([
  ['addr', 'Address'], ['city', 'City'], ['zip', 'Zip'], ['lat', '🔒 Lat'], ['lng', '🔒 Lng'],
  ['ms', 'Membership Status'], ['dns', 'Do Not Solicit'],
]);
const ORG = FULL.filter((c) => c.id !== 'ms' && c.id !== 'dns');

function rawItem(id: string, cells: Cell): Raw { return { id, name: `Item ${id}`, cells }; }
const wire = (r: Raw, ids: string[]) => ({
  id: r.id, name: r.name,
  column_values: ids.filter((c) => c in r.cells).map((c) => ({ id: c, text: r.cells[c] })),
});

// A fake Monday at the fetch level: board columns, then pages of items keyed by cursor.
function fakeFetch(columns: unknown[], pages: Raw[][]) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const fetchFn = (async (_url: unknown, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    calls.push({ query, variables });
    const ids = (variables.columnIds as string[] | undefined) ?? [];
    const page = (n: number) => ({ cursor: n + 1 < pages.length ? `c${n + 1}` : null, items: (pages[n] ?? []).map((r) => wire(r, ids)) });
    let data: unknown;
    if (query.includes('next_items_page')) data = { next_items_page: page(Number(String(variables.cursor).slice(1))) };
    else if (query.includes('items_page')) data = { boards: [{ items_page: page(0) }] };
    else data = { boards: [{ id: '1', columns }] };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const client = (fetchFn: typeof fetch) => new HttpMondayClient('https://api.test/v2', 'tok', { fetchFn, maxAttempts: 1 });

describe('HttpMondayClient.readBoard', () => {
  it('matches columns through bareTitle (🔒 Lat → Lat)', async () => {
    const { fetchFn, calls } = fakeFetch(FULL, [[rawItem('10', { addr: '1 Main St', city: 'San Jose', zip: '95112', lat: '37.33', lng: '-121.89', ms: 'Active' })]]);
    const [record] = await client(fetchFn).readBoard('peopleLive', 1, COLUMNS);
    expect(record).toMatchObject({ itemId: '10', boardId: 1, board: 'peopleLive', name: 'Item 10', address: '1 Main St', city: 'San Jose', zip: '95112', lat: '37.33', lng: '-121.89', membershipStatus: 'Active', doNotSolicit: false });
    // Only the resolved column ids are requested.
    expect(calls.find((c) => c.query.includes('items_page'))!.variables.columnIds).toEqual(['addr', 'city', 'zip', 'lat', 'lng', 'ms', 'dns']);
  });

  it('pages until the cursor is null', async () => {
    const mk = (a: number) => [rawItem(`${a}`, {}), rawItem(`${a + 1}`, {})];
    const { fetchFn, calls } = fakeFetch(FULL, [mk(1), mk(3), mk(5)]);
    const records = await client(fetchFn).readBoard('peopleHistorical', 1, COLUMNS);
    expect(records.map((r) => r.itemId)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(records.every((r) => r.board === 'peopleHistorical')).toBe(true);
    expect(calls.filter((c) => c.query.includes('next_items_page'))).toHaveLength(2);
  });

  it('reads blank text as null', async () => {
    const { fetchFn } = fakeFetch(FULL, [[rawItem('1', { addr: '', city: 'San Jose' })]]);
    const [record] = await client(fetchFn).readBoard('peopleLive', 1, COLUMNS);
    expect(record!.address).toBeNull();
    expect(record!.zip).toBeNull();
    expect(record!.city).toBe('San Jose');
  });

  it('reads Organizations without Membership Status / Do Not Solicit as null / false', async () => {
    const { fetchFn, calls } = fakeFetch(ORG, [[rawItem('1', { addr: '2 Elm', lat: '1', lng: '2' })]]);
    const [record] = await client(fetchFn).readBoard('organizations', 2, COLUMNS);
    expect(record).toMatchObject({ board: 'organizations', membershipStatus: null, doNotSolicit: false });
    expect(calls.find((c) => c.query.includes('items_page'))!.variables.columnIds).toEqual(['addr', 'city', 'zip', 'lat', 'lng']);
  });

  it('reads a checked Do Not Solicit ("v") as true', async () => {
    const { fetchFn } = fakeFetch(FULL, [[rawItem('1', { dns: 'v' }), rawItem('2', { dns: '' })]]);
    const records = await client(fetchFn).readBoard('peopleLive', 1, COLUMNS);
    expect(records.map((r) => r.doNotSolicit)).toEqual([true, false]);
  });

  it('throws naming the board when Lat is missing', async () => {
    const { fetchFn } = fakeFetch(FULL.filter((c) => c.id !== 'lat'), [[]]);
    await expect(client(fetchFn).readBoard('peopleLive', 77, COLUMNS)).rejects.toThrow(/board 77 has no "Lat" column/);
  });

  it('throws when the board does not exist', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ data: { boards: [] } }), { status: 200 })) as unknown as typeof fetch;
    await expect(client(fetchFn).readBoard('peopleLive', 5, COLUMNS)).rejects.toThrow(/board 5/);
  });
});
