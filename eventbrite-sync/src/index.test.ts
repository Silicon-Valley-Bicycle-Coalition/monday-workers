import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { isDeadLetterBatch, runScheduled } from './index';
import type { Env } from './types';
import type { checkMissedOrders } from './missedOrders/check';
import type { sweepEndedEvents } from './endedEvents/sweep';

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

describe('class email routes', () => {
  const ctx = {} as ExecutionContext;
  const withSecret = { ...env, CLASS_EMAIL_SECRET: 'class-secret' } as unknown as Env;

  it('answers 401 without the secret, and to everyone while it is unset', async () => {
    expect((await worker.fetch(new Request('https://x.example/class-emails/e1'), withSecret, ctx)).status).toBe(401);
    const unset = { ...env, CLASS_EMAIL_SECRET: undefined } as unknown as Env;
    const res = await worker.fetch(new Request('https://x.example/class-emails/e1', { headers: { 'X-Class-Email-Secret': 'anything' } }), unset, ctx);
    expect(res.status).toBe(401);
  });

  it('reaches the D1 ledger with the secret: an unknown class is a 404', async () => {
    const res = await worker.fetch(new Request('https://x.example/class-emails/no-such-event', { headers: { 'X-Class-Email-Secret': 'class-secret' } }), withSecret, ctx);
    expect(res.status).toBe(404);
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
  const idleSweep = () => vi.fn<typeof sweepEndedEvents>().mockResolvedValue({ queued: [], failed: [] });
  function context() {
    const waited: Promise<unknown>[] = [];
    return { ctx: { waitUntil: (p: Promise<unknown>) => { waited.push(p); } } as unknown as ExecutionContext, waited };
  }

  it('runs the check only at the check hour', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const check = quietCheck();
    const { ctx, waited } = context();
    await runScheduled(offHour, withToken, ctx, check, idleSweep());
    await Promise.all(waited);
    expect(check).not.toHaveBeenCalled();

    await runScheduled(checkController, withToken, ctx, check, idleSweep());
    await Promise.all(waited);
    expect(check.mock.calls[0]![0]).toEqual(new Date(checkTime));
    expect(Object.keys(check.mock.calls[0]![1]).sort()).toEqual(['ledger', 'lister', 'organizationId']);
  });

  it('runs the ended-event sweep every hour', async () => {
    const sweep = idleSweep();
    const { ctx, waited } = context();
    await runScheduled(offHour, flags(async () => 'on'), ctx, quietCheck(), sweep);
    await Promise.all(waited);
    expect(sweep.mock.calls[0]![0]).toEqual(new Date(offHour.scheduledTime));
  });

  it('names only the sweep when it skips outside the check hour', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx } = context();
    await runScheduled(offHour, flags(async () => 'hold'), ctx, quietCheck(), idleSweep());
    expect(warn).toHaveBeenCalledWith('eventbrite-sync scheduled: write mode is "hold"; skipping the ended-event sweep');
  });

  it('logs missed orders as an error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const check = vi.fn<typeof checkMissedOrders>().mockResolvedValue({ organizationId: '1', checked: 3, missing: ['55'] });
    const { ctx, waited } = context();
    await runScheduled(checkController, withToken, ctx, check, idleSweep());
    await Promise.all(waited);
    expect(error.mock.calls[0]![0]).toContain('1 of 3 orders');
  });

  it('logs a check that throws and does not reject the waitUntil promise', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const check = vi.fn<typeof checkMissedOrders>().mockRejectedValue(new Error('HTTP 503'));
    const { ctx, waited } = context();
    await runScheduled(checkController, withToken, ctx, check, idleSweep());
    await expect(Promise.all(waited)).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith('eventbrite-sync missed orders: check failed: HTTP 503');
  });

  it('logs an unset EVENTBRITE_PRIVATE_TOKEN and does not run the check', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const check = vi.fn<typeof checkMissedOrders>();
    const { ctx } = context();
    await runScheduled(checkController, { ...withToken, EVENTBRITE_PRIVATE_TOKEN: undefined } as unknown as Env, ctx, check, idleSweep());
    expect(check).not.toHaveBeenCalled();
    expect(error.mock.calls[0]![0]).toContain('EVENTBRITE_PRIVATE_TOKEN is not set');
  });

  // Write switch (spec 2026-10-26): read once per cron run; the check follows runDisposition.
  describe('write switch', () => {
    it.each(['on', 'off'] as const)('%s: runs the check (it only reads and logs, so a dry run is the live run)', async (mode) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const check = quietCheck();
      const { ctx, waited } = context();
      await runScheduled(checkController, flags(async () => mode), ctx, check, idleSweep());
      await Promise.all(waited);
      expect(check).toHaveBeenCalled();
    });

    // A sweep that tries one send, against an env whose queue the test can see.
    function sendingSweep() {
      const send = vi.fn().mockResolvedValue(undefined);
      const sweep = vi.fn<typeof sweepEndedEvents>().mockImplementation(async (_now, deps) => {
        await deps.queue.send({ kind: 'event', eventId: '9001', action: 'event.ended' });
        return { queued: ['9001'], failed: [] };
      });
      return { send, sweep };
    }

    it('on: the ended-event sweep sends for real', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { send, sweep } = sendingSweep();
      const { ctx, waited } = context();
      await runScheduled(offHour, { ...flags(async () => 'on'), WRITE_QUEUE: { send } } as unknown as Env, ctx, quietCheck(), sweep);
      await Promise.all(waited);
      expect(send).toHaveBeenCalledWith({ kind: 'event', eventId: '9001', action: 'event.ended' });
    });

    it('off: the ended-event sweep is dry-run, its send only logged', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { send, sweep } = sendingSweep();
      const { ctx, waited } = context();
      await runScheduled(offHour, { ...flags(async () => 'off'), WRITE_QUEUE: { send } } as unknown as Env, ctx, quietCheck(), sweep);
      await Promise.all(waited);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join('\n')).toContain('Write queue');
    });

    it('hold: does not run the ended-event sweep', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sweep = idleSweep();
      const { ctx } = context();
      await runScheduled(offHour, flags(async () => 'hold'), ctx, quietCheck(), sweep);
      expect(sweep).not.toHaveBeenCalled();
    });

    it('logs a sweep that throws and still runs the check', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const check = quietCheck();
      const sweep = vi.fn<typeof sweepEndedEvents>().mockRejectedValue(new Error('D1 unavailable'));
      const { ctx, waited } = context();
      await runScheduled(checkController, flags(async () => 'on'), ctx, check, sweep);
      await expect(Promise.all(waited)).resolves.toBeDefined();
      expect(check).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith('eventbrite-sync ended events: sweep failed: D1 unavailable');
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
      await runScheduled(checkController, flags(get), ctx, check, idleSweep());
      await Promise.all(waited);
      expect(waited).toHaveLength(0);
      expect(check).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(`eventbrite-sync scheduled: write mode is "${mode}"; skipping the ended-event sweep and the missed-order check`);
    });
  });
});
