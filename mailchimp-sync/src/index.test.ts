import { describe, it, expect, vi } from 'vitest';
import { env as testEnv } from 'cloudflare:test';
import worker from './index';
import type { Env, InboundSyncMessage, OutboundSyncMessage } from './types';

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: testEnv.DB,
    OUTBOUND_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Env['OUTBOUND_QUEUE'],
    INBOUND_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Env['INBOUND_QUEUE'],
    MONDAY_API_TOKEN: 'token',
    MONDAY_WEBHOOK_SECRET: 'test-monday-webhook-secret',
    MAILCHIMP_API_KEY: 'key',
    MAILCHIMP_WEBHOOK_SECRET: 'test-mailchimp-webhook-secret',
    // Real local-simulated binding (see wrangler.jsonc's ratelimits) — never exceeded by these
    // tests' request volume.
    REQUEST_RATE_LIMITER: testEnv.REQUEST_RATE_LIMITER,
    ...overrides,
  };
}

// Matches the { body, ack, retry } shape processOutboundBatch/processInboundBatch expect
// (see outbound.test.ts/inbound.test.ts's fakeMessage helpers) — a real message here, not
// an empty batch, so these tests actually exercise a consumer instead of no-op-ing.
function fakeMessage<T>(body: T): { body: T; ack: () => void; retry: () => void } {
  return { body, ack: vi.fn(), retry: vi.fn() };
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
      new Request('https://worker.example/webhooks/monday/donors?secret=test-monday-webhook-secret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: 'abc' }),
      }),
      fakeEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc' });
  });

  it('rejects the outbound Monday webhook route without the shared secret', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/webhooks/monday/donors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: 'abc' }),
      }),
      fakeEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});

describe('fetch — inbound', () => {
  it('mounts the inbound Mailchimp webhook route', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/webhooks/mailchimp/audience'), fakeEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
  });

  it('rejects the inbound Mailchimp webhook POST without the shared secret', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/webhooks/mailchimp/audience', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'type=unsubscribe&data%5Bemail%5D=a%40b.com',
      }),
      fakeEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});

