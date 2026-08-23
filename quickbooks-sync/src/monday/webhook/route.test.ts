import { describe, it, expect, vi } from 'vitest';
import { createMondayWebhookApp } from './route';
import type { MondayEventStore } from '../../db/mondayEvents';
import type { MapStore } from '../../db/map';
import type { MondayEventRow, QuickbooksSyncConfig } from '../../types';

function mondayEventRow(overrides: Partial<MondayEventRow> = {}): MondayEventRow {
  return {
    eventId: '42',
    mondayItemId: '42',
    rawPayload: '{}',
    status: 'received',
    qbId: null,
    error: null,
    receivedAt: '2026-08-22T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

const config: QuickbooksSyncConfig = {
  monday: { apiUrl: 'https://api.monday.com/v2', boards: { customers: 789, invoices: null, products: null } },
  quickbooksSync: {
    columnMap: { customer: {}, invoice: {}, product: {} },
    itemNameField: { customer: 'DisplayName', invoice: 'DocNumber', product: 'Name' },
    linkColumn: { invoice: 'connect_col' },
    customerCreateFieldMap: {},
  },
};

function fakeMondayEventStore(overrides: Partial<MondayEventStore> = {}): MondayEventStore {
  return {
    insertEvent: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function fakeMapStore(overrides: Partial<MapStore> = {}): MapStore {
  return {
    getByQbId: vi.fn().mockResolvedValue(null),
    getByMondayItemId: vi.fn().mockResolvedValue(null),
    createMapping: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createMondayWebhookApp', () => {
  it('echoes the challenge on subscription verification', async () => {
    const app = createMondayWebhookApp({
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      queue: { send: vi.fn() },
      config,
    });

    const res = await app.request('/webhooks/monday', {
      method: 'POST',
      body: JSON.stringify({ challenge: 'abc123' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('ignores an event from a board other than the configured Customers board', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const app = createMondayWebhookApp({
      mondayEventStore,
      mapStore: fakeMapStore(),
      queue: { send: vi.fn() },
      config,
    });

    const res = await app.request('/webhooks/monday', {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 1, boardId: 999 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect((await res.json<{ ignored: boolean }>()).ignored).toBe(true);
    expect(mondayEventStore.insertEvent).not.toHaveBeenCalled();
  });

  it('skips an item already linked in qb_monday_map instead of queueing an update', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const mapStore = fakeMapStore({
      getByMondayItemId: vi.fn().mockResolvedValue({
        entityType: 'customer',
        qbId: 'qb-1',
        mondayItemId: '1',
        mondayBoardId: 789,
        createdAt: '2026-08-22T00:00:00.000Z',
      }),
    });
    const queue = { send: vi.fn() };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore, queue, config });

    const res = await app.request('/webhooks/monday', {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 1, boardId: 789 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect((await res.json<{ alreadyLinked: boolean }>()).alreadyLinked).toBe(true);
    expect(mondayEventStore.insertEvent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('dedupes and enqueues a genuinely new Customer item', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore: fakeMapStore(), queue, config });

    const res = await app.request('/webhooks/monday', {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 42, boardId: 789, columnValues: { text_col: 'New Co' } } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(mondayEventStore.insertEvent).toHaveBeenCalledWith({
      eventId: '42',
      mondayItemId: '42',
      rawPayload: JSON.stringify({ text_col: 'New Co' }),
      receivedAt: expect.any(String),
    });
    expect(queue.send).toHaveBeenCalledWith({ direction: 'monday-to-qb', eventId: '42' });
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'queued');
  });

  it('short-circuits on a duplicate item event whose row already reached the queue', async () => {
    const mondayEventStore = fakeMondayEventStore({
      insertEvent: vi.fn().mockResolvedValue('duplicate'),
      getEvent: vi.fn().mockResolvedValue(mondayEventRow({ status: 'queued' })),
    });
    const queue = { send: vi.fn() };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore: fakeMapStore(), queue, config });

    const res = await app.request('/webhooks/monday', {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 42, boardId: 789 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect((await res.json<{ duplicate: boolean }>()).duplicate).toBe(true);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('resumes a duplicate item event whose row never reached the queue', async () => {
    // The row exists in a pre-queue state because a prior delivery died between the insert and
    // the enqueue. Skipping it here would lose the new Customer permanently.
    for (const status of ['received', 'fetched', 'failed'] as const) {
      const mondayEventStore = fakeMondayEventStore({
        insertEvent: vi.fn().mockResolvedValue('duplicate'),
        getEvent: vi.fn().mockResolvedValue(mondayEventRow({ status })),
      });
      const queue = { send: vi.fn().mockResolvedValue(undefined) };
      const app = createMondayWebhookApp({ mondayEventStore, mapStore: fakeMapStore(), queue, config });

      const res = await app.request('/webhooks/monday', {
        method: 'POST',
        body: JSON.stringify({ event: { pulseId: 42, boardId: 789 } }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(200);
      expect((await res.json<{ resumed: boolean }>()).resumed, `status ${status}`).toBe(true);
      expect(queue.send, `status ${status}`).toHaveBeenCalledWith({ direction: 'monday-to-qb', eventId: '42' });
      expect(mondayEventStore.updateStatus, `status ${status}`).toHaveBeenCalledWith('42', 'queued');
    }
  });

  it('returns a recorded error at HTTP 200 for a malformed JSON body instead of crashing', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const queue = { send: vi.fn() };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore: fakeMapStore(), queue, config });

    const res = await app.request('/webhooks/monday', {
      method: 'POST',
      body: 'not json at all{',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const json = await res.json<{ ok: boolean; error: string }>();
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe('string');
    expect(mondayEventStore.insertEvent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });
});
