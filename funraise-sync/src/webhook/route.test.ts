import { describe, it, expect, vi } from 'vitest';
import { createApp } from './route';
import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
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
    donorExternalIdField: 'donor.contactId',
    donorExternalIdColumn: 'funraise_id_col',
    donorEmailColumn: 'email_col',
    donorNameField: 'donor.name',
    donorLinkColumn: 'connect_col',
    emailFieldPrecedence: ['donor.email'],
    statusField: 'status',
    statusValueMap: {},
    doNotMigrateFields: [],
  },
};

function fakeEventStore(overrides: Partial<EventStore> = {}): EventStore {
  return {
    insertEvent: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'donor-1' }),
    createItem: vi.fn().mockResolvedValue({ id: 'donor-1' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createApp', () => {
  it('responds to GET /health with ok: true', async () => {
    const app = createApp({ eventStore: fakeEventStore(), mondayClient: fakeMondayClient(), config, queue: { send: vi.fn() } });

    const res = await app.request('/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('echoes x-hook-secret on a handshake request without touching the event store', async () => {
    const eventStore = fakeEventStore();
    const app = createApp({ eventStore, mondayClient: fakeMondayClient(), config, queue: { send: vi.fn() } });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      headers: { 'x-hook-secret': 'abc123' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-hook-secret')).toBe('abc123');
    expect(eventStore.insertEvent).not.toHaveBeenCalled();
  });

  it('rejects an unknown entity type without inserting', async () => {
    const eventStore = fakeEventStore();
    const app = createApp({ eventStore, mondayClient: fakeMondayClient(), config, queue: { send: vi.fn() } });

    const res = await app.request('/webhooks/funraise/donation', {
      method: 'POST',
      body: JSON.stringify({ id: 'evt-1' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).ok).toBe(false);
    expect(eventStore.insertEvent).not.toHaveBeenCalled();
  });

  it('dedupes, matches, and enqueues a new event', async () => {
    const eventStore = fakeEventStore();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const mondayClient = fakeMondayClient();
    const app = createApp({ eventStore, mondayClient, config, queue });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      body: JSON.stringify({ id: 'evt-1', donor: { contactId: 'fr-1' } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(eventStore.insertEvent).toHaveBeenCalledWith({
      eventId: 'evt-1',
      entityType: 'transaction',
      rawPayload: JSON.stringify({ id: 'evt-1', donor: { contactId: 'fr-1' } }),
      receivedAt: expect.any(String),
    });
    expect(eventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'matched', { matchedDonorItemId: 'donor-1' });
    expect(queue.send).toHaveBeenCalledWith({ eventId: 'evt-1' });
    expect(eventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'queued');
  });

  it('short-circuits on a duplicate event without matching or enqueueing', async () => {
    const eventStore = fakeEventStore({ insertEvent: vi.fn().mockResolvedValue('duplicate') });
    const queue = { send: vi.fn() };
    const mondayClient = fakeMondayClient();
    const app = createApp({ eventStore, mondayClient, config, queue });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      body: JSON.stringify({ id: 'evt-1' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect((await res.json() as Record<string, unknown>).duplicate).toBe(true);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('marks the event failed when matching throws, without crashing the request', async () => {
    const eventStore = fakeEventStore();
    const mondayClient = fakeMondayClient({
      findItemByColumnValue: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
    });
    const queue = { send: vi.fn() };
    const app = createApp({ eventStore, mondayClient, config, queue });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      body: JSON.stringify({ id: 'evt-1', donor: { contactId: 'fr-1' } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(eventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', { error: 'monday API: HTTP 500' });
    expect(queue.send).not.toHaveBeenCalled();
  });
});
