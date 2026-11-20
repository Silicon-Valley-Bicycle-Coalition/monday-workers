import { describe, expect, it } from 'vitest';
import { HttpMondayClient } from './client';

function fakeMonday(responses: unknown[]) {
  const bodies: { query: string; variables: Record<string, unknown> }[] = [];
  const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected request');
    return new Response(JSON.stringify({ data: next }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { client: new HttpMondayClient('token', { fetchFn, maxAttempts: 1 }), bodies };
}

const item = (id: string, text: string | null) => ({ id, column_values: [{ id: 'phone_x', text }] });

describe('HttpMondayClient.listPeoplePhones', () => {
  it('pages through the board and keeps only the phone column text', async () => {
    const { client, bodies } = fakeMonday([
      { boards: [{ items_page: { cursor: 'c1', items: [item('1', '(408) 555-0101'), item('2', '')] } }] },
      { next_items_page: { cursor: null, items: [item('3', null), item('4', '  ')] } },
    ]);
    expect(await client.listPeoplePhones(42, 'phone_x')).toEqual([
      { itemId: '1', phone: '(408) 555-0101' },
      { itemId: '2', phone: null },
      { itemId: '3', phone: null },
      { itemId: '4', phone: null },
    ]);
    expect(bodies[0]!.variables).toEqual({ boardId: ['42'], columnIds: ['phone_x'] });
    expect(bodies[1]!.variables).toEqual({ cursor: 'c1', columnIds: ['phone_x'] });
  });

  it('throws when the board is missing rather than returning an empty list', async () => {
    const { client } = fakeMonday([{ boards: [] }]);
    await expect(client.listPeoplePhones(42, 'phone_x')).rejects.toThrow(/not found/);
  });
});
