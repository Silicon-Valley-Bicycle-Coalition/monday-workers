import { describe, it, expect, vi } from 'vitest';
import { createApp } from './route';
import type { EventStore } from '../db/events';
import type { FunraiseSyncConfig } from '../types';

const config: FunraiseSyncConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { 'donations:live': 1, 'recurring-gifts': null, 'event-registrations': null, 'people-live': 42 },
  },
  funraiseSync: {
    columnMap: { transaction: {}, recurringGift: {}, registration: {} },
    itemNameField: {
      transaction: 'description',
      recurringGift: 'description',
      registration: 'eventName',
    },
    entityIdField: {
      transaction: 'transactionId',
      recurringGift: 'id',
      registration: 'id',
    },
    rawPayloadRetentionDays: 90,
    donorExternalIdField: 'donor.contactId',
    donorExternalIdColumn: 'funraise_id_col',
    donorEmailColumn: 'email_col',
    donorNameField: 'donor.name',
    donorLinkColumn: 'connect_col',
    emailFieldPrecedence: ['donor.email'],
    statusField: 'status',
    statusValueMap: {},
    doNotMigrateFields: ['paymentMethod.lastFour'],
  },
};

function fakeEventStore(overrides: Partial<EventStore> = {}): EventStore {
  return {
    upsertEvent: vi.fn().mockResolvedValue('inserted'),
    updateStatusByEntity: vi.fn().mockResolvedValue(undefined),
    getEventByEntity: vi.fn().mockResolvedValue(null),
    purgeWrittenPayloads: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function postEvent(app: ReturnType<typeof createApp>, body: unknown, entityType = 'transaction') {
  return app.request(`/webhooks/funraise/${entityType}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createApp', () => {
  it('responds to GET /health with ok: true', async () => {
    const app = createApp({ eventStore: fakeEventStore(), config, queue: { send: vi.fn() } });

    const res = await app.request('/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('echoes x-hook-secret on a handshake request without touching the event store', async () => {
    const eventStore = fakeEventStore();
    const app = createApp({ eventStore, config, queue: { send: vi.fn() } });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      headers: { 'x-hook-secret': 'shake' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-hook-secret')).toBe('shake');
    expect(eventStore.upsertEvent).not.toHaveBeenCalled();
  });

  it('rejects an unknown entity type without inserting', async () => {
    const eventStore = fakeEventStore();
    const app = createApp({ eventStore, config, queue: { send: vi.fn() } });

    const res = await postEvent(app, { id: 'evt-1' }, 'donation');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: expect.stringContaining('unknown entity type') });
    expect(eventStore.upsertEvent).not.toHaveBeenCalled();
  });

  it('ingests a new event with its entity id, strips denylisted PII, and enqueues by entity', async () => {
    const eventStore = fakeEventStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ eventStore, config, queue: { send } });

    const res = await postEvent(app, {
      id: 'evt-1',
      transactionId: 'txn-9',
      amount: 100,
      paymentMethod: { lastFour: '4242', brand: 'visa' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(eventStore.upsertEvent).toHaveBeenCalledWith({
      eventId: 'evt-1',
      entityType: 'transaction',
      entityId: 'txn-9',
      rawPayload: JSON.stringify({ id: 'evt-1', transactionId: 'txn-9', amount: 100, paymentMethod: { brand: 'visa' } }),
      receivedAt: expect.any(String),
    });
    expect(send).toHaveBeenCalledWith({ entityType: 'transaction', entityId: 'txn-9' });
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-9', 'queued');
  });

  it('re-enqueues when the upsert reports an update to a known entity', async () => {
    const eventStore = fakeEventStore({ upsertEvent: vi.fn().mockResolvedValue('updated') });
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ eventStore, config, queue: { send } });

    const res = await postEvent(app, { id: 'evt-2', transactionId: 'txn-9', amount: 50 });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ entityType: 'transaction', entityId: 'txn-9' });
  });

  it('short-circuits on a duplicate delivery without enqueueing', async () => {
    const eventStore = fakeEventStore({ upsertEvent: vi.fn().mockResolvedValue('duplicate') });
    const send = vi.fn();
    const app = createApp({ eventStore, config, queue: { send } });

    const res = await postEvent(app, { id: 'evt-1', transactionId: 'txn-9' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 500 when the enqueue fails, so the delivery is not falsely acknowledged', async () => {
    const eventStore = fakeEventStore();
    const send = vi.fn().mockRejectedValue(new Error('queue unavailable'));
    const app = createApp({ eventStore, config, queue: { send } });

    const res = await postEvent(app, { id: 'evt-3', transactionId: 'txn-3' });

    expect(res.status).toBe(500);
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-3', 'failed', {
      error: 'queue unavailable',
    });
  });
});
