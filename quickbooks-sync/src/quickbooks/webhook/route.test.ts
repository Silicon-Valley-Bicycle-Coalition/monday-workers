import { describe, it, expect, vi } from 'vitest';
import { createQbWebhookApp } from './route';
import { verifyQbSignature } from './validate';
import type { QbEventStore } from '../../db/qbEvents';
import type { QuickBooksClient } from '../client';

function fakeEventStore(overrides: Partial<QbEventStore> = {}): QbEventStore {
  return {
    insertEvent: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function fakeQuickBooksClient(overrides: Partial<QuickBooksClient> = {}): QuickBooksClient {
  return {
    getEntity: vi.fn().mockResolvedValue({ Id: '60', DisplayName: 'Acme' }),
    createCustomer: vi.fn(),
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
  it('rejects a request with an invalid signature', async () => {
    const eventStore = fakeEventStore();
    const app = createQbWebhookApp({
      qbEventStore: eventStore,
      quickBooksClient: fakeQuickBooksClient(),
      queue: { send: vi.fn() },
      verifierToken,
    });

    const res = await app.request('/webhooks/quickbooks', {
      method: 'POST',
      body: JSON.stringify(notificationPayload),
      headers: { 'intuit-signature': 'wrong-signature' },
    });

    expect(res.status).toBe(401);
    expect(eventStore.insertEvent).not.toHaveBeenCalled();
  });

  it('dedupes, fetches, and enqueues a new notification', async () => {
    const { body, signature } = await signedBody(notificationPayload);
    const eventStore = fakeEventStore();
    const getEntity = vi.fn().mockResolvedValue({ Id: '60', DisplayName: 'Acme' });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createQbWebhookApp({
      qbEventStore: eventStore,
      quickBooksClient: fakeQuickBooksClient({ getEntity }),
      queue,
      verifierToken,
    });

    const res = await app.request('/webhooks/quickbooks', {
      method: 'POST',
      body,
      headers: { 'intuit-signature': signature },
    });

    expect(res.status).toBe(200);
    expect(eventStore.insertEvent).toHaveBeenCalledWith({
      eventId: '123:Customer:60:2026-08-22T00:00:00.000Z',
      entityType: 'customer',
      qbId: '60',
      receivedAt: expect.any(String),
    });
    expect(getEntity).toHaveBeenCalledWith('customer', '60');
    expect(eventStore.updateStatus).toHaveBeenCalledWith(
      '123:Customer:60:2026-08-22T00:00:00.000Z',
      'fetched',
      { fetchedPayload: JSON.stringify({ Id: '60', DisplayName: 'Acme' }) }
    );
    expect(queue.send).toHaveBeenCalledWith({ direction: 'qb-to-monday', eventId: '123:Customer:60:2026-08-22T00:00:00.000Z' });
    expect(eventStore.updateStatus).toHaveBeenCalledWith('123:Customer:60:2026-08-22T00:00:00.000Z', 'queued');
  });

  it('short-circuits on a duplicate notification without fetching or enqueueing', async () => {
    const { body, signature } = await signedBody(notificationPayload);
    const eventStore = fakeEventStore({ insertEvent: vi.fn().mockResolvedValue('duplicate') });
    const getEntity = vi.fn();
    const queue = { send: vi.fn() };
    const app = createQbWebhookApp({
      qbEventStore: eventStore,
      quickBooksClient: fakeQuickBooksClient({ getEntity }),
      queue,
      verifierToken,
    });

    const res = await app.request('/webhooks/quickbooks', { method: 'POST', body, headers: { 'intuit-signature': signature } });

    expect(res.status).toBe(200);
    expect(getEntity).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('marks the event failed when the QuickBooks fetch throws, without crashing the request', async () => {
    const { body, signature } = await signedBody(notificationPayload);
    const eventStore = fakeEventStore();
    const getEntity = vi.fn().mockRejectedValue(new Error('quickbooks API: HTTP 500 fetching customer 60'));
    const queue = { send: vi.fn() };
    const app = createQbWebhookApp({
      qbEventStore: eventStore,
      quickBooksClient: fakeQuickBooksClient({ getEntity }),
      queue,
      verifierToken,
    });

    const res = await app.request('/webhooks/quickbooks', { method: 'POST', body, headers: { 'intuit-signature': signature } });

    expect(res.status).toBe(200);
    expect(eventStore.updateStatus).toHaveBeenCalledWith(
      '123:Customer:60:2026-08-22T00:00:00.000Z',
      'failed',
      { error: 'quickbooks API: HTTP 500 fetching customer 60' }
    );
    expect(queue.send).not.toHaveBeenCalled();
  });
});
