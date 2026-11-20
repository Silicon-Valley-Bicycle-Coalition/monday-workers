import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { isDeadLetterBatch, runScheduled } from './index';
import type { Env } from './types';
import type { checkMissedOrders } from './missedOrders/check';
import type { sweepEndedEvents } from './endedEvents/sweep';
import type { sweepSendLinks } from './sendLinks/sweep';

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
  const idleLinks = () => vi.fn<typeof sweepSendLinks>().mockResolvedValue({ stale: 0, written: 0, failed: [], dryRun: false });

  it('runs the send-link sweep at the check hour only, as a dry run under off and not at all under hold', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const links = idleLinks();
    await runScheduled(offHour, flags(async () => 'on'), quietCheck(), idleSweep(), undefined, links);
    expect(links).not.toHaveBeenCalled();

    await runScheduled(checkController, flags(async () => 'on'), quietCheck(), idleSweep(), undefined, links);
    const deps = links.mock.calls[0]![0];
    expect(deps.dryRun).toBe(false);
    expect(deps.pageUrl).toMatch(/^https:\/\/script\.google\.com\//);
    expect(deps.sendLinkColumn).toBe('link_mm8sk30a');

    await runScheduled(checkController, flags(async () => 'off'), quietCheck(), idleSweep(), undefined, links);
    expect(links.mock.calls[1]![0].dryRun).toBe(true);

    await runScheduled(checkController, flags(async () => 'hold'), quietCheck(), idleSweep(), undefined, links);
    expect(links).toHaveBeenCalledTimes(2);
  });

  it('skips the send-link sweep when the config has no page to link to', async () => {
    const links = idleLinks();
    const sandboxEnv = { ...withToken, ENVIRONMENT: 'sandbox', FLAGS: { get: async () => 'on' } } as unknown as Env;
    await runScheduled(checkController, sandboxEnv, quietCheck(), idleSweep(), vi.fn().mockResolvedValue([]), links);
    expect(links).not.toHaveBeenCalled();
  });

  it('runs the check only at the check hour', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const check = quietCheck();
    await runScheduled(offHour, withToken, check, idleSweep());
    expect(check).not.toHaveBeenCalled();

    await runScheduled(checkController, withToken, check, idleSweep(), undefined, idleLinks());
    expect(check.mock.calls[0]![0]).toEqual(new Date(checkTime));
    expect(Object.keys(check.mock.calls[0]![1]).sort()).toEqual(['ledger', 'lister', 'organizationId']);
  });

  it('runs the pledge count check at the check hour for a config with pledges, and not otherwise', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const counts = vi.fn().mockResolvedValue([]);
    const sandboxEnv = { ...withToken, ENVIRONMENT: 'sandbox' } as unknown as Env;
    await runScheduled(offHour, sandboxEnv, quietCheck(), idleSweep(), counts);
    expect(counts).not.toHaveBeenCalled();
    await runScheduled(checkController, sandboxEnv, quietCheck(), idleSweep(), counts, idleLinks());
    expect(counts.mock.calls[0]![1].eventIds).toEqual(['1977741403778']);
  });

  it('skips the pledge count check under hold', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const counts = vi.fn().mockResolvedValue([]);
    await runScheduled(checkController, flags(async () => 'hold'), quietCheck(), idleSweep(), counts, idleLinks());
    expect(counts).not.toHaveBeenCalled();
  });

  it('runs the ended-event sweep every hour', async () => {
    const sweep = idleSweep();
    await runScheduled(offHour, flags(async () => 'on'), quietCheck(), sweep);
    expect(sweep.mock.calls[0]![0]).toEqual(new Date(offHour.scheduledTime));
  });

  // An awaited scheduled() handler gets the full 15 minutes; work left in ctx.waitUntil is only
  // promised 30 seconds after the handler returns.
  it('does not resolve until its jobs have finished', async () => {
    let finishSweep: (summary: { queued: string[]; failed: string[] }) => void = () => {};
    const sweep = vi.fn<typeof sweepEndedEvents>().mockReturnValue(new Promise((resolve) => { finishSweep = resolve; }));
    let settled = false;
    const run = runScheduled(offHour, flags(async () => 'on'), quietCheck(), sweep).then(() => { settled = true; });
    await vi.waitFor(() => expect(sweep).toHaveBeenCalled());
    expect(settled).toBe(false);
    finishSweep({ queued: [], failed: [] });
    await run;
    expect(settled).toBe(true);
  });

  it('names only the sweep when it skips outside the check hour', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runScheduled(offHour, flags(async () => 'hold'), quietCheck(), idleSweep());
    expect(warn).toHaveBeenCalledWith('eventbrite-sync scheduled: write mode is "hold"; skipping the ended-event sweep');
  });

  it('logs missed orders as an error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const check = vi.fn<typeof checkMissedOrders>().mockResolvedValue({ organizationId: '1', checked: 3, missing: ['55'] });
    await runScheduled(checkController, withToken, check, idleSweep(), undefined, idleLinks());
    expect(error.mock.calls[0]![0]).toContain('1 of 3 orders');
  });

  it('logs a check that throws and does not reject the run', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const check = vi.fn<typeof checkMissedOrders>().mockRejectedValue(new Error('HTTP 503'));
    await expect(runScheduled(checkController, withToken, check, idleSweep(), undefined, idleLinks())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('eventbrite-sync missed orders: check failed: HTTP 503');
  });

  it('logs an unset EVENTBRITE_PRIVATE_TOKEN and does not run the check', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const check = vi.fn<typeof checkMissedOrders>();
    await runScheduled(checkController, { ...withToken, EVENTBRITE_PRIVATE_TOKEN: undefined } as unknown as Env, check, idleSweep(), undefined, idleLinks());
    expect(check).not.toHaveBeenCalled();
    expect(error.mock.calls[0]![0]).toContain('EVENTBRITE_PRIVATE_TOKEN is not set');
  });

  // Write switch (spec 2026-10-26): read once per cron run; the check follows runDisposition.
  describe('write switch', () => {
    it.each(['on', 'off'] as const)('%s: runs the check (it only reads and logs, so a dry run is the live run)', async (mode) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const check = quietCheck();
      await runScheduled(checkController, flags(async () => mode), check, idleSweep(), undefined, idleLinks());
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
      await runScheduled(offHour, { ...flags(async () => 'on'), WRITE_QUEUE: { send } } as unknown as Env, quietCheck(), sweep);
      expect(send).toHaveBeenCalledWith({ kind: 'event', eventId: '9001', action: 'event.ended' });
    });

    it('off: the ended-event sweep is dry-run, its send only logged', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { send, sweep } = sendingSweep();
      await runScheduled(offHour, { ...flags(async () => 'off'), WRITE_QUEUE: { send } } as unknown as Env, quietCheck(), sweep);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join('\n')).toContain('Write queue');
    });

    it('hold: does not run the ended-event sweep', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sweep = idleSweep();
      await runScheduled(offHour, flags(async () => 'hold'), quietCheck(), sweep);
      expect(sweep).not.toHaveBeenCalled();
    });

    it('logs a sweep that throws and still runs the check', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const check = quietCheck();
      const sweep = vi.fn<typeof sweepEndedEvents>().mockRejectedValue(new Error('D1 unavailable'));
      await expect(runScheduled(checkController, flags(async () => 'on'), check, sweep, undefined, idleLinks())).resolves.toBeUndefined();
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
      const sweep = idleSweep();
      await runScheduled(checkController, flags(get), check, sweep, undefined, idleLinks());
      expect(sweep).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(`eventbrite-sync scheduled: write mode is "${mode}"; skipping the ended-event sweep and the daily checks`);
    });
  });
});

// GL#101: a verified delivery skips the per-IP limiter; anything else is still limited.
describe('rate limit exemption for verified webhooks', () => {
  const denyingEnv = () => ({
    ...env,
    EVENTBRITE_WEBHOOK_SECRET: 's3cret',
    REQUEST_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
  }) as unknown as import('./types').Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it('passes a verified delivery through even when the limiter is exhausted', async () => {
    const testEnv = denyingEnv();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await worker.fetch(new Request('https://x.example/webhooks/eventbrite/order?secret=s3cret', { method: 'POST', body: '{}' }), testEnv, ctx);
      expect(response.status).not.toBe(429);
      expect(testEnv.REQUEST_RATE_LIMITER.limit).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  });

  it('still limits a delivery with the wrong secret', async () => {
    const response = await worker.fetch(new Request('https://x.example/webhooks/eventbrite/order?secret=guess', { method: 'POST', body: '{}' }), denyingEnv(), ctx);
    expect(response.status).toBe(429);
  });
});
