import { describe, it, expect, vi } from 'vitest';
import { createQbWebhookApp, type QueueLike } from './route';
import type { QbEventStore } from '../../db/qbEvents';
import type { QbEventRow } from '../../types';

function qbEventRow(overrides: Partial<QbEventRow> = {}): QbEventRow {
  return {
    eventId: '123:Customer:60:2026-08-22T00:00:00.000Z',
    entityType: 'customer',
    qbId: '60',
    fetchedPayload: null,
    pendingMondayItemId: null,
    status: 'received',
    error: null,
    receivedAt: '2026-08-22T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function fakeEventStore(overrides: Partial<QbEventStore> = {}): QbEventStore {
  return {
    insertEvent: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(null),
    markMondayCreateStarted: vi.fn(),
    findByPendingMondayItemId: vi.fn(),
    hasMondayCreateInFlight: vi.fn(),
    ...overrides,
  };
}

const verifierToken = 'test-verifier-token';

async function signedBody(payload: unknown): Promise<{ body: string; signature: string }> {
  const body = JSON.stringify(payload);
  const signature = await verifyQbSignatureHelper(body);
  return { body, signature };
}

// Reuses the exact algorithm verifyQbSignature checks against, so tests sign requests the same way Intuit would.
async function verifyQbSignatureHelper(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(verifierToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));
}

const notificationPayload = {
  eventNotifications: [
    {
      realmId: '123',
      dataChangeEvent: {
        entities: [{ name: 'Customer', id: '60', operation: 'Update', lastUpdated: '2026-08-22T00:00:00.000Z' }],
      },
    },
  ],
};

