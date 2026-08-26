import { describe, it, expect, vi } from 'vitest';
import { createOutboundApp } from './outboundRoute';
import type { PendingOutboundStore } from '../db/pendingOutbound';

function fakePendingStore(overrides: Partial<PendingOutboundStore> = {}): PendingOutboundStore {
  return {
    upsertPending: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function post(app: ReturnType<typeof createOutboundApp>, body: unknown, query = '') {
  return app.request(`/webhooks/monday/donors${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('webhook secret', () => {
  it('rejects a request missing the configured secret with 401', async () => {
    const send = vi.fn();
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send }, webhookSecret: 'shh' });
    const res = await post(app, { event: { pulseId: 1 } });
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts the correct secret, including for the challenge handshake', async () => {
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() }, webhookSecret: 'shh' });
    const res = await post(app, { challenge: 'abc' }, '?secret=shh');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc' });
  });
});

describe('POST /webhooks/monday/donors', () => {
  it('echoes the challenge verbatim during webhook-subscription verification', async () => {
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() } });
    const res = await post(app, { challenge: 'abc123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('upserts and enqueues a valid event, keyed on the donor item id', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createOutboundApp({ pendingStore, queue: { send } });

    const res = await post(app, { event: { pulseId: 555 } });

    expect(res.status).toBe(200);
    expect(pendingStore.upsertPending).toHaveBeenCalledWith('555', expect.any(String));
    expect(send).toHaveBeenCalledWith({ donorItemId: '555' });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('555', 'queued');
  });

  it('rejects a malformed event body with 200 (no useful retry) and does not enqueue', async () => {
    const send = vi.fn();
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send } });
    const res = await post(app, { event: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 500 and marks failed when enqueue throws, so Monday redelivers', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockRejectedValue(new Error('queue down'));
    const app = createOutboundApp({ pendingStore, queue: { send } });

    const res = await post(app, { event: { pulseId: 1 } });

    expect(res.status).toBe(500);
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('1', 'failed', 'queue down');
  });
});
