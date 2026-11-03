import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1RollCallCreditsStore, type CreditRow } from './rollCallCredits';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM roll_call_credits').run();
});

const row = (over: Partial<CreditRow>): CreditRow => ({
  giftItemId: 'g1', fiscalYear: 2026, amountCents: 5000, status: 'Received', giftType: 'Individual',
  credit: 'p1', unmatchedMatch: false, archivedAt: null, ...over,
});

describe('D1RollCallCreditsStore', () => {
  it('upsert writes once and is a no-op on an identical second call', async () => {
    const store = new D1RollCallCreditsStore(env.DB);
    const rows = [row({ giftItemId: 'a' }), row({ giftItemId: 'b', credit: null, unmatchedMatch: true })];
    expect(await store.upsert(rows, '2026-11-01T00:00:00Z')).toBe(2);
    expect(await store.upsert(rows, '2026-11-02T00:00:00Z')).toBe(0);
    const stored = await env.DB.prepare(`SELECT updated_at FROM roll_call_credits WHERE gift_item_id = 'a'`).first();
    expect(stored).toEqual({ updated_at: '2026-11-01T00:00:00Z' });
    expect(await store.all()).toEqual(expect.arrayContaining(rows));
  });

  it('upsert rewrites only the rows whose values changed', async () => {
    const store = new D1RollCallCreditsStore(env.DB);
    await store.upsert([row({ giftItemId: 'a' }), row({ giftItemId: 'b' })], 'now');
    expect(await store.upsert([row({ giftItemId: 'a' }), row({ giftItemId: 'b', amountCents: 9000 })], 'later')).toBe(1);
    expect((await store.all()).find((r) => r.giftItemId === 'b')?.amountCents).toBe(9000);
  });

  it('markArchived stamps archived_at', async () => {
    const store = new D1RollCallCreditsStore(env.DB);
    await store.upsert([row({ giftItemId: 'a' }), row({ giftItemId: 'b' })], 'now');
    await store.markArchived(['a'], '2026-11-03T00:00:00Z');
    const rows = await store.all();
    expect(rows.find((r) => r.giftItemId === 'a')?.archivedAt).toBe('2026-11-03T00:00:00Z');
    expect(rows.find((r) => r.giftItemId === 'b')?.archivedAt).toBeNull();
  });

  it('all() returns every fiscal year, including an unreadable one stored as 0', async () => {
    const store = new D1RollCallCreditsStore(env.DB);
    await store.upsert([row({ giftItemId: 'old', fiscalYear: 2025 }), row({ giftItemId: 'new', fiscalYear: 2026 }),
      row({ giftItemId: 'none', fiscalYear: 0 })], 'now');
    expect((await store.all()).map((r) => r.giftItemId)).toEqual(['new', 'none', 'old']);
  });

  it('remove deletes the named rows', async () => {
    const store = new D1RollCallCreditsStore(env.DB);
    await store.upsert([row({ giftItemId: 'a' }), row({ giftItemId: 'b' })], 'now');
    await store.remove(['a']);
    expect((await store.all()).map((r) => r.giftItemId)).toEqual(['b']);
  });
});