describe('queue dispatch', () => {
  it('routes an outbound-queue batch to processOutboundBatch, which acks a real message', async () => {
    const env = fakeEnv();
    // Stub Monday's GraphQL response so getDonorById resolves "item not found" (donor ===
    // null), taking the skip-and-ack path — proves the outbound consumer actually ran,
    // not just that the call didn't throw.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { items: [] } }) }));
    try {
      const message = fakeMessage<OutboundSyncMessage>({ donorItemId: '1' });
      const batch = { queue: 'mailchimp-sync-outbound', messages: [message] } as unknown as MessageBatch<unknown>;

      await expect(worker.queue(batch, env)).resolves.toBeUndefined();

      expect(message.ack).toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('routes an inbound-queue batch to processInboundBatch, which acks a real message', async () => {
    const env = fakeEnv();
    // Stub Mailchimp's response as 404 so getMemberInterests resolves null (contact
    // doesn't exist), taking the skip-and-ack path — same proof-of-routing reasoning.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' }));
    try {
      const message = fakeMessage<InboundSyncMessage>({ email: 'a@b.com' });
      const batch = { queue: 'mailchimp-sync-inbound', messages: [message] } as unknown as MessageBatch<unknown>;

      await expect(worker.queue(batch, env)).resolves.toBeUndefined();

      expect(message.ack).toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws on an unrecognized queue name instead of silently routing to inbound', async () => {
    const env = fakeEnv();
    const batch = { queue: 'mailchimp-sync-typo', messages: [] } as unknown as MessageBatch<unknown>;
    await expect(worker.queue(batch, env)).rejects.toThrow('unknown queue: mailchimp-sync-typo');
    const typoDlq = { queue: 'mailchimp-sync-typo-dlq', messages: [] } as unknown as MessageBatch<unknown>;
    await expect(worker.queue(typoDlq, env)).rejects.toThrow('unknown queue: mailchimp-sync-typo-dlq');
  });

  // #37: the DLQs had no consumer; a dead message now marks its real D1 row.
  it('routes the outbound DLQ to the dead-letter consumer, which marks the pending row and acks', async () => {
    const env = fakeEnv();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await testEnv.DB.prepare(
        `INSERT INTO pending_outbound_syncs (donor_item_id, status, error, received_at) VALUES ('dlq-1', 'failed', 'mailchimp updateMember: HTTP 500', '2026-09-20T10:00:00.000Z')`,
      ).run();
      const message = { ...fakeMessage<OutboundSyncMessage>({ donorItemId: 'dlq-1' }), timestamp: new Date('2026-09-20T10:00:01.000Z') };
      const batch = { queue: 'mailchimp-sync-outbound-dlq', messages: [message] } as unknown as MessageBatch<unknown>;

      await expect(worker.queue(batch, env)).resolves.toBeUndefined();

      expect(message.ack).toHaveBeenCalled();
      const row = await testEnv.DB.prepare(`SELECT status, error FROM pending_outbound_syncs WHERE donor_item_id = 'dlq-1'`).first();
      expect(row).toEqual({ status: 'failed', error: 'dead-lettered after retries: mailchimp updateMember: HTTP 500' });
      // Marking is D1-only: nothing is re-sent to Monday or Mailchimp from a DLQ.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      errorSpy.mockRestore();
    }
  });

  it('routes the inbound DLQ to the dead-letter consumer, which marks the pending row and acks', async () => {
    const env = fakeEnv();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await testEnv.DB.prepare(
        `INSERT INTO pending_inbound_syncs (email, status, error, received_at) VALUES ('dlq@example.com', 'failed', 'monday down', '2026-09-20T10:00:00.000Z')`,
      ).run();
      const message = { ...fakeMessage<InboundSyncMessage>({ email: 'dlq@example.com' }), timestamp: new Date('2026-09-20T10:00:01.000Z') };
      const batch = { queue: 'mailchimp-sync-inbound-dlq', messages: [message] } as unknown as MessageBatch<unknown>;

      await expect(worker.queue(batch, env)).resolves.toBeUndefined();

      expect(message.ack).toHaveBeenCalled();
      const row = await testEnv.DB.prepare(`SELECT error FROM pending_inbound_syncs WHERE email = 'dlq@example.com'`).first();
      expect(row).toEqual({ error: 'dead-lettered after retries: monday down' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('scheduled', () => {
  it('runs reconcileCampaigns and does not throw when it fails', async () => {
    const env = fakeEnv();
    let captured: Promise<unknown> | undefined;
    const ctx = { waitUntil: vi.fn((p: Promise<unknown>) => { captured = p; }) } as unknown as ExecutionContext;

    await worker.scheduled({} as ScheduledEvent, env, ctx);

    expect(ctx.waitUntil).toHaveBeenCalled();
    // Explicitly await the exact promise scheduled() handed to waitUntil, rather than
    // relying on reconcileCampaigns rejecting synchronously before this assertion runs.
    // scheduled()'s own .catch() means this must resolve, even though
    // config.monday.campaignsBoardId is null in the placeholder config/svbc.json and
    // reconcileCampaigns itself rejects.
    await expect(captured).resolves.toBeUndefined();
  });
});

describe('request-time config selection', () => {
  it('serves /health under the sandbox environment', async () => {
    const res = await worker.fetch(new Request('https://worker.example/health'), fakeEnv({ ENVIRONMENT: 'sandbox' }), {} as ExecutionContext);
    expect(res.status).toBe(200);
  });

  it('refuses an unknown ENVIRONMENT value before routing anything', () => {
    // fetch is synchronous up to the config lookup, so the refusal is a synchronous throw — which
    // the Workers runtime turns into a 500 before any route runs.
    expect(() =>
      worker.fetch(new Request('https://worker.example/health'), fakeEnv({ ENVIRONMENT: 'staging' }), {} as ExecutionContext)
    ).toThrow('ENVIRONMENT');
  });

  it('routes the sandbox-suffixed queue names to the same consumers', async () => {
    const emptyBatch = (queue: string) => ({ queue, messages: [], retryAll: vi.fn(), ackAll: vi.fn() }) as unknown as MessageBatch<unknown>;
    await expect(worker.queue(emptyBatch('mailchimp-sync-outbound-sandbox'), fakeEnv({ ENVIRONMENT: 'sandbox' }))).resolves.toBeUndefined();
    await expect(worker.queue(emptyBatch('mailchimp-sync-inbound-sandbox'), fakeEnv({ ENVIRONMENT: 'sandbox' }))).resolves.toBeUndefined();
    await expect(worker.queue(emptyBatch('mailchimp-sync-outbound-sandbox-dlq'), fakeEnv({ ENVIRONMENT: 'sandbox' }))).resolves.toBeUndefined();
    await expect(worker.queue(emptyBatch('mailchimp-sync-inbound-sandbox-dlq'), fakeEnv({ ENVIRONMENT: 'sandbox' }))).resolves.toBeUndefined();
    // "-dlq-sandbox" is not a name this Worker declares — suffix order matters.
    await expect(worker.queue(emptyBatch('mailchimp-sync-outbound-dlq-sandbox'), fakeEnv({ ENVIRONMENT: 'sandbox' }))).rejects.toThrow('unknown queue');
  });
});
