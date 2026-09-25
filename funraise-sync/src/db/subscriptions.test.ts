import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1SubscriptionStore } from './subscriptions';

// The subscriptions ledger (spec 2026-09-18 "Components"): one row per Funraise subscription
// this Worker has written to the Recurring Gifts board, plus a named cursor table for the poll.
describe('D1SubscriptionStore', () => {
  it('returns null for an unknown subscription', async () => {
    const store = new D1SubscriptionStore(env.DB);
    expect(await store.getByFunraiseId('nope')).toBeNull();
  });

  it('records a written subscription and reads it back', async () => {
    const store = new D1SubscriptionStore(env.DB);
    await store.upsert({ funraiseId: '257753', mondayItemId: '9001', donorItemId: '42', status: 'Active', updtime: 1789000000000 });

    expect(await store.getByFunraiseId('257753')).toEqual({
      funraiseId: '257753',
      mondayItemId: '9001',
      donorItemId: '42',
      status: 'Active',
      updtime: 1789000000000,
      writtenAt: expect.any(String),
    });
  });

  it('upsert replaces the row for the same subscription and keeps one row', async () => {
    const store = new D1SubscriptionStore(env.DB);
    await store.upsert({ funraiseId: '1', mondayItemId: '10', donorItemId: null, status: 'Active', updtime: 100 });
    await store.upsert({ funraiseId: '1', mondayItemId: '10', donorItemId: '5', status: 'Cancelled', updtime: 200 });

    const row = await store.getByFunraiseId('1');
    expect(row?.status).toBe('Cancelled');
    expect(row?.donorItemId).toBe('5');
    expect(row?.updtime).toBe(200);
    expect(await store.count()).toBeGreaterThanOrEqual(1);
  });

  it('stores an adopted item with a null updtime so every column is rewritten on first sight', async () => {
    const store = new D1SubscriptionStore(env.DB);
    await store.upsert({ funraiseId: 'adopted', mondayItemId: '77', donorItemId: null, status: 'Active', updtime: null });
    expect((await store.getByFunraiseId('adopted'))?.updtime).toBeNull();
  });

  // #25: the poll and the queue consumer could both create the same Recurring Gift.
  describe('create claims', () => {
    it('lets exactly one token claim a subscription', async () => {
      const store = new D1SubscriptionStore(env.DB);
      expect(await store.claimCreate('c1', 'poll', 600_000)).toBe(true);
      expect(await store.claimCreate('c1', 'consumer', 600_000)).toBe(false);
    });

    it('lets two racing claims produce exactly one winner', async () => {
      const store = new D1SubscriptionStore(env.DB);
      const results = await Promise.all([store.claimCreate('c2', 'a', 600_000), store.claimCreate('c2', 'b', 600_000)]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('lets a stale claim (its writer died) be taken over', async () => {
      const store = new D1SubscriptionStore(env.DB);
      expect(await store.claimCreate('c3', 'dead', 600_000)).toBe(true);
      // ttl -1 s: every existing claim counts as stale
      expect(await store.claimCreate('c3', 'alive', -1000)).toBe(true);
    });

    it('releases only its own claim', async () => {
      const store = new D1SubscriptionStore(env.DB);
      await store.claimCreate('c4', 'mine', 600_000);
      await store.releaseCreate('c4', 'theirs');
      expect(await store.claimCreate('c4', 'other', 600_000)).toBe(false);
      await store.releaseCreate('c4', 'mine');
      expect(await store.claimCreate('c4', 'other', 600_000)).toBe(true);
    });
  });

  describe('poll cursors', () => {
    it('reads 0 for a cursor that was never set', async () => {
      const store = new D1SubscriptionStore(env.DB);
      expect(await store.getCursor('subscriptions')).toBe(0);
    });

    it('stores and advances a named cursor', async () => {
      const store = new D1SubscriptionStore(env.DB);
      await store.setCursor('subscriptions', 1789000000000);
      expect(await store.getCursor('subscriptions')).toBe(1789000000000);
      await store.setCursor('subscriptions', 1789000001000);
      expect(await store.getCursor('subscriptions')).toBe(1789000001000);
    });

    it('keeps cursors independent by name', async () => {
      const store = new D1SubscriptionStore(env.DB);
      await store.setCursor('a', 5);
      expect(await store.getCursor('b')).toBe(0);
    });
  });
});
