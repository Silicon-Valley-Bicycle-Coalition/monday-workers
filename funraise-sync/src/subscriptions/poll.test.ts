import { describe, it, expect, vi } from 'vitest';
import { pollSubscriptions, SUBSCRIPTIONS_CURSOR, SUBSCRIPTIONS_PAGE_CURSOR } from './poll';
import type { FunraiseClient, FunraiseSubscription } from '../funraise/client';
import type { SubscriptionStore } from '../db/subscriptions';
import type { MondayClient } from '../monday/client';
import { testConfig } from '../test/testConfig';

const config = testConfig({ donorExternalIdField: 'supporter.id', emailFieldPrecedence: ['supporter.email'], donorNameField: 'supporter.name' });

function sub(id: number, updtime: number): FunraiseSubscription {
  return { id, name: `Sub ${id}`, status: 'Active', frequency: 'Monthly', sourceAmount: 10, updtime, supporter: { id: 1, email: 'a@example.com', name: 'A' } };
}

// An in-memory ledger so the cursor and per-row updtime semantics are exercised for real.
function memoryStore(): SubscriptionStore & { rows: Map<string, { mondayItemId: string; updtime: number | null }>; cursors: Map<string, number> } {
  const rows = new Map<string, { mondayItemId: string; updtime: number | null }>();
  const cursors = new Map<string, number>();
  return {
    rows,
    cursors,
    getByFunraiseId: async (id) => {
      const r = rows.get(id);
      return r ? { funraiseId: id, mondayItemId: r.mondayItemId, donorItemId: null, status: 'Active', updtime: r.updtime, writtenAt: 'x' } : null;
    },
    upsert: async (row) => {
      rows.set(row.funraiseId, { mondayItemId: row.mondayItemId, updtime: row.updtime });
    },
    count: async () => rows.size,
    getCursor: async (name) => cursors.get(name) ?? 0,
    setCursor: async (name, value) => {
      cursors.set(name, value);
    },
  };
}

// Pages are keyed by the cursor the client was asked for, then by page index.
function fakeFunraise(pages: Record<number, FunraiseSubscription[][]>): FunraiseClient & { calls: [number, number][] } {
  const calls: [number, number][] = [];
  return {
    calls,
    listSubscriptionsUpdatedSince: vi.fn().mockImplementation(async (cursor: number, page: number) => {
      calls.push([cursor, page]);
      return pages[cursor]?.[page] ?? [];
    }),
    getSubscription: vi.fn(),
  };
}

// The donor lookup on the People board (42) always matches, so createItem is only ever the
// Recurring Gifts item; the adopt lookup on the Recurring Gifts board (222) never matches.
function fakeMonday(): MondayClient {
  let n = 0;
  return {
    findItemByColumnValue: vi.fn().mockImplementation(async (boardId: number) => (boardId === 42 ? { id: '9001' } : null)),
    createItem: vi.fn().mockImplementation(async () => ({ id: `item-${++n}` })),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
  };
}

