import { describe, it, expect, vi } from 'vitest';
import { createInboundApp } from './inboundRoute';
import type { PendingInboundStore } from '../db/pendingInbound';

function fakePendingStore(overrides: Partial<PendingInboundStore> = {}): PendingInboundStore {
  return { upsertPending: vi.fn().mockResolvedValue(undefined), updateStatus: vi.fn().mockResolvedValue(undefined), ...overrides };
}

function postForm(app: ReturnType<typeof createInboundApp>, fields: Record<string, string>, query = '') {
  const body = new URLSearchParams(fields);
  return app.request(`/webhooks/mailchimp/audience${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

describe('GET /webhooks/mailchimp/audience', () => {
  it('responds 200 to Mailchimp\'s configuration-time ping', async () => {
    const app = createInboundApp({ pendingStore: fakePendingStore(), queue: { send: vi.fn() } });
    const res = await app.request('/webhooks/mailchimp/audience');
    expect(res.status).toBe(200);
  });
});

describe('webhook secret', () => {
  it('rejects a request missing the configured secret with 401', async () => {
    const send = vi.fn();
    const app = createInboundApp({ pendingStore: fakePendingStore(), queue: { send }, webhookSecret: 'shh' });
    const res = await postForm(app, { type: 'unsubscribe', 'data[email]': 'a@b.com' });
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/mailchimp/audience', () => {
  it('upserts and enqueues a valid event, keyed on email', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createInboundApp({ pendingStore, queue: { send } });

    const res = await postForm(app, { type: 'profile', 'data[email]': 'a@b.com' });

    expect(res.status).toBe(200);
    expect(pendingStore.upsertPending).toHaveBeenCalledWith('a@b.com', expect.any(String));
    expect(send).toHaveBeenCalledWith({ email: 'a@b.com' });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('a@b.com', 'queued');
  });

  it('rejects a malformed event with 200 and does not enqueue', async () => {
    const send = vi.fn();
    const app = createInboundApp({ pendingStore: fakePendingStore(), queue: { send } });
    const res = await postForm(app, { type: 'profile' }); // no email
    expect(res.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 500 and marks failed when enqueue throws', async () => {
    const pendingStore = fakePendingStore();
    const send = vi.fn().mockRejectedValue(new Error('queue down'));
    const app = createInboundApp({ pendingStore, queue: { send } });

    const res = await postForm(app, { type: 'unsubscribe', 'data[email]': 'a@b.com' });

    expect(res.status).toBe(500);
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('a@b.com', 'failed', 'queue down');
  });
});
