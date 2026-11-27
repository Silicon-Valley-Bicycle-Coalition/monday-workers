import { describe, it, expect, vi } from 'vitest';
import { pollSubscriptions, SUBSCRIPTIONS_CURSOR, SUBSCRIPTIONS_ID_CURSOR, NO_TIE } from './poll';
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
    claimCreate: async () => true,
    releaseCreate: async () => {},
  };
}

// A simulated Funraise subscription table that answers the two keyset queries the way the live
// API does: fixed pages of 10, `updtime > T order by updtime asc`, and
// `updtime = T and id > I order by id asc`. Ties in the updtime ordering come back in DESCENDING
// id order — deliberately unhelpful, since Funraise doesn't promise any tie order.
function simulatedFunraise(initial: FunraiseSubscription[], pageSize = 10) {
  const table = new Map<number, FunraiseSubscription>(initial.map((r) => [Number(r.id), r]));
  const calls: string[] = [];
  const client: FunraiseClient = {
    listSubscriptionsUpdatedAfter: vi.fn().mockImplementation(async (after: number) => {
      calls.push(`after ${after}`);
      return [...table.values()]
        .filter((r) => (r.updtime as number) > after)
        .sort((a, b) => (a.updtime as number) - (b.updtime as number) || Number(b.id) - Number(a.id))
        .slice(0, pageSize);
    }),
    listSubscriptionsAtUpdtime: vi.fn().mockImplementation(async (updtime: number, afterId: number) => {
      calls.push(`at ${updtime} id>${afterId}`);
      return [...table.values()]
        .filter((r) => r.updtime === updtime && Number(r.id) > afterId)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, pageSize);
    }),
    getSubscription: vi.fn(), getDonation: vi.fn(),
  };
  return {
    client,
    calls,
    // A staff edit or a payment in Funraise between two poll runs.
    touch: (id: number, updtime: number) => table.set(id, { ...table.get(id)!, updtime, status: 'Cancelled' }),
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

async function pollUntilIdle(deps: Parameters<typeof pollSubscriptions>[0], maxRuns = 50) {
  for (let i = 0; i < maxRuns; i++) {
    const result = await pollSubscriptions(deps);
    if (result.caughtUp) return i + 1;
  }
  throw new Error('poll never went idle');
}

describe('pollSubscriptions (keyset on updtime, id — #25)', () => {
  it('walks every row, advances the cursor to the max updtime seen, and ends idle', async () => {
    const store = memoryStore();
    const rows = Array.from({ length: 12 }, (_, i) => sub(100 + i, 1_000_000_000_000 + i));
    const funraise = simulatedFunraise(rows);
    const deps = { funraiseClient: funraise.client, subscriptionStore: store, mondayClient: fakeMonday(), config };

    const result = await pollSubscriptions(deps);

    expect(result.rows).toBeGreaterThanOrEqual(12);
    expect(result.actions.created).toBe(12);
    expect(store.rows.size).toBe(12);
    expect(result.cursor).toBe(1_000_000_000_011);
    expect(result.tieId).toBeNull();
    expect(result.caughtUp).toBe(true);
    expect(store.cursors.get(SUBSCRIPTIONS_CURSOR)).toBe(1_000_000_000_011);
    // A fresh install has nothing tied at updtime 0, so the first request is the forward query.
    expect(funraise.calls[0]).toBe('after 0');
  });

  it('makes exactly one request when nothing changed, and never re-reads the boundary row', async () => {
    const store = memoryStore();
    store.cursors.set(SUBSCRIPTIONS_CURSOR, 5000);
    store.cursors.set(SUBSCRIPTIONS_ID_CURSOR, NO_TIE);
    const funraise = simulatedFunraise([sub(1, 5000)]);

    const result = await pollSubscriptions({ funraiseClient: funraise.client, subscriptionStore: store, mondayClient: fakeMonday(), config });

    expect(funraise.calls).toEqual(['after 5000']);
    expect(result.rows).toBe(0);
    expect(result.cursor).toBe(5000);
  });

  // The GL#25 bug: offset paging over `updtime >= cursor` let a row updated mid-walk move to the end
  // and shift every later row up one page slot, so the row that slid onto an already-read page was
  // never read — and once the cursor passed its updtime, never would be.
  it('misses no row when rows are updated between one-page runs', async () => {
    const store = memoryStore();
    const base = 1_789_000_000_000;
    const funraise = simulatedFunraise(Array.from({ length: 35 }, (_, i) => sub(i + 1, base + i)));
    const deps = { funraiseClient: funraise.client, subscriptionStore: store, mondayClient: fakeMonday(), config, maxPages: 1 };

    await pollSubscriptions(deps); // reads ids 1–10
    funraise.touch(3, base + 100); // an already-read row moves to the end
    funraise.touch(4, base + 101);
    await pollSubscriptions(deps);
    funraise.touch(15, base + 102); // an already-read row again
    await pollUntilIdle(deps);

    expect(store.rows.size).toBe(35);
    for (const id of [3, 4, 15]) expect(store.rows.get(String(id))!.updtime).toBeGreaterThanOrEqual(base + 100);
  });

  // Seen live 2026-09-18: a bulk import gave hundreds of subscriptions one identical updtime —
  // more than a page. The tie group is walked by id, so it neither loops on its first page nor
  // skips a row when one of the tied rows is edited mid-walk.
  it('walks a tie group larger than a page by id, across one-page runs, even as tied rows are edited', async () => {
    const store = memoryStore();
    const shared = 1_789_500_000_000;
    const rows = [...Array.from({ length: 25 }, (_, i) => sub(500 + i, shared)), sub(900, shared + 1000)];
    const funraise = simulatedFunraise(rows);
    const deps = { funraiseClient: funraise.client, subscriptionStore: store, mondayClient: fakeMonday(), config, maxPages: 1 };

    await pollSubscriptions(deps); // advance: first 10 of the tie group (in unhelpful order)
    funraise.touch(505, shared + 2000); // a tied row leaves the group mid-walk
    await pollUntilIdle(deps);

    expect(store.rows.size).toBe(26);
    expect(store.rows.get('505')!.updtime).toBe(shared + 2000);
    expect(store.cursors.get(SUBSCRIPTIONS_CURSOR)).toBe(shared + 2000);
    expect(funraise.calls).toContain(`at ${shared} id>0`);
  });

  it('leaves both cursors where they were when a write fails mid-page, so the page is re-read next run', async () => {
    const store = memoryStore();
    store.cursors.set(SUBSCRIPTIONS_CURSOR, 100);
    store.cursors.set(SUBSCRIPTIONS_ID_CURSOR, NO_TIE);
    const funraise = simulatedFunraise([sub(1, 1000), sub(2, 2000), sub(3, 3000)]);
    const monday = fakeMonday();
    (monday.createItem as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'item-1' })
      .mockRejectedValueOnce(new Error('monday 500'));

    await expect(
      pollSubscriptions({ funraiseClient: funraise.client, subscriptionStore: store, mondayClient: monday, config })
    ).rejects.toThrow(/monday 500/);

    expect(store.cursors.get(SUBSCRIPTIONS_CURSOR)).toBe(100);
    expect(store.cursors.get(SUBSCRIPTIONS_ID_CURSOR)).toBe(NO_TIE);
    expect(store.rows.has('1')).toBe(true);
    expect(store.rows.has('2')).toBe(false);
  });

  it('caps the number of requests per run so a runaway API can never loop forever', async () => {
    const store = memoryStore();
    const funraise = simulatedFunraise(Array.from({ length: 50 }, (_, i) => sub(i + 1, 1_789_000_000_000 + i)));

    await pollSubscriptions({ funraiseClient: funraise.client, subscriptionStore: store, mondayClient: fakeMonday(), config, maxPages: 3 });

    expect(funraise.calls.length).toBe(3);
  });

  it('upgrades from the offset-paged cursors by re-reading the tie group at the stored cursor', async () => {
    // Pre-#25 state: `subscriptions` holds the >= cursor; `subscriptions:id` doesn't exist yet.
    const store = memoryStore();
    store.cursors.set(SUBSCRIPTIONS_CURSOR, 1789733255690);
    const funraise = simulatedFunraise([sub(1, 1789733255690), sub(2, 1789733255691)]);

    await pollSubscriptions({ funraiseClient: funraise.client, subscriptionStore: store, mondayClient: fakeMonday(), config });

    expect(funraise.calls[0]).toBe('at 1789733255690 id>0');
    expect(funraise.calls[1]).toBe('after 1789733255690');
    expect(store.rows.size).toBe(2);
  });

  it('refuses to guess when a full tie page carries no numeric id', async () => {
    const store = memoryStore();
    store.cursors.set(SUBSCRIPTIONS_CURSOR, 7000);
    const client: FunraiseClient = {
      listSubscriptionsUpdatedAfter: vi.fn(),
      listSubscriptionsAtUpdtime: vi.fn().mockResolvedValue(Array.from({ length: 10 }, () => ({ ...sub(1, 7000), id: 'x' }))),
      getSubscription: vi.fn(), getDonation: vi.fn(),
    };

    await expect(pollSubscriptions({ funraiseClient: client, subscriptionStore: store, mondayClient: fakeMonday(), config })).rejects.toThrow(/numeric id/);
  });
});
