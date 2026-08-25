import { describe, it, expect, vi } from 'vitest';
import { createApp } from './route';
import type { PendingStore } from '../db/pending';

function fakePendingStore(overrides: Partial<PendingStore> = {}): PendingStore {
  return {
    upsertPending: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/webhooks/monday/donations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /webhooks/monday/donations', () => {
  it('echoes the challenge verbatim during webhook-subscription verification', async () => {
    const app = createApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() } });
    const res = await post(app, { challenge: 'abc123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('upserts and enqueues a valid event, keyed on the donation item id', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ pendingStore, queue: { send } });

    const res = await post(app, { event: { type: 'create_pulse', pulseId: 555, boardId: 1 } });

    expect(res.status).toBe(200);
    expect(pendingStore.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({ donationItemId: '555' }),
    );
    expect(send).toHaveBeenCalledWith({ donationItemId: '555' });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('555', 'queued');
  });

  it('rejects a malformed event body with 200 (no useful retry) and does not enqueue', async () => {
    const send = vi.fn();
    const app = createApp({ pendingStore: fakePendingStore(), queue: { send } });
    const res = await post(app, { event: { type: 'create_pulse' } }); // no pulseId
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 500 and marks failed when enqueue throws, so Monday redelivers', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockRejectedValue(new Error('queue down'));
    const app = createApp({ pendingStore, queue: { send } });

    const res = await post(app, { event: { type: 'create_pulse', pulseId: 1, boardId: 1 } });

    expect(res.status).toBe(500);
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('1', 'failed', { error: 'queue down' });
  });
});
