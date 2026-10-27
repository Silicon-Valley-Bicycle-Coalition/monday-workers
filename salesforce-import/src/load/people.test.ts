import { describe, it, expect } from 'vitest';
import { resolvePeopleColumns } from './people.js';
import type { ItemPayload } from '../transform/types.js';

const person = (sfId: string, owner: unknown): ItemPayload =>
  ({ board: 'people-live', sfId, name: sfId, columns: { 'Relationship Owner': owner } });

describe('resolvePeopleColumns', () => {
  it('swaps staff emails for Monday people values and clears the ones with no user', async () => {
    const calls: unknown[] = [];
    const client = { gql: async (_q: string, v?: Record<string, unknown>) => {
      calls.push(v);
      return { users: [{ id: '42', email: 'Cherie@BikeSiliconValley.org' }] } as never;
    } };
    const payloads = [person('a', 'cherie@bikesiliconvalley.org'), person('b', 'gone@bikesiliconvalley.org'),
      person('c', '')];
    const r = await resolvePeopleColumns(payloads, client);
    expect(payloads.map((p) => p.columns['Relationship Owner'])).toEqual([
      { personsAndTeams: [{ id: 42, kind: 'person' }] }, '', '']);
    expect(r).toEqual({ resolved: 1, unmatched: ['gone@bikesiliconvalley.org'] });
    expect(calls).toHaveLength(1);
  });

  it('makes no API call when no payload has a people value', async () => {
    const client = { gql: async () => { throw new Error('unexpected call'); } };
    expect(await resolvePeopleColumns([person('a', '')], client)).toEqual({ resolved: 0, unmatched: [] });
  });
});
