import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { isDeadLetterBatch, runScheduled } from './index';
import type { Env } from './types';
import type { runFollowups } from './followups/run';

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
});
