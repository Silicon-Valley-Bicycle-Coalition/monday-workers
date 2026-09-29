import { describe, it, expect } from 'vitest';
import { GraphqlMondayReader, sfIdOf, type ReadItem } from './monday.js';
import { MondayClient } from '../load/monday.js';

type Handler = (query: string, variables: Record<string, unknown>) => unknown;
function reader(handler: Handler, concurrency = 2) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const fetchFn = (async (_u: unknown, init: unknown) => {
    const { query, variables } = JSON.parse((init as { body: string }).body);
    calls.push({ query, variables });
    return Response.json({ data: handler(query, variables) });
  }) as typeof fetch;
  const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
  return { r: new GraphqlMondayReader(client, { concurrency }), calls };
}

const raw = (id: string, sfId: string, state = 'active') =>
  ({ id, state, board: { id: '7' }, column_values: [{ id: 'dbg', text: `SF ID: ${sfId}` }, { id: 'amt', text: '5' }] });

describe('GraphqlMondayReader', () => {
  it('maps column titles to ids', async () => {
    const { r } = reader(() => ({ boards: [{ columns: [{ id: 'amt', title: 'Amount' }] }] }));
    expect(await r.columns(7)).toEqual(new Map([['Amount', 'amt']]));
  });

  it('throws when the board is not visible', async () => {
    const { r } = reader(() => ({ boards: [] }));
    await expect(r.columns(7)).rejects.toThrow('board 7 not found');
  });

  it('scans every page and keys values by title', async () => {
    const { r, calls } = reader((q) => q.includes('next_items_page')
      ? { next_items_page: { cursor: null, items: [raw('2', 'b')] } }
      : { boards: [{ items_page: { cursor: 'c1', items: [raw('1', 'a')] } }] });
    const items = await r.scan(7, { 'Salesforce Debug': 'dbg', Amount: 'amt' });
    expect(items).toEqual([
      { id: '1', state: 'active', boardId: '7', values: { 'Salesforce Debug': 'SF ID: a', Amount: '5' } },
      { id: '2', state: 'active', boardId: '7', values: { 'Salesforce Debug': 'SF ID: b', Amount: '5' } },
    ]);
    expect(calls[0]!.variables['cols']).toEqual(['dbg', 'amt']);
    expect(calls[1]!.variables['cursor']).toBe('c1');
  });

  it('reads items by id in chunks of 100, including archived ones', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(i));
    const { r, calls } = reader((q, v) => ({ items: (v['ids'] as string[]).map((id) => raw(id, `s${id}`, 'archived')) }));
    const items = await r.byIds(ids, { 'Salesforce Debug': 'dbg' });
    expect(calls.map((c) => (c.variables['ids'] as string[]).length)).toEqual([100, 100, 50]);
    expect(calls[0]!.query).toContain('exclude_nonactive: false');
    expect(items).toHaveLength(250);
    expect(items[0]).toMatchObject({ state: 'archived', values: { 'Salesforce Debug': 'SF ID: s0' } });
  });
});

describe('sfIdOf', () => {
  const item = (values: Record<string, string>): ReadItem => ({ id: '1', state: 'active', boardId: '1', values });
  it('reads the Salesforce ID column first, then the Salesforce Debug prefix', () => {
    expect(sfIdOf(item({ 'Salesforce ID': ' 006A ', 'Salesforce Debug': 'SF ID: 006B' }))).toBe('006A');
    expect(sfIdOf(item({ 'Salesforce ID': '', 'Salesforce Debug': 'SF ID: 006B | Created: 2020-01-01' }))).toBe('006B');
    expect(sfIdOf(item({ 'Salesforce Debug': 'Created: 2020-01-01' }))).toBeNull();
    expect(sfIdOf(item({}))).toBeNull();
  });
});