describe('createQbWebhookApp', () => {
  function app(eventStore: QbEventStore, queue: QueueLike, connectedRealmId: string | null = '123') {
    return createQbWebhookApp({
      qbEventStore: eventStore,
      queue,
      verifierToken,
      connectedRealmId: async () => connectedRealmId,
    });
  }

  async function post(
    eventStore: QbEventStore,
    queue: QueueLike,
    payload: unknown = notificationPayload,
    connectedRealmId: string | null = '123'
  ) {
    const { body, signature } = await signedBody(payload);
    return app(eventStore, queue, connectedRealmId).request('/webhooks/quickbooks', {
      method: 'POST',
      body,
      headers: { 'intuit-signature': signature },
    });
  }

  it('rejects a request with an invalid signature', async () => {
    const eventStore = fakeEventStore();
    const res = await app(eventStore, { send: vi.fn() }).request('/webhooks/quickbooks', {
      method: 'POST',
      body: JSON.stringify(notificationPayload),
      headers: { 'intuit-signature': 'wrong-signature' },
    });

    expect(res.status).toBe(401);
    expect(eventStore.insertEvent).not.toHaveBeenCalled();
  });

  // #33: the webhook used to fetch the entity inline and answer 200 even when that failed, so
  // Intuit never redelivered and the change was lost. It now only records and enqueues; the
  // consumer fetches (with queue retries and a DLQ behind it).
  it('records and enqueues a new notification without calling QuickBooks', async () => {
    const eventStore = fakeEventStore();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };

    const res = await post(eventStore, queue);

    expect(res.status).toBe(200);
    expect(eventStore.insertEvent).toHaveBeenCalledWith({
      eventId: '123:Customer:60:2026-08-22T00:00:00.000Z',
      entityType: 'customer',
      qbId: '60',
      receivedAt: expect.any(String),
    });
    expect(queue.send).toHaveBeenCalledWith({ direction: 'qb-to-monday', eventId: '123:Customer:60:2026-08-22T00:00:00.000Z' });
    expect(eventStore.updateStatus).toHaveBeenCalledWith('123:Customer:60:2026-08-22T00:00:00.000Z', 'queued');
  });

  it('short-circuits on a duplicate notification whose row already reached the queue', async () => {
    const eventStore = fakeEventStore({
      insertEvent: vi.fn().mockResolvedValue('duplicate'),
      getEvent: vi.fn().mockResolvedValue(qbEventRow({ status: 'queued' })),
    });
    const queue = { send: vi.fn() };

    const res = await post(eventStore, queue);

    expect(res.status).toBe(200);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('resumes a duplicate notification whose row never reached the queue', async () => {
    // The row exists in a pre-queue state because a prior delivery died between the insert and
    // the enqueue. Skipping it here would lose the change permanently.
    for (const status of ['received', 'fetched', 'failed'] as const) {
      const eventStore = fakeEventStore({
        insertEvent: vi.fn().mockResolvedValue('duplicate'),
        getEvent: vi.fn().mockResolvedValue(qbEventRow({ status })),
      });
      const queue = { send: vi.fn().mockResolvedValue(undefined) };

      const res = await post(eventStore, queue);

      expect(res.status).toBe(200);
      expect(queue.send, `status ${status}`).toHaveBeenCalledWith({
        direction: 'qb-to-monday',
        eventId: '123:Customer:60:2026-08-22T00:00:00.000Z',
      });
      expect(eventStore.updateStatus, `status ${status}`).toHaveBeenCalledWith(
        '123:Customer:60:2026-08-22T00:00:00.000Z',
        'queued'
      );
    }
  });

  it('answers 500 when the enqueue fails, so Intuit redelivers, and marks the row resumable', async () => {
    const eventStore = fakeEventStore();
    const queue = { send: vi.fn().mockRejectedValue(new Error('queue unavailable')) };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(eventStore, queue);

    expect(res.status).toBe(500);
    expect(eventStore.updateStatus).toHaveBeenCalledWith('123:Customer:60:2026-08-22T00:00:00.000Z', 'failed', {
      error: 'queue unavailable',
    });
    expect(eventStore.updateStatus).not.toHaveBeenCalledWith('123:Customer:60:2026-08-22T00:00:00.000Z', 'queued');
    errorSpy.mockRestore();
  });

  it('still enqueues the other notifications in the payload when one enqueue fails', async () => {
    const payload = {
      eventNotifications: [
        {
          realmId: '123',
          dataChangeEvent: {
            entities: [
              { name: 'Customer', id: '60', operation: 'Update', lastUpdated: '2026-08-22T00:00:00.000Z' },
              { name: 'Invoice', id: '7', operation: 'Create', lastUpdated: '2026-08-22T00:00:01.000Z' },
            ],
          },
        },
      ],
    };
    const eventStore = fakeEventStore();
    const queue = { send: vi.fn().mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValue(undefined) };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(eventStore, queue, payload);

    expect(res.status).toBe(500);
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(eventStore.updateStatus).toHaveBeenCalledWith('123:Invoice:7:2026-08-22T00:00:01.000Z', 'queued');
    vi.restoreAllMocks();
  });

  // #33: the consumer fetches every entity from the connected company, so a notification for a
  // different company (another realm connected to the same Intuit app) would sync whatever
  // record happens to share its id in ours.
  it('ignores notifications for a company other than the connected one', async () => {
    const eventStore = fakeEventStore();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await post(eventStore, queue, notificationPayload, 'some-other-realm');

    expect(res.status).toBe(200);
    expect(eventStore.insertEvent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('realm "123"'));
    warnSpy.mockRestore();
  });

  it('keeps the matching notifications from a payload that mixes companies', async () => {
    const payload = {
      eventNotifications: [
        notificationPayload.eventNotifications[0],
        {
          realmId: '999',
          dataChangeEvent: {
            entities: [{ name: 'Customer', id: '61', operation: 'Update', lastUpdated: '2026-08-22T00:00:00.000Z' }],
          },
        },
      ],
    };
    const eventStore = fakeEventStore();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await post(eventStore, queue, payload);

    expect(res.status).toBe(200);
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith({ direction: 'qb-to-monday', eventId: '123:Customer:60:2026-08-22T00:00:00.000Z' });
    vi.restoreAllMocks();
  });

  it('answers 503 (so Intuit redelivers) while no company is connected yet', async () => {
    const eventStore = fakeEventStore();
    const queue = { send: vi.fn() };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(eventStore, queue, notificationPayload, null);

    expect(res.status).toBe(503);
    expect(eventStore.insertEvent).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
