import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { isDeadLetterBatch, runScheduled } from './index';
import type { Env } from './types';
import type { checkMissedOrders } from './missedOrders/check';

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

describe('scheduled (daily missed-order check)', () => {
  afterEach(() => vi.restoreAllMocks());

  const offHour = { scheduledTime: Date.parse('2026-11-01T16:00:00Z'), cron: '0 * * * *' } as unknown as ScheduledController;
  const checkTime = Date.parse('2026-11-02T15:00:00Z');
  const checkController = { scheduledTime: checkTime, cron: '0 * * * *' } as unknown as ScheduledController;
  const withToken = { ...env, EVENTBRITE_PRIVATE_TOKEN: 'eb-token' } as unknown as Env;
  const flags = (get: () => Promise<string | null>) => ({ ...withToken, FLAGS: { get } }) as unknown as Env;
  const quietCheck = () => vi.fn<typeof checkMissedOrders>().mockResolvedValue({ organizationId: '1', checked: 0, missing: [] });
  function context() {
    const waited: Promise<unknown>[] = [];
    return { ctx: { waitUntil: (p: Promise<unknown>) => { waited.push(p); } } as unknown as ExecutionContext, waited };
  }

  it('runs only at the check hour', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const check = quietCheck();
    const { ctx, waited } = context();
    await runScheduled(offHour, withToken, ctx, check);
    await Promise.all(waited);
    expect(check).not.toHaveBeenCalled();

    await runScheduled(checkController, withToken, ctx, check);
    await Promise.all(waited);
    expect(check.mock.calls[0]![0]).toEqual(new Date(checkTime));
    expect(Object.keys(check.mock.calls[0]![1]).sort()).toEqual(['ledger', 'lister', 'organizationId']);
  });

  it('does not read the write switch outside the check hour', async () => {
    const get = vi.fn().mockResolvedValue('on');
    const { ctx } = context();
    await runScheduled(offHour, flags(get), ctx, quietCheck());
    expect(get).not.toHaveBeenCalled();
  });

  it('logs missed orders as an error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const check = vi.fn<typeof checkMissedOrders>().mockResolvedValue({ organizationId: '1', checked: 3, missing: ['55'] });
    const { ctx, waited } = context();
    await runScheduled(checkController, withToken, ctx, check);
    await Promise.all(waited);
    expect(error.mock.calls[0]![0]).toContain('1 of 3 orders');
  });

  it('logs a check that throws and does not reject the waitUntil promise', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const check = vi.fn<typeof checkMissedOrders>().mockRejectedValue(new Error('HTTP 503'));
    const { ctx, waited } = context();
    await runScheduled(checkController, withToken, ctx, check);
    await expect(Promise.all(waited)).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith('eventbrite-sync missed orders: check failed: HTTP 503');
  });

  it('logs an unset EVENTBRITE_PRIVATE_TOKEN and does not run the check', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const check = vi.fn<typeof checkMissedOrders>();
    const { ctx } = context();
    await runScheduled(checkController, { ...withToken, EVENTBRITE_PRIVATE_TOKEN: undefined } as unknown as Env, ctx, check);
    expect(check).not.toHaveBeenCalled();
    expect(error.mock.calls[0]![0]).toContain('EVENTBRITE_PRIVATE_TOKEN is not set');
  });

  // Write switch (spec 2026-10-26): read once per cron run; the check follows runDisposition.
  describe('write switch', () => {
    it.each(['on', 'off'] as const)('%s: runs the check (it only reads and logs, so a dry run is the live run)', async (mode) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const check = quietCheck();
      const { ctx, waited } = context();
      await runScheduled(checkController, flags(async () => mode), ctx, check);
      await Promise.all(waited);
      expect(check).toHaveBeenCalled();
    });

    const kvDown = async (): Promise<string | null> => {
      throw new Error('KV down');
    };
    const holdKey = async (): Promise<string | null> => 'hold';
    it.each([
      ['hold', holdKey],
      ['unknown', kvDown],
    ] as const)('%s: skips the check with one line', async (mode, get) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const check = quietCheck();
      const { ctx, waited } = context();
      await runScheduled(checkController, flags(get), ctx, check);
      await Promise.all(waited);
      expect(waited).toHaveLength(0);
      expect(check).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(`eventbrite-sync scheduled: write mode is "${mode}"; skipping the missed-order check`);
    });
  });
});
