import { describe, it, expect, vi } from 'vitest';
import { dispatchScheduled, POLL_CRON, PURGE_CRON } from './scheduled';
import { pollSubscriptions, SUBSCRIPTIONS_CURSOR } from './subscriptions/poll';
import { pollDepsFor, type BatchSkipContext } from './writeSwitch';
import type { SubscriptionStore } from './db/subscriptions';
import type { FunraiseClient, FunraiseSubscription } from './funraise/client';
import type { MondayClient } from './monday/client';
import type { WriteMode } from './flags';
import { testConfig } from './test/testConfig';

// wrangler.jsonc declares two cron triggers; Cloudflare invokes scheduled() once per matching
// trigger with controller.cron naming it, so each handler runs only for its own schedule.
describe('dispatchScheduled', () => {
  it('runs the subscriptions poll for the hourly trigger', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    const purge = vi.fn().mockResolvedValue(undefined);

    await dispatchScheduled(POLL_CRON, { poll, purge, pollEnabled: true, apiKeyPresent: true, writeMode: 'on' });

    expect(poll).toHaveBeenCalledWith('run');
    expect(purge).not.toHaveBeenCalled();
  });

  it('runs the retention purge for the daily trigger', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    const purge = vi.fn().mockResolvedValue(undefined);

    await dispatchScheduled(PURGE_CRON, { poll, purge, pollEnabled: true, apiKeyPresent: true, writeMode: 'on' });

    expect(purge).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
  });

  it('logs and skips the poll when it is disabled in config or the API key is not set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const poll = vi.fn();
      await dispatchScheduled(POLL_CRON, { poll, purge: vi.fn(), pollEnabled: false, apiKeyPresent: true, writeMode: 'on' });
      await dispatchScheduled(POLL_CRON, { poll, purge: vi.fn(), pollEnabled: true, apiKeyPresent: false, writeMode: 'on' });

      expect(poll).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('disabled'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('FUNRAISE_API_KEY'));
    } finally {
      warn.mockRestore();
    }
  });

  it('logs an unknown trigger and runs nothing, so a wrangler.jsonc edit cannot fire the wrong job', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const poll = vi.fn();
      const purge = vi.fn();
      await dispatchScheduled('*/5 * * * *', { poll, purge, pollEnabled: true, apiKeyPresent: true, writeMode: 'on' });
      expect(poll).not.toHaveBeenCalled();
      expect(purge).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('*/5 * * * *'));
    } finally {
      error.mockRestore();
    }
  });
});

// Write switch (spec 2026-10-26) for the hourly poll. The purge cron is operational (a D1
// retention pass) and runs in every mode.
describe('dispatchScheduled under the write switch', () => {
  const config = testConfig({ donorExternalIdField: 'supporter.id', emailFieldPrecedence: ['supporter.email'], donorNameField: 'supporter.name' });

  const sub = (id: number, updtime: number): FunraiseSubscription => ({
    id, name: `Sub ${id}`, status: 'Active', frequency: 'Monthly', sourceAmount: 10, updtime, supporter: { id: 1, email: 'a@example.com', name: 'A' },
  });

  function fixture(mode: WriteMode) {
    const cursors = new Map<string, number>([[SUBSCRIPTIONS_CURSOR, 100]]);
    const store: SubscriptionStore = {
      getByFunraiseId: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      getCursor: vi.fn(async (name: string) => cursors.get(name) ?? 0),
      setCursor: vi.fn(async (name: string, value: number) => { cursors.set(name, value); }),
      claimCreate: vi.fn().mockResolvedValue(true),
      releaseCreate: vi.fn(),
    };
    const funraise: FunraiseClient = {
      // A short page: two rows after T, so the run catches up and moves T to 300.
      listSubscriptionsUpdatedAfter: vi.fn().mockResolvedValue([sub(1, 200), sub(2, 300)]),
      // Tie walk of T = 100 from id 0 (the missing id cursor): nothing tied.
      listSubscriptionsAtUpdtime: vi.fn().mockResolvedValue([]),
      getSubscription: vi.fn(),
    };
    const monday: MondayClient = {
      findItemByColumnValue: vi.fn().mockResolvedValue(null),
      createItem: vi.fn().mockResolvedValue({ id: '5' }),
      changeColumnValues: vi.fn(),
    };
    const ctx: BatchSkipContext = { worker: 'funraise-sync', environment: 'production', mode, logLevel: 'normal', piiKeys: ['name'] };
    const live = { funraiseClient: funraise, subscriptionStore: store, mondayClient: monday, config };
    const poll = vi.fn(async (disposition: 'run' | 'dry-run') => {
      await pollSubscriptions(pollDepsFor(disposition, live, { ...ctx, deliveryId: 'poll' }));
    });
    return { store, cursors, monday, poll, handlers: { poll, purge: vi.fn(), pollEnabled: true, apiKeyPresent: true, writeMode: mode } };
  }

  async function quietly(fn: (log: ReturnType<typeof vi.spyOn>) => Promise<void>) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fn(log);
      return { log: log.mock.calls.map((c: unknown[]) => String(c[0])), warn: warn.mock.calls.map((c: unknown[]) => String(c[0])) };
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  }

  it.each(['hold', 'unknown'] as const)('%s: skips the poll with one line, leaving the cursor where it was', async (mode) => {
    const f = fixture(mode);

    const { warn } = await quietly(() => dispatchScheduled(POLL_CRON, f.handlers));

    expect(f.poll).not.toHaveBeenCalled();
    expect(f.store.setCursor).not.toHaveBeenCalled();
    expect(f.cursors.get(SUBSCRIPTIONS_CURSOR)).toBe(100);
    expect(warn).toContainEqual(expect.stringContaining(`"${mode}"`));
  });

  it('off: dry-runs the poll with recording sinks — the cursor advances, no ledger row or Monday item is written', async () => {
    const f = fixture('off');

    const { log } = await quietly(() => dispatchScheduled(POLL_CRON, f.handlers));

    expect(f.poll).toHaveBeenCalledWith('dry-run');
    expect(f.cursors.get(SUBSCRIPTIONS_CURSOR)).toBe(300);
    expect(f.store.upsert).not.toHaveBeenCalled();
    expect(f.store.claimCreate).not.toHaveBeenCalled();
    expect(f.store.releaseCreate).not.toHaveBeenCalled();
    expect(f.monday.createItem).not.toHaveBeenCalled();
    const skipped = log.filter((l) => l.includes('"writeSwitch":"skipped"')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(skipped.filter((l) => l.sink === 'Recurring Gifts' && l.operation === 'createItem')).toHaveLength(2);
  });

  it('on: polls and writes as today', async () => {
    const f = fixture('on');

    await quietly(() => dispatchScheduled(POLL_CRON, f.handlers));

    expect(f.poll).toHaveBeenCalledWith('run');
    expect(f.cursors.get(SUBSCRIPTIONS_CURSOR)).toBe(300);
    expect(f.store.upsert).toHaveBeenCalledTimes(2);
    expect(f.monday.createItem).toHaveBeenCalled();
  });

  it.each(['off', 'hold', 'unknown'] as const)('%s: the retention purge still runs', async (mode) => {
    const f = fixture(mode);

    await dispatchScheduled(PURGE_CRON, f.handlers);

    expect(f.handlers.purge).toHaveBeenCalledTimes(1);
  });
});
