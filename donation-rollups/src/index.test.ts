import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker, { isDeadLetterBatch } from './index';

describe('worker entry point', () => {
  it('exposes fetch, queue and scheduled handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.queue).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });
});

describe('isDeadLetterBatch', () => {
  it('recognizes the production dead-letter queue', () => {
    expect(isDeadLetterBatch('donation-rollups-recompute-dlq')).toBe(true);
  });

  it('recognizes the sandbox dead-letter queue', () => {
    expect(isDeadLetterBatch('donation-rollups-recompute-sandbox-dlq')).toBe(true);
  });

  it('does not treat either recompute queue as dead letters', () => {
    expect(isDeadLetterBatch('donation-rollups-recompute')).toBe(false);
    expect(isDeadLetterBatch('donation-rollups-recompute-sandbox')).toBe(false);
  });
});

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const SECRET = 'test-secret';

function envFor(extra: Record<string, unknown>) {
  // The real D1 (migrations applied by test/apply-migrations.ts); a no-op queue so the route's
  // enqueue succeeds without a real Queue binding; the webhook secret every request below presents.
  return { ...env, RECOMPUTE_QUEUE: { send: async () => undefined }, MONDAY_WEBHOOK_SECRET: SECRET, ...extra } as unknown as import('./types').Env;
}

function donationsWebhook(pulseId: number, secret: string | null = SECRET) {
  const query = secret === null ? '' : `?secret=${secret}`;
  return new Request(`http://worker.test/webhooks/monday/donations${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: { type: 'create_pulse', pulseId, boardId: 18431577310 } }),
  });
}

describe('request-time config selection', () => {
  it('accepts a sandbox Donations-board event when ENVIRONMENT is "sandbox" (board is in config/sandbox.json)', async () => {
    const res = await worker.fetch(donationsWebhook(910001), envFor({ ENVIRONMENT: 'sandbox' }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await env.DB.prepare(`SELECT status FROM pending_recomputes WHERE donation_item_id = '910001'`).first<{ status: string }>();
    expect(row?.status).toBe('queued');
  });

  it('ignores the same event in production, whose config/svbc.json holds only the placeholder board', async () => {
    const res = await worker.fetch(donationsWebhook(910002), envFor({}), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: expect.stringContaining('18431577310') });
    const row = await env.DB.prepare(`SELECT status FROM pending_recomputes WHERE donation_item_id = '910002'`).first();
    expect(row).toBeNull();
  });
});

describe('webhook secret (issue #27)', () => {
  it('fails closed when MONDAY_WEBHOOK_SECRET is unset — nothing reaches D1', async () => {
    for (const request of [donationsWebhook(910003, null), donationsWebhook(910003, 'guess')]) {
      const res = await worker.fetch(request, envFor({ ENVIRONMENT: 'sandbox', MONDAY_WEBHOOK_SECRET: undefined }), ctx);
      expect(res.status).toBe(401);
    }
    const row = await env.DB.prepare(`SELECT status FROM pending_recomputes WHERE donation_item_id = '910003'`).first();
    expect(row).toBeNull();
  });

  it('rejects a wrong secret when one is configured', async () => {
    const res = await worker.fetch(donationsWebhook(910004, 'wrong'), envFor({ ENVIRONMENT: 'sandbox' }), ctx);
    expect(res.status).toBe(401);
  });
});