describe('pollSubscriptions', () => {
  it('walks every page from the cursor, writes each row, and advances the cursor to the max updtime seen', async () => {
    const store = memoryStore();
    const page0 = Array.from({ length: 10 }, (_, i) => sub(100 + i, 1000 + i));
    const page1 = [sub(200, 2000), sub(201, 2500)];
    const funraise = fakeFunraise({ 0: [page0, page1] });

    const result = await pollSubscriptions({ funraiseClient: funraise, subscriptionStore: store, mondayClient: fakeMonday(), config, pageSize: 10 });

    expect(funraise.calls).toEqual([[0, 0], [0, 1]]);
    expect(result).toEqual({ pages: 2, rows: 12, actions: { created: 12, adopted: 0, updated: 0, noop: 0 }, cursor: 2500, nextPage: 0 });
    expect(store.cursors.get(SUBSCRIPTIONS_CURSOR)).toBe(2500);
    expect(store.rows.size).toBe(12);
  });

  it('stops after a short page and makes one request when nothing changed', async () => {
    const store = memoryStore();
    store.cursors.set(SUBSCRIPTIONS_CURSOR, 5000);
    const funraise = fakeFunraise({ 5000: [[]] });

    const result = await pollSubscriptions({ funraiseClient: funraise, subscriptionStore: store, mondayClient: fakeMonday(), config, pageSize: 10 });

    expect(funraise.calls).toEqual([[5000, 0]]);
    expect(result.rows).toBe(0);
    expect(result.cursor).toBe(5000);
  });

  it('re-reads the boundary row with >= on the next run and treats it as a no-op', async () => {
    const store = memoryStore();
    const funraise = fakeFunraise({ 0: [[sub(1, 1000), sub(2, 2000)]], 2000: [[sub(2, 2000), sub(3, 3000)]] });
    const monday = fakeMonday();

    await pollSubscriptions({ funraiseClient: funraise, subscriptionStore: store, mondayClient: monday, config, pageSize: 10 });
    const second = await pollSubscriptions({ funraiseClient: funraise, subscriptionStore: store, mondayClient: monday, config, pageSize: 10 });

    expect(second.actions).toEqual({ created: 1, adopted: 0, updated: 0, noop: 1 });
    expect(second.cursor).toBe(3000);
    expect(monday.createItem).toHaveBeenCalledTimes(3);
  });

  it('leaves the cursor where it was when a write fails mid-page, so the page is re-read next run', async () => {
    const store = memoryStore();
    store.cursors.set(SUBSCRIPTIONS_CURSOR, 100);
    const funraise = fakeFunraise({ 100: [[sub(1, 1000), sub(2, 2000), sub(3, 3000)]] });
    const monday = fakeMonday();
    (monday.createItem as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'item-1' })
      .mockRejectedValueOnce(new Error('monday 500'));

    await expect(
      pollSubscriptions({ funraiseClient: funraise, subscriptionStore: store, mondayClient: monday, config, pageSize: 10 })
    ).rejects.toThrow(/monday 500/);

    expect(store.cursors.get(SUBSCRIPTIONS_CURSOR)).toBe(100);
    // The row that did land is in the ledger, so the re-read skips it.
    expect(store.rows.has('1')).toBe(true);
    expect(store.rows.has('2')).toBe(false);
  });

  it('never moves the cursor backwards and ignores rows without an updtime when computing it', async () => {
    const store = memoryStore();
    store.cursors.set(SUBSCRIPTIONS_CURSOR, 9000);
    const funraise = fakeFunraise({ 9000: [[{ ...sub(1, 9000), updtime: null }, sub(2, 8000)]] });

    const result = await pollSubscriptions({ funraiseClient: funraise, subscriptionStore: store, mondayClient: fakeMonday(), config, pageSize: 10 });

    expect(result.cursor).toBe(9000);
    expect(store.cursors.get(SUBSCRIPTIONS_CURSOR)).toBe(9000);
  });

  it('caps the number of pages per run so a runaway API can never loop forever', async () => {
    const store = memoryStore();
    const endless: FunraiseSubscription[][] = Array.from({ length: 5 }, (_, p) => Array.from({ length: 10 }, (_, i) => sub(p * 10 + i, p * 10 + i + 1)));
    const funraise = fakeFunraise({ 0: endless });

    const result = await pollSubscriptions({ funraiseClient: funraise, subscriptionStore: store, mondayClient: fakeMonday(), config, pageSize: 10, maxPages: 3 });

    expect(result.pages).toBe(3);
    expect(funraise.calls.length).toBe(3);
  });

  // Seen live 2026-09-18: a bulk import gave hundreds of subscriptions the identical updtime.
  // With one page per run the cursor can't move past them by timestamp alone, so the page index
  // is persisted while the cursor stands still and reset once it advances.
  describe('page cursor across runs (maxPages 1 against rows sharing one updtime)', () => {
    const shared = Array.from({ length: 25 }, (_, i) => sub(500 + i, 5000));
    const pagesAtZero = [shared.slice(0, 10), shared.slice(10, 20), [...shared.slice(20), sub(900, 6000)]];

    it('continues from the next page on the following run instead of re-reading the same ten rows', async () => {
      const store = memoryStore();
      const funraise = fakeFunraise({ 0: pagesAtZero });
      const monday = fakeMonday();
      const deps = { funraiseClient: funraise, subscriptionStore: store, mondayClient: monday, config, pageSize: 10, maxPages: 1 };

      const first = await pollSubscriptions(deps);
      const second = await pollSubscriptions(deps);
      const third = await pollSubscriptions(deps);

      expect(funraise.calls).toEqual([[0, 0], [0, 1], [0, 2]]);
      expect(first.actions.created + second.actions.created + third.actions.created).toBe(26);
      expect(store.cursors.get(SUBSCRIPTIONS_CURSOR)).toBe(6000);
      expect(store.cursors.get(SUBSCRIPTIONS_PAGE_CURSOR)).toBe(0);
    });

    it('resets the page index to 0 once the cursor advances, so the new query starts from its first page', async () => {
      const store = memoryStore();
      store.cursors.set(SUBSCRIPTIONS_PAGE_CURSOR, 1);
      const funraise = fakeFunraise({ 0: pagesAtZero, 6000: [[sub(900, 6000), sub(901, 7000)]] });
      const deps = { funraiseClient: funraise, subscriptionStore: store, mondayClient: fakeMonday(), config, pageSize: 10, maxPages: 1 };

      await pollSubscriptions(deps); // page 1 at cursor 0: ten shared rows, cursor stays
      await pollSubscriptions(deps); // page 2: short page carrying updtime 6000 → cursor 6000, page reset
      const next = await pollSubscriptions(deps); // new query from 6000, page 0

      expect(funraise.calls).toEqual([[0, 1], [0, 2], [6000, 0]]);
      expect(next.cursor).toBe(7000);
      expect(store.cursors.get(SUBSCRIPTIONS_PAGE_CURSOR)).toBe(0);
    });

    it('reports the page it will resume from', async () => {
      const store = memoryStore();
      const funraise = fakeFunraise({ 0: pagesAtZero });
      const result = await pollSubscriptions({ funraiseClient: funraise, subscriptionStore: store, mondayClient: fakeMonday(), config, pageSize: 10, maxPages: 1 });
      expect(result.nextPage).toBe(1);
    });
  });
});
