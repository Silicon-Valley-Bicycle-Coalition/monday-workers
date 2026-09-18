import { describe, it, expect, vi } from 'vitest';
import { createApp } from './route';
import type { EventStore } from '../db/events';
import { testConfig } from '../test/testConfig';

const config = testConfig(
  { columnMap: {}, entityIdField: 'transactionId', doNotMigrateFields: ['paymentMethod.lastFour'] },
  { 'donations:live': 1 }
);

function fakeEventStore(overrides: Partial<EventStore> = {}): EventStore {
  return {
    upsertEvent: vi.fn().mockResolvedValue('inserted'),
    updateStatusByEntity: vi.fn().mockResolvedValue(undefined),
    getEventByEntity: vi.fn().mockResolvedValue(null),
    purgeWrittenPayloads: vi.fn().mockResolvedValue(0),
    purgeUnresolvedPayloads: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

const SECRET = 'test-secret';

function postEvent(app: ReturnType<typeof createApp>, body: unknown, path = 'transaction') {
  return app.request(`/webhooks/funraise/${path}?secret=${SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createApp', () => {
  it('responds to GET /health with ok: true', async () => {
    const app = createApp({ eventStore: fakeEventStore(), config, queue: { send: vi.fn() }, webhookSecret: SECRET });

    const res = await app.request('/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('echoes x-hook-secret on an authorized handshake request without touching the event store', async () => {
    const eventStore = fakeEventStore();
    const app = createApp({ eventStore, config, queue: { send: vi.fn() }, webhookSecret: SECRET });

    const res = await app.request(`/webhooks/funraise/transaction?secret=${SECRET}`, {
      method: 'POST',
      headers: { 'x-hook-secret': 'shake' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-hook-secret')).toBe('shake');
    expect(eventStore.upsertEvent).not.toHaveBeenCalled();
  });

  // Funraise has one webhook, for transactions; the former subscription/pledge/registration
  // paths are gone (decided 2026-09-18), so anything else is simply not a route.
  it('404s any path other than /transaction without touching the store', async () => {
    const eventStore = fakeEventStore();
    const app = createApp({ eventStore, config, queue: { send: vi.fn() }, webhookSecret: SECRET });

    for (const path of ['subscription', 'pledge', 'registration', 'donation']) {
      const res = await postEvent(app, { data: { id: 'evt-1' } }, path);
      expect(res.status, path).toBe(404);
    }
    expect(eventStore.upsertEvent).not.toHaveBeenCalled();
  });

  it('ingests a new event with its entity id, strips denylisted PII, and enqueues by entity', async () => {
    const eventStore = fakeEventStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ eventStore, config, queue: { send }, webhookSecret: SECRET });

    // Funraise's documented envelope: sentAt + event + the entity under data, numeric ids.
    const res = await postEvent(app, {
      sentAt: 1599067884009,
      event: 'DONATION',
      data: { id: 123, transactionId: 'txn-9', amount: 100, paymentMethod: { lastFour: '4242', brand: 'visa' } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(eventStore.upsertEvent).toHaveBeenCalledWith({
      eventId: '123:1599067884009',
      sentAt: 1599067884009,
      entityType: 'transaction',
      entityId: 'txn-9',
      rawPayload: JSON.stringify({ id: 123, transactionId: 'txn-9', amount: 100, paymentMethod: { brand: 'visa' } }),
      receivedAt: expect.any(String),
    });
    expect(send).toHaveBeenCalledWith({ entityType: 'transaction', entityId: 'txn-9' });
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-9', 'queued');
  });

  it('re-enqueues when the upsert reports an update to a known entity', async () => {
    const eventStore = fakeEventStore({ upsertEvent: vi.fn().mockResolvedValue('updated') });
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ eventStore, config, queue: { send }, webhookSecret: SECRET });

    const res = await postEvent(app, { data: { id: 'evt-2', transactionId: 'txn-9', amount: 50 } });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ entityType: 'transaction', entityId: 'txn-9' });
  });

  it('short-circuits on a duplicate delivery without enqueueing', async () => {
    const eventStore = fakeEventStore({ upsertEvent: vi.fn().mockResolvedValue('duplicate') });
    const send = vi.fn();
    const app = createApp({ eventStore, config, queue: { send }, webhookSecret: SECRET });

    const res = await postEvent(app, { data: { id: 'evt-1', transactionId: 'txn-9' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 500 when the enqueue fails, so the delivery is not falsely acknowledged', async () => {
    const eventStore = fakeEventStore();
    const send = vi.fn().mockRejectedValue(new Error('queue unavailable'));
    const app = createApp({ eventStore, config, queue: { send }, webhookSecret: SECRET });

    const res = await postEvent(app, { data: { id: 'evt-3', transactionId: 'txn-3' } });

    expect(res.status).toBe(500);
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-3', 'failed', {
      error: 'queue unavailable',
    });
  });
});

describe('webhook authentication', () => {
  it('rejects a POST without the shared-secret query param with 401, before touching the store', async () => {
    const eventStore = fakeEventStore();
    const send = vi.fn();
    const app = createApp({ eventStore, config, queue: { send }, webhookSecret: SECRET });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { id: 'evt-1', transactionId: 'txn-9' } }),
    });

    expect(res.status).toBe(401);
    expect(eventStore.upsertEvent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a POST with a wrong secret with 401', async () => {
    const app = createApp({ eventStore: fakeEventStore(), config, queue: { send: vi.fn() }, webhookSecret: SECRET });

    const res = await app.request('/webhooks/funraise/transaction?secret=wrong', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { id: 'evt-1', transactionId: 'txn-9' } }),
    });

    expect(res.status).toBe(401);
  });

  it('fails closed with 401 when no secret is configured, even if the request carries one', async () => {
    const eventStore = fakeEventStore();
    const app = createApp({ eventStore, config, queue: { send: vi.fn() }, webhookSecret: undefined });

    const res = await app.request(`/webhooks/funraise/transaction?secret=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { id: 'evt-1', transactionId: 'txn-9' } }),
    });

    expect(res.status).toBe(401);
    expect(eventStore.upsertEvent).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated handshake attempt instead of echoing x-hook-secret', async () => {
    const app = createApp({ eventStore: fakeEventStore(), config, queue: { send: vi.fn() }, webhookSecret: SECRET });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      headers: { 'x-hook-secret': 'shake' },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('x-hook-secret')).toBeNull();
  });

  it('still processes a valid event delivery that carries an x-hook-secret header', async () => {
    const eventStore = fakeEventStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ eventStore, config, queue: { send }, webhookSecret: SECRET });

    const res = await app.request(`/webhooks/funraise/transaction?secret=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hook-secret': 'per-delivery' },
      body: JSON.stringify({ data: { id: 'evt-1', transactionId: 'txn-9', amount: 25 } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(eventStore.upsertEvent).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ entityType: 'transaction', entityId: 'txn-9' });
  });

  it('echoes x-hook-secret when authorized and the body is not a valid event payload', async () => {
    const eventStore = fakeEventStore();
    const app = createApp({ eventStore, config, queue: { send: vi.fn() }, webhookSecret: SECRET });

    const res = await app.request(`/webhooks/funraise/transaction?secret=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hook-secret': 'shake' },
      body: JSON.stringify({ hello: 'not an event' }), // no "id" — non-event shape
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-hook-secret')).toBe('shake');
    expect(eventStore.upsertEvent).not.toHaveBeenCalled();
  });

  it('leaves GET /health unauthenticated', async () => {
    const app = createApp({ eventStore: fakeEventStore(), config, queue: { send: vi.fn() }, webhookSecret: SECRET });

    const res = await app.request('/health');

    expect(res.status).toBe(200);
  });
});

