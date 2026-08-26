import { describe, it, expect, vi } from 'vitest';
import worker from './index';
import type { Env } from './types';

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    OUTBOUND_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Env['OUTBOUND_QUEUE'],
    INBOUND_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Env['INBOUND_QUEUE'],
    MONDAY_API_TOKEN: 'token',
    MAILCHIMP_API_KEY: 'key',
    ...overrides,
  };
}

describe('fetch', () => {
  it('serves /health', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/health'), fakeEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
  });

  it('mounts the outbound Monday webhook route', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/webhooks/monday/donors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: 'abc' }),
      }),
      fakeEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc' });
  });
});

describe('scheduled', () => {
  it('runs reconcileCampaigns and does not throw when it fails', async () => {
    const env = fakeEnv();
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    // No throw expected even though config.monday.campaignsBoardId is null in the
    // placeholder config/svbc.json — reconcileCampaigns's own rejection is caught
    // inside scheduled(), not propagated.
    await expect(worker.scheduled({} as ScheduledEvent, env, ctx)).resolves.toBeUndefined();
    expect(ctx.waitUntil).toHaveBeenCalled();
  });
});
