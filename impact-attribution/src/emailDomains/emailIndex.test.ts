import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../test/reset';
import type { AffiliationRecord } from './domains';
import { emailIndexRows, rebuildEmailIndex } from './emailIndex';
import type { PersonRecord } from './select';

const person = (itemId: string, over: Partial<PersonRecord> = {}): PersonRecord => ({
  itemId, boardId: '100', name: 'X', personalEmail: null, householdEmail: null, employerName: null, lastGiftDate: null, ...over,
});
const aff = (over: Partial<AffiliationRecord>): AffiliationRecord => ({
  itemId: 'a1', personIds: ['1'], organizationIds: ['o1'], status: 'Current', workEmail: null, ...over,
});

async function indexRows(): Promise<{ address: string; kind: string; person_item_ids: string; affiliation_item_id: string | null }[]> {
  return (await env.DB.prepare('SELECT * FROM email_index ORDER BY address').all<any>()).results;
}

beforeEach(resetDb);

describe('emailIndexRows', () => {
  it('lists every person on a shared household address in one row', () => {
    const rows = emailIndexRows([person('1', { householdEmail: 'fam@x.example' }), person('2', { householdEmail: 'fam@x.example' })], []);
    expect(rows).toEqual([{ address: 'fam@x.example', kind: 'household', personItemIds: ['1', '2'], affiliationItemId: null }]);
  });

  it('personal beats household for the same address', () => {
    const rows = emailIndexRows([person('1', { personalEmail: 'a@x.example' }), person('2', { householdEmail: 'a@x.example' })], []);
    expect(rows).toEqual([{ address: 'a@x.example', kind: 'personal', personItemIds: ['1', '2'], affiliationItemId: null }]);
  });

  it('indexes a Work Email to its affiliation, winning over personal', () => {
    const rows = emailIndexRows([person('1', { personalEmail: 'jo@acme.example' })], [aff({ itemId: 'a9', personIds: ['1'], workEmail: 'jo@acme.example' })]);
    expect(rows).toEqual([{ address: 'jo@acme.example', kind: 'work', personItemIds: ['1'], affiliationItemId: 'a9' }]);
  });
});

describe('rebuildEmailIndex', () => {
  it('replaces the whole index', async () => {
    await rebuildEmailIndex(env.DB, [{ address: 'old@x.example', kind: 'personal', personItemIds: ['1'], affiliationItemId: null }]);
    await rebuildEmailIndex(env.DB, [{ address: 'new@x.example', kind: 'work', personItemIds: ['2'], affiliationItemId: 'a2' }]);
    expect(await indexRows()).toEqual([{ address: 'new@x.example', kind: 'work', person_item_ids: '["2"]', affiliation_item_id: 'a2' }]);
  });

  it('writes 1,000 rows', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ address: `p${i}@x.example`, kind: 'personal' as const, personItemIds: [String(i)], affiliationItemId: null }));
    await rebuildEmailIndex(env.DB, rows);
    expect((await indexRows()).length).toBe(1000);
  });

  it('stays well inside D1\'s per-invocation query limit for 30,000 addresses', async () => {
    const rows = Array.from({ length: 30000 }, (_, i) => ({ address: `p${i}@x.example`, kind: 'personal' as const, personItemIds: [String(i)], affiliationItemId: null }));
    const batch = vi.spyOn(env.DB, 'batch');
    try {
      await rebuildEmailIndex(env.DB, rows);
      const statements = batch.mock.calls.reduce((n, [s]) => n + s.length, 0);
      expect(statements).toBeLessThanOrEqual(50);
    } finally {
      batch.mockRestore();
    }
    expect((await indexRows()).length).toBe(30000);
  });
});

