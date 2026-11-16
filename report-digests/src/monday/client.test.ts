import { describe, expect, it } from 'vitest';
import { HttpMondayClient, MAX_ITEMS } from './client';

interface Call { query: string; variables: Record<string, unknown> }
type Handler = (call: Call) => unknown;

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetchFn = (async (_url: unknown, init: { body: string }) => {
    const call = JSON.parse(init.body) as Call;
    calls.push(call);
    return new Response(JSON.stringify({ data: handler(call) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const client = (fetchFn: typeof fetch) => new HttpMondayClient('https://api.test/v2', 'tok', { fetchFn, maxAttempts: 1 });

// `pages` pages of `size` items each, keyed by cursor c1, c2, …
function pagedBoard(pages: number, size: number): Handler {
  const page = (n: number) => ({
    cursor: n + 1 < pages ? `c${n + 1}` : null,
    items: Array.from({ length: size }, (_, i) => ({ id: `${n}-${i}`, name: 'g', column_values: [{ id: 'amount', text: '1' }] })),
  });
  return ({ query, variables }) => query.includes('next_items_page')
    ? { next_items_page: page(Number(String(variables.cursor).slice(1))) }
    : { boards: [{ items_page: page(0) }] };
}

describe('HttpMondayClient.itemPages', () => {
  it('walks every cursor page past MAX_ITEMS without collecting them', async () => {
    const pages = Math.ceil(MAX_ITEMS / 500) + 2;
    const { fetchFn, calls } = fakeFetch(pagedBoard(pages, 500));
    let count = 0;
    for await (const page of client(fetchFn).itemPages(1, [], ['amount'])) count += page.length;
    expect(count).toBe(pages * 500);
    expect(count).toBeGreaterThan(MAX_ITEMS);
    expect(calls).toHaveLength(pages);
    expect(calls.every((c) => JSON.stringify(c.variables.columnIds) === '["amount"]')).toBe(true);
  });
});

describe('HttpMondayClient.queryItems', () => {
  it('still refuses a filter that matched more than MAX_ITEMS', async () => {
    const { fetchFn } = fakeFetch(pagedBoard(Math.ceil(MAX_ITEMS / 500) + 1, 500));
    await expect(client(fetchFn).queryItems(1, [], ['amount'])).rejects.toThrow(`more than ${MAX_ITEMS}`);
  });
});

describe('HttpMondayClient.getBoard', () => {
  it('reads each board once per client', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ boards: [{ id: '1', name: 'Donations', columns: [], views: [] }] }));
    const c = client(fetchFn);
    await Promise.all([c.getBoard(1), c.getBoard(1)]);
    await c.getBoard(1);
    expect(calls).toHaveLength(1);
  });
  it('does not keep a failed read', async () => {
    let n = 0;
    const { fetchFn, calls } = fakeFetch(() => {
      n += 1;
      if (n === 1) throw new Error('blip');
      return { boards: [{ id: '1', name: 'Donations', columns: [], views: [] }] };
    });
    const c = client(fetchFn);
    await expect(c.getBoard(1)).rejects.toThrow();
    expect((await c.getBoard(1))?.name).toBe('Donations');
    expect(calls).toHaveLength(2);
  });
});

describe('HttpMondayClient.getItemsByTitle', () => {
  it('requests only the named columns, by each donor board’s own ids', async () => {
    const boards: Record<string, { id: string; title: string }[]> = {
      '10': [{ id: 'lg', title: '🔒 Lifetime Giving' }, { id: 'lvl', title: 'Donor Level' }, { id: 'nw', title: 'Net Worth' }, { id: 'ledger', title: 'Gift Ledger' }],
      '20': [{ id: 'lg2', title: 'Lifetime Giving' }, { id: 'addr', title: 'Address' }],
    };
    const values: Record<string, Record<string, string>> = { p1: { lg: '2500', lvl: 'Major', nw: '9', ledger: '{}' }, o1: { lg2: '40', addr: 'x' } };
    const boardOf: Record<string, string> = { p1: '10', o1: '20' };
    const { fetchFn, calls } = fakeFetch(({ query, variables }) => {
      const ids = (variables.ids as string[] | undefined) ?? [];
      if (query.includes('column_values')) {
        const want = variables.columnIds as string[];
        return { items: ids.map((id) => ({ id, column_values: Object.entries(values[id]!).filter(([c]) => want.includes(c)).map(([c, text]) => ({ id: c, text })) })) };
      }
      if (query.includes('columns')) return { boards: (variables.boardIds as string[]).map((id) => ({ id, columns: boards[id] })) };
      return { items: ids.map((id) => ({ id, name: `N ${id}`, board: { id: boardOf[id] } })) };
    });
    const out = await client(fetchFn).getItemsByTitle(['p1', 'o1'], ['Lifetime Giving', 'Donor Level']);
    const valuesCall = calls.find((c) => c.query.includes('column_values'))!;
    expect([...(valuesCall.variables.columnIds as string[])].sort()).toEqual(['lg', 'lg2', 'lvl']);
    expect(out.map((d) => [d.id, d.name, d.boardId, Object.fromEntries(d.byTitle)])).toEqual([
      ['p1', 'N p1', '10', { 'Lifetime Giving': '2500', 'Donor Level': 'Major' }],
      ['o1', 'N o1', '20', { 'Lifetime Giving': '40', 'Donor Level': null }],
    ]);
  });
  it('makes no call for no ids', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({}));
    expect(await client(fetchFn).getItemsByTitle([], ['Lifetime Giving'])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
