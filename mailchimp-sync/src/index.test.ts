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
    MAILCHIMP_API_KEY: 'key',
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

describe('fetch — inbound', () => {
  it('mounts the inbound Mailchimp webhook route', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example/webhooks/mailchimp/audience'), fakeEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
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
