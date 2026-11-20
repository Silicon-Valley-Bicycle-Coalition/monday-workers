import { describe, it, expect, vi, afterEach } from 'vitest';
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
  // enqueue succeeds without a real Queue binding; the webhook secret every request below presents;
  // writes `on` (a FLAGS stand-in — the local KV has no key, which reads as `off`). The shipped
  // wrangler.jsonc requires a signed JWT; these tests send unsigned deliveries, so they turn the
  // requirement off (the JWT paths have their own tests in mondayJwt.test.ts and webhook/jwt.test.ts).
  return { ...env, RECOMPUTE_QUEUE: { send: async () => undefined }, MONDAY_WEBHOOK_SECRET: SECRET,
    FLAGS: { get: async () => 'on' }, MONDAY_WEBHOOK_JWT_REQUIRED: undefined, ...extra } as unknown as import('./types').Env;
}

function donationsWebhook(pulseId: number, secret: string | null = SECRET) {
  const query = secret === null ? '' : `?secret=${secret}`;
  return new Request(`http://worker.test/webhooks/monday/donations${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: { type: 'create_pulse', pulseId, boardId: 18437342657 } }),
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

  it('with no write-switch key in the real FLAGS KV (reads as off), records the row dropped, not queued', async () => {
    const res = await worker.fetch(donationsWebhook(910008), envFor({ ENVIRONMENT: 'sandbox', FLAGS: env.FLAGS }), ctx);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(`SELECT status FROM pending_recomputes WHERE donation_item_id = '910008'`).first<{ status: string }>();
    expect(row?.status).toBe('dropped');
  });

  it('ignores the same event in production, whose config/svbc.json holds only the placeholder board', async () => {
    const res = await worker.fetch(donationsWebhook(910002), envFor({}), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: expect.stringContaining('18437342657') });
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

  it('with the shipped MONDAY_WEBHOOK_JWT_REQUIRED, rejects an unsigned delivery that has the right secret', async () => {
    expect(env.MONDAY_WEBHOOK_JWT_REQUIRED).toBe('true');
    const res = await worker.fetch(donationsWebhook(910009),
      envFor({ ENVIRONMENT: 'sandbox', MONDAY_WEBHOOK_JWT_REQUIRED: env.MONDAY_WEBHOOK_JWT_REQUIRED }), ctx);
    expect(res.status).toBe(401);
    const row = await env.DB.prepare(`SELECT status FROM pending_recomputes WHERE donation_item_id = '910009'`).first();
    expect(row).toBeNull();
  });
});

// Issue GL#27: the 60/min per-IP limiter also throttled Monday's own deliveries, so a bulk edit of
// more than 60 gifts got 429s. Only a delivery that passes webhook verification skips it.
describe('rate limiter exemption for verified Monday webhooks (issue #27)', () => {
  function exhaustedLimiter() {
    const limit = vi.fn().mockResolvedValue({ success: false });
    return { limit, env: envFor({ ENVIRONMENT: 'sandbox', REQUEST_RATE_LIMITER: { limit } }) };
  }

  it('lets a verified webhook delivery through even when its IP is over the limit', async () => {
    const { limit, env: e } = exhaustedLimiter();
    const res = await worker.fetch(donationsWebhook(910005), e, ctx);
    expect(res.status).toBe(200);
    expect(limit).not.toHaveBeenCalled();
  });

  it('still rate-limits a webhook call with a missing or wrong secret', async () => {
    for (const secret of [null, 'wrong']) {
      const { limit, env: e } = exhaustedLimiter();
      const res = await worker.fetch(donationsWebhook(910006, secret), e, ctx);
      expect(res.status).toBe(429);
      expect(limit).toHaveBeenCalledTimes(1);
    }
  });

  it('does not exempt the right secret on a different route or method', async () => {
    for (const request of [
      new Request(`http://worker.test/custodian/status?secret=${SECRET}`),
      new Request(`http://worker.test/webhooks/monday/donations?secret=${SECRET}`),
      new Request(`http://worker.test/webhooks/monday/donations/x?secret=${SECRET}`, { method: 'POST', body: '{}' }),
    ]) {
      const { limit, env: e } = exhaustedLimiter();
      const res = await worker.fetch(request, e, ctx);
      expect(res.status, request.url).toBe(429);
      expect(limit).toHaveBeenCalledTimes(1);
    }
  });

  it('does not exempt anything when the secret is unset', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const res = await worker.fetch(donationsWebhook(910007, null),
      envFor({ ENVIRONMENT: 'sandbox', MONDAY_WEBHOOK_SECRET: undefined, REQUEST_RATE_LIMITER: { limit } }), ctx);
    expect(res.status).toBe(429);
  });
});

describe('custodian secret (issue #63)', () => {
  const CUSTODIAN = 'custodian-secret';
  const status = (headers: Record<string, string> = {}, query = '') =>
    new Request(`http://worker.test/custodian/status${query}`, { headers });

  it('authorizes /custodian/* with CUSTODIAN_SECRET as a Bearer token', async () => {
    const res = await worker.fetch(status({ Authorization: `Bearer ${CUSTODIAN}` }),
      envFor({ ENVIRONMENT: 'sandbox', CUSTODIAN_SECRET: CUSTODIAN }), ctx);
    expect(res.status).toBe(200);
  });

  it('no longer accepts the webhook secret, in the header or the URL', async () => {
    const e = envFor({ ENVIRONMENT: 'sandbox', CUSTODIAN_SECRET: CUSTODIAN });
    expect((await worker.fetch(status({ Authorization: `Bearer ${SECRET}` }), e, ctx)).status).toBe(401);
    expect((await worker.fetch(status({}, `?secret=${SECRET}`), e, ctx)).status).toBe(401);
  });

  it('fails closed when CUSTODIAN_SECRET is unset, even with the webhook secret set', async () => {
    const res = await worker.fetch(status({ Authorization: `Bearer ${SECRET}` }), envFor({ ENVIRONMENT: 'sandbox' }), ctx);
    expect(res.status).toBe(401);
  });
});

describe('Monday token from the monday-auth broker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds its Monday client from the MONDAY_AUTH binding when bound', async () => {
    // Any GraphQL body will do: the recompute's first Monday read is all this checks.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { items: [] } }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const auth = { token: vi.fn().mockResolvedValue('brokered') };
    const message = {
      body: { donationItemId: '910101', donationBoardId: '18437342657' },
      attempts: 1, ack: vi.fn(), retry: vi.fn(),
    };

    await worker.queue({ queue: 'donation-rollups-recompute-sandbox', messages: [message] } as unknown as MessageBatch<import('./types').RecomputeQueueMessage>,
      envFor({ ENVIRONMENT: 'sandbox', MONDAY_API_TOKEN: undefined, MONDAY_AUTH: auth }));

    expect(auth.token).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('brokered');
  });
});
