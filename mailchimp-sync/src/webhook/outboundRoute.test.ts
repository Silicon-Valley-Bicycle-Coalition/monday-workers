import { describe, it, expect, vi } from 'vitest';
import { createOutboundApp } from './outboundRoute';
import type { PendingOutboundStore } from '../db/pendingOutbound';
import type { Config } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: 111, campaignsBoardId: 999, columns: {
    membershipStatus: 's', membershipTier: 't', memberSince: 'ms', memberUntil: 'mu',
    addr1: 'a1', city: 'c', state: 'st', zip: 'z', email: 'e', totalGiven: 'g', mailchimpCampaigns: 'mc',
  } },
  mailchimp: { apiBaseUrl: '', audienceId: '', mergeFields: {} as never, tags: {} as never },
  lifetimeTierValue: 'Lifetime', activeStatusValue: 'Active',
};

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
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send }, webhookSecret: 'shh', config: CONFIG });
    const res = await post(app, { event: { pulseId: 1 } });
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts the correct secret, including for the challenge handshake', async () => {
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() }, webhookSecret: 'shh', config: CONFIG });
    const res = await post(app, { challenge: 'abc' }, '?secret=shh');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc' });
  });
});

describe('POST /webhooks/monday/donors', () => {
  it('echoes the challenge verbatim during webhook-subscription verification', async () => {
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() }, config: CONFIG });
    const res = await post(app, { challenge: 'abc123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('upserts and enqueues a valid event, keyed on the donor item id', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createOutboundApp({ pendingStore, queue: { send }, config: CONFIG });

    const res = await post(app, { event: { pulseId: 555 } });

    expect(res.status).toBe(200);
    expect(pendingStore.upsertPending).toHaveBeenCalledWith('555', expect.any(String));
    expect(send).toHaveBeenCalledWith({ donorItemId: '555' });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('555', 'queued');
  });

  it('skips and does not enqueue a change_column_value event for the mailchimpCampaigns column (self-inflicted, avoids feedback loop)', async () => {
    const send = vi.fn();
    const pendingStore = fakePendingStore();
    const app = createOutboundApp({ pendingStore, queue: { send }, config: CONFIG });

    const res = await post(app, { event: { type: 'update_column_value', pulseId: 555, boardId: 1, columnId: 'mc' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(send).not.toHaveBeenCalled();
    expect(pendingStore.upsertPending).not.toHaveBeenCalled();
  });

  it('still enqueues a change_column_value event for a different column', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const pendingStore = fakePendingStore();
    const app = createOutboundApp({ pendingStore, queue: { send }, config: CONFIG });

    const res = await post(app, { event: { type: 'update_column_value', pulseId: 555, boardId: 1, columnId: 's' } });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ donorItemId: '555' });
  });

  it('still enqueues a create_pulse event (no columnId at all)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const pendingStore = fakePendingStore();
    const app = createOutboundApp({ pendingStore, queue: { send }, config: CONFIG });

    const res = await post(app, { event: { type: 'create_pulse', pulseId: 555, boardId: 1 } });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ donorItemId: '555' });
  });

  it('rejects a malformed event body with 200 (no useful retry) and does not enqueue', async () => {
    const send = vi.fn();
    const app = createOutboundApp({ pendingStore: fakePendingStore(), queue: { send }, config: CONFIG });
    const res = await post(app, { event: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 500 and marks failed when enqueue throws, so Monday redelivers', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockRejectedValue(new Error('queue down'));
    const app = createOutboundApp({ pendingStore, queue: { send }, config: CONFIG });

    const res = await post(app, { event: { pulseId: 1 } });

    expect(res.status).toBe(500);
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('1', 'failed', 'queue down');
  });
});