describe('validation-failure observability', () => {
  it('logs a validation failure so a payload-shape change is visible in observability', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createApp({ eventStore: fakeEventStore(), config, queue: { send: vi.fn() }, webhookSecret: SECRET });

      const res = await postEvent(app, { data: { amount: 100 } }); // missing "data.id"

      expect(res.status).toBe(200);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('missing a non-empty "data.id"'));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('redelivery of a stranded event', () => {
  it('re-enqueues a duplicate delivery whose row never reached the queue (failed)', async () => {
    const eventStore = fakeEventStore({
      upsertEvent: vi.fn().mockResolvedValue('duplicate'),
      getEventByEntity: vi.fn().mockResolvedValue({ status: 'failed' }),
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ eventStore, config, queue: { send }, webhookSecret: SECRET });

    const res = await postEvent(app, { data: { id: 'evt-1', transactionId: 'txn-9' } });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ entityType: 'transaction', entityId: 'txn-9' });
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-9', 'queued');
  });

  it('re-enqueues a duplicate delivery stuck at received (inserted but never enqueued)', async () => {
    const eventStore = fakeEventStore({
      upsertEvent: vi.fn().mockResolvedValue('duplicate'),
      getEventByEntity: vi.fn().mockResolvedValue({ status: 'received' }),
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ eventStore, config, queue: { send }, webhookSecret: SECRET });

    await postEvent(app, { data: { id: 'evt-1', transactionId: 'txn-9' } });

    expect(send).toHaveBeenCalledWith({ entityType: 'transaction', entityId: 'txn-9' });
  });

  it('still short-circuits a duplicate delivery that is already queued or written', async () => {
    const eventStore = fakeEventStore({
      upsertEvent: vi.fn().mockResolvedValue('duplicate'),
      getEventByEntity: vi.fn().mockResolvedValue({ status: 'written' }),
    });
    const send = vi.fn();
    const app = createApp({ eventStore, config, queue: { send }, webhookSecret: SECRET });

    const res = await postEvent(app, { data: { id: 'evt-1', transactionId: 'txn-9' } });

    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(send).not.toHaveBeenCalled();
  });
});
