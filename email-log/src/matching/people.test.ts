import { describe, it, expect } from 'vitest';
import { matchAddresses } from './people';
import type { MondayClient } from '../monday/client';
import { testConfig } from '../test/testConfig';

// Fake keyed by "boardId|columnId|value" -> ids; connections keyed by "itemId|columnId".
function fakeClient(finds: Record<string, string[]>, connections: Record<string, string[]> = {}) {
  const calls: string[] = [];
  const client: MondayClient = {
    async findItemIdsByColumnValue(boardId, columnId, value) {
      const key = `${boardId}|${columnId}|${value}`;
      calls.push(key);
      return finds[key] ?? [];
    },
    async getConnectedItemIds(itemId, columnId) {
      return connections[`${itemId}|${columnId}`] ?? [];
    },
    async findUserIdByEmail() {
      return null;
    },
    async boardItemsCount() {
      return 0;
    },
    async createItem() {
      return '1';
    },
  };
  return { client, calls };
}

const config = testConfig();

describe('matchAddresses', () => {
  it('matches on People', async () => {
    const { client } = fakeClient({ '42|personal_email_col|a@x.com': ['p1'] });
    expect(await matchAddresses(['a@x.com'], client, config)).toEqual({ personItemIds: ['p1'], unmatched: [] });
  });

  it('matches on People (Historical)', async () => {
    const { client } = fakeClient({ '43|hist_personal_email_col|a@x.com': ['h1'] });
    expect(await matchAddresses(['a@x.com'], client, config)).toEqual({ personItemIds: ['h1'], unmatched: [] });
  });

  it('a household address links two people', async () => {
    const { client } = fakeClient({ '42|household_email_col|home@x.com': ['p1', 'p2'] });
    expect((await matchAddresses(['home@x.com'], client, config)).personItemIds).toEqual(['p1', 'p2']);
  });

  it("matches a Work Email through its Affiliation's Person", async () => {
    const { client } = fakeClient({ '44|work_email_col|w@corp.com': ['aff1'] }, { 'aff1|aff_person_col': ['p9'] });
    expect(await matchAddresses(['w@corp.com'], client, config)).toEqual({ personItemIds: ['p9'], unmatched: [] });
  });

  it('skips Affiliations when its board is null', async () => {
    const { client, calls } = fakeClient({ '44|work_email_col|w@corp.com': ['aff1'] }, { 'aff1|aff_person_col': ['p9'] });
    const cfg = testConfig({ monday: { boards: { affiliations: null } } });
    expect(await matchAddresses(['w@corp.com'], client, cfg)).toEqual({ personItemIds: [], unmatched: ['w@corp.com'] });
    expect(calls.some((c) => c.startsWith('44|'))).toBe(false);
  });

  it('skips Affiliations when its columns are null', async () => {
    const { client, calls } = fakeClient({});
    const cfg = testConfig({ matching: { affiliationsWorkEmailColumn: null, affiliationsPersonColumn: null } });
    await matchAddresses(['w@corp.com'], client, cfg);
    expect(calls.some((c) => c.startsWith('44|'))).toBe(false);
  });

  it('skips a board whose id is null', async () => {
    const { client, calls } = fakeClient({});
    const cfg = testConfig({ monday: { boards: { 'people-historical': null } } });
    await matchAddresses(['a@x.com'], client, cfg);
    expect(calls.some((c) => c.startsWith('43|'))).toBe(false);
  });

  it('dedupes person ids in first-seen order', async () => {
    const { client } = fakeClient({
      '42|personal_email_col|a@x.com': ['p1'],
      '42|household_email_col|a@x.com': ['p2', 'p1'],
      '43|hist_personal_email_col|a@x.com': ['p1'],
      '42|personal_email_col|b@x.com': ['p2'],
    });
    expect((await matchAddresses(['a@x.com', 'b@x.com'], client, config)).personItemIds).toEqual(['p1', 'p2']);
  });

  it('an address matching nothing is unmatched', async () => {
    const { client } = fakeClient({ '42|personal_email_col|a@x.com': ['p1'] });
    expect(await matchAddresses(['a@x.com', 'nobody@x.com'], client, config)).toEqual({
      personItemIds: ['p1'],
      unmatched: ['nobody@x.com'],
    });
  });

  it('propagates a Monday error', async () => {
    const { client } = fakeClient({});
    client.findItemIdsByColumnValue = async () => {
      throw new Error('monday down');
    };
    await expect(matchAddresses(['a@x.com'], client, config)).rejects.toThrow('monday down');
  });
});
