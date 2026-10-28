import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { isDeadLetterBatch, runScheduled } from './index';
import type { Env } from './types';
import type { runFollowups } from './followups/run';
import type { checkMissedOrders } from './missedOrders/check';
import { HttpMondayClient } from './monday/client';

describe('isDeadLetterBatch', () => {
  it('recognizes the production and sandbox dead-letter queues', () => {
    expect(isDeadLetterBatch('eventbrite-sync-writes-dlq')).toBe(true);
    expect(isDeadLetterBatch('eventbrite-sync-writes-sandbox-dlq')).toBe(true);
  });

  it('does not treat either write queue as dead letters', () => {
    expect(isDeadLetterBatch('eventbrite-sync-writes')).toBe(false);
    expect(isDeadLetterBatch('eventbrite-sync-writes-sandbox')).toBe(false);
  });
});

describe('scaffold', () => {
  it('applies the orders table migration', async () => {
    const result = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'").first();
    expect(result).not.toBeNull();
  });
});

describe('worker entry point', () => {
  it('exposes fetch, queue and scheduled handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.queue).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });

  it('refuses an unknown ENVIRONMENT value synchronously instead of guessing a config', () => {
    expect(() =>
      worker.fetch(new Request('https://x.example/health'), { ...env, ENVIRONMENT: 'staging' } as unknown as Env, {} as ExecutionContext)
    ).toThrow('ENVIRONMENT');
  });

  it('fails a write batch loudly when EVENTBRITE_PRIVATE_TOKEN is unset, so the gifts dead-letter with the cause', async () => {
    const batch = { queue: 'eventbrite-sync-writes', messages: [] } as unknown as MessageBatch<{ orderId: string; action: string }>;
    await expect(worker.queue(batch, { ...env, EVENTBRITE_PRIVATE_TOKEN: undefined } as unknown as Env)).rejects.toThrow('EVENTBRITE_PRIVATE_TOKEN');
  });
});

describe('scheduled (hourly follow-ups)', () => {
  afterEach(() => vi.restoreAllMocks());

  const scheduledTime = Date.parse('2026-11-01T16:00:00Z');
  const controller = { scheduledTime, cron: '0 * * * *' } as unknown as ScheduledController;
  const withToken = { ...env, MONDAY_API_TOKEN: 'test-token' } as unknown as Env;
  function context() {
    const waited: Promise<unknown>[] = [];
    return { ctx: { waitUntil: (p: Promise<unknown>) => { waited.push(p); } } as unknown as ExecutionContext, waited };
  }

  it('runs the follow-ups for the scheduled time and logs one summary line', async () => {
    const run = vi.fn<typeof runFollowups>().mockResolvedValue({ sent: ['1', '2'], held: ['3'], skipped: [], failed: [] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, waited } = context();
    await runScheduled(controller, withToken, ctx, run);
    await Promise.all(waited);
    expect(run.mock.calls[0]![0]).toEqual(new Date(scheduledTime));
    expect(Object.keys(run.mock.calls[0]![1]).sort()).toEqual(['attendeeStore', 'config', 'eventStore', 'mondayClient']);
    expect(log).toHaveBeenCalledWith('eventbrite-sync follow-ups: sent 2, held 1, skipped 0, failed 0');
  });

  it('logs the failed event ids with console.error so they show in Workers Logs', async () => {
    const run = vi.fn<typeof runFollowups>().mockResolvedValue({ sent: [], held: [], skipped: [], failed: ['9001', '9002'] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, waited } = context();
    await runScheduled(controller, withToken, ctx, run);
    await Promise.all(waited);
    expect(error).toHaveBeenCalledWith('eventbrite-sync follow-ups: sent 0, held 0, skipped 0, failed 2 (9001, 9002)');
  });

  it('logs a sweep that throws and does not reject the waitUntil promise', async () => {
    const run = vi.fn<typeof runFollowups>().mockRejectedValue(new Error('D1 unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, waited } = context();
    await runScheduled(controller, withToken, ctx, run);
    await expect(Promise.all(waited)).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith('eventbrite-sync follow-ups: sweep failed: D1 unavailable');
  });

  it('throws naming MONDAY_API_TOKEN when it is unset, and runs nothing', async () => {
    const { ctx } = context();
    const run = vi.fn<typeof runFollowups>();
    await expect(runScheduled(controller, { ...env, MONDAY_API_TOKEN: undefined } as unknown as Env, ctx, run)).rejects.toThrow('MONDAY_API_TOKEN');
    expect(run).not.toHaveBeenCalled();
    await expect(worker.scheduled(controller, { ...env, MONDAY_API_TOKEN: undefined } as unknown as Env, ctx)).rejects.toThrow('MONDAY_API_TOKEN');
  });

  it('the real handler sweeps an empty ledger without touching Monday', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, waited } = context();
    await worker.scheduled(controller, { ...withToken, ENVIRONMENT: 'sandbox' } as unknown as Env, ctx);
    await Promise.all(waited);
    expect(log).toHaveBeenCalledWith('eventbrite-sync follow-ups: sent 0, held 0, skipped 0, failed 0');
  });

  describe('the daily missed-order check', () => {
    const checkTime = Date.parse('2026-11-02T15:00:00Z');
    const checkController = { scheduledTime: checkTime, cron: '0 * * * *' } as unknown as ScheduledController;
    const withTokens = { ...withToken, EVENTBRITE_PRIVATE_TOKEN: 'eb-token' } as unknown as Env;
    const idle = () => vi.fn<typeof runFollowups>().mockResolvedValue({ sent: [], held: [], skipped: [], failed: [] });

    it('runs only at the check hour', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const check = vi.fn<typeof checkMissedOrders>().mockResolvedValue({ organizationId: '1', checked: 0, missing: [] });
      const { ctx, waited } = context();
      await runScheduled(controller, withTokens, ctx, idle(), check);
      await Promise.all(waited);
      expect(check).not.toHaveBeenCalled();

      await runScheduled(checkController, withTokens, ctx, idle(), check);
      await Promise.all(waited);
      expect(check.mock.calls[0]![0]).toEqual(new Date(checkTime));
      expect(Object.keys(check.mock.calls[0]![1]).sort()).toEqual(['ledger', 'lister', 'organizationId']);
    });

    it('logs missed orders as an error', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const check = vi.fn<typeof checkMissedOrders>().mockResolvedValue({ organizationId: '1', checked: 3, missing: ['55'] });
      const { ctx, waited } = context();
      await runScheduled(checkController, withTokens, ctx, idle(), check);
      await Promise.all(waited);
      expect(error.mock.calls[0]![0]).toContain('1 of 3 orders');
    });

    it('logs a check that throws and does not reject the waitUntil promise', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const check = vi.fn<typeof checkMissedOrders>().mockRejectedValue(new Error('HTTP 503'));
      const { ctx, waited } = context();
      await runScheduled(checkController, withTokens, ctx, idle(), check);
      await expect(Promise.all(waited)).resolves.toBeDefined();
      expect(error).toHaveBeenCalledWith('eventbrite-sync missed orders: check failed: HTTP 503');
    });

    it('logs an unset EVENTBRITE_PRIVATE_TOKEN and still runs the follow-ups', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const run = idle();
      const check = vi.fn<typeof checkMissedOrders>();
      const { ctx, waited } = context();
      await runScheduled(checkController, { ...withToken, EVENTBRITE_PRIVATE_TOKEN: undefined } as unknown as Env, ctx, run, check);
      await Promise.all(waited);
      expect(run).toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
      expect(error.mock.calls[0]![0]).toContain('EVENTBRITE_PRIVATE_TOKEN is not set');
    });
  });

  // Write switch (spec 2026-10-26): read once per cron run; both jobs follow runDisposition.
  describe('write switch', () => {
    const checkController = { scheduledTime: Date.parse('2026-11-02T15:00:00Z'), cron: '0 * * * *' } as unknown as ScheduledController;
    const flags = (get: () => Promise<string | null>) => ({ ...withToken, EVENTBRITE_PRIVATE_TOKEN: 'eb-token', FLAGS: { get } }) as unknown as Env;
    const idle = () => vi.fn<typeof runFollowups>().mockResolvedValue({ sent: [], held: [], skipped: [], failed: [] });
    const quietCheck = () => vi.fn<typeof checkMissedOrders>().mockResolvedValue({ organizationId: '1', checked: 0, missing: [] });

    it('on: runs the follow-ups with the live Monday client, and the check', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const run = idle();
      const check = quietCheck();
      const { ctx, waited } = context();
      await runScheduled(checkController, flags(async () => 'on'), ctx, run, check);
      await Promise.all(waited);
      expect(run.mock.calls[0]![1].mondayClient).toBeInstanceOf(HttpMondayClient);
      expect(check).toHaveBeenCalled();
    });

    it('off: dry-runs the follow-ups (recording Monday client) and still runs the read-only check', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const run = idle();
      const check = quietCheck();
      const { ctx, waited } = context();
      await runScheduled(checkController, flags(async () => 'off'), ctx, run, check);
      await Promise.all(waited);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]![1].mondayClient).not.toBeInstanceOf(HttpMondayClient);
      expect(check).toHaveBeenCalled();
    });

    const kvDown = async (): Promise<string | null> => {
      throw new Error('KV down');
    };
    const holdKey = async (): Promise<string | null> => 'hold';
    it.each([
      ['hold', holdKey],
      ['unknown', kvDown],
    ] as const)('%s: skips both jobs with one line', async (mode, get) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const run = idle();
      const check = quietCheck();
      const { ctx, waited } = context();
      await runScheduled(checkController, flags(get), ctx, run, check);
      await Promise.all(waited);
      expect(waited).toHaveLength(0);
      expect(run).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(`eventbrite-sync scheduled: write mode is "${mode}"; skipping the class follow-ups and the missed-order check`);
    });
  });
});
