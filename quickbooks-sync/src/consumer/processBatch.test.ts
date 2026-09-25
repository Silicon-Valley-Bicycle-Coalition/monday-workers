import { describe, it, expect, vi } from 'vitest';
import { processSyncQueueBatch, retryDelaySeconds, type QueueMessageLike } from './processBatch';
import type { QbEventStore } from '../db/qbEvents';
import type { MondayEventStore } from '../db/mondayEvents';
import type { MapStore } from '../db/map';
import type { MondayClient } from '../monday/client';
import type { QuickBooksClient } from '../quickbooks/client';
import type { EntityType, MapEntry, QbEventRow, MondayEventRow, QueueMessage, QuickbooksSyncConfig } from '../types';

const config: QuickbooksSyncConfig = {
  monday: { apiUrl: 'https://api.monday.com/v2', boards: { customers: 111, invoices: 222, products: 333 } },
  quickbooks: { apiBaseUrl: 'https://quickbooks.api.intuit.com/v3/company' },
  quickbooksSync: {
    columnMap: {
      customer: { DisplayName: 'text_col' },
      invoice: { DocNumber: 'text_col', TotalAmt: 'numeric_col' },
      product: { Name: 'text_col' },
    },
    itemNameField: { customer: 'DisplayName', invoice: 'DocNumber', product: 'Name' },
    linkColumn: { invoice: 'connect_col' },
    customerCreateFieldMap: { text_col: 'DisplayName' },
  },
};

function qbEventRow(overrides: Partial<QbEventRow> = {}): QbEventRow {
  return {
    eventId: 'evt-1',
    entityType: 'customer',
    qbId: 'qb-1',
    fetchedPayload: null,
    pendingMondayItemId: null,
    status: 'queued',
    error: null,
    receivedAt: '2026-08-22T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function mondayEventRow(overrides: Partial<MondayEventRow> = {}): MondayEventRow {
  return {
    eventId: '42',
    mondayItemId: '42',
    rawPayload: JSON.stringify({ text_col: 'New Co' }),
    status: 'queued',
    qbId: null,
    error: null,
    receivedAt: '2026-08-22T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function fakeQbEventStore(overrides: Partial<QbEventStore> = {}): QbEventStore {
  return {
    insertEvent: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(qbEventRow()),
    ...overrides,
  };
}

function fakeMondayEventStore(overrides: Partial<MondayEventStore> = {}): MondayEventStore {
  return {
    insertEvent: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(mondayEventRow()),
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

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    createItem: vi.fn().mockResolvedValue({ id: 'item-new' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeQuickBooksClient(overrides: Partial<QuickBooksClient> = {}): QuickBooksClient {
  return {
    getEntity: vi.fn().mockResolvedValue({ Id: 'qb-1', DisplayName: 'Acme Co' }),
    createCustomer: vi.fn().mockResolvedValue({ id: 'qb-new' }),
    ...overrides,
  };
}

function fakeMessage(message: QueueMessage): QueueMessageLike<QueueMessage> & { ack: any; retry: any } {
  return { body: message, ack: vi.fn(), retry: vi.fn() };
}

describe('processSyncQueueBatch — qb-to-monday', () => {
  it('creates a new Monday item and records the mapping when none exists yet', async () => {
    const qbEventStore = fakeQbEventStore();
    const mapStore = fakeMapStore();
    const createItem = vi.fn().mockResolvedValue({ id: 'item-1' });
    const mondayClient = fakeMondayClient({ createItem });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore,
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(createItem).toHaveBeenCalledWith(111, 'Acme Co', { text_col: 'Acme Co' });
    expect(mapStore.createMapping).toHaveBeenCalledWith({
      entityType: 'customer',
      qbId: 'qb-1',
      mondayItemId: 'item-1',
      mondayBoardId: 111,
      createdAt: expect.any(String),
    });
    expect(qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'written', {
      writtenAt: expect.any(String),
      fetchedPayload: JSON.stringify({ Id: 'qb-1', DisplayName: 'Acme Co' }),
    });
    expect(message.ack).toHaveBeenCalled();
  });

  // #33: the webhook used to capture the entity at notification time and the consumer wrote that
  // snapshot, so a retried or delayed message could overwrite Monday with stale data. The
  // consumer now reads the entity from QuickBooks when it processes the message.
  it('fetches the entity from QuickBooks at processing time rather than using a stored snapshot', async () => {
    const qbEventStore = fakeQbEventStore({
      getEvent: vi.fn().mockResolvedValue(qbEventRow({ fetchedPayload: JSON.stringify({ Id: 'qb-1', DisplayName: 'Stale Name' }) })),
    });
    const getEntity = vi.fn().mockResolvedValue({ Id: 'qb-1', DisplayName: 'Fresh Name' });
    const createItem = vi.fn().mockResolvedValue({ id: 'item-1' });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient({ createItem }),
      quickBooksClient: fakeQuickBooksClient({ getEntity }),
      config,
    });

    expect(getEntity).toHaveBeenCalledWith('customer', 'qb-1');
    expect(createItem).toHaveBeenCalledWith(111, 'Fresh Name', { text_col: 'Fresh Name' });
  });

  it('retries the message with backoff when the QuickBooks fetch fails', async () => {
    const qbEventStore = fakeQbEventStore();
    const getEntity = vi.fn().mockRejectedValue(new Error('quickbooks API: HTTP 503 fetching customer qb-1'));
    const createItem = vi.fn();
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient({ createItem }),
      quickBooksClient: fakeQuickBooksClient({ getEntity }),
      config,
    });

    expect(createItem).not.toHaveBeenCalled();
    expect(qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', {
      error: 'quickbooks API: HTTP 503 fetching customer qb-1',
    });
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('durably records the created Monday item id before writing the mapping', async () => {
    const qbEventStore = fakeQbEventStore();
    const mapStore = fakeMapStore();
    const createItem = vi.fn().mockResolvedValue({ id: 'item-1' });
    const mondayClient = fakeMondayClient({ createItem });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore,
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    // The id lands in D1, status unchanged, before createMapping runs -- so a createMapping
    // failure leaves a row a retry can resume from instead of calling createItem again.
    expect(qbEventStore.updateStatus).toHaveBeenNthCalledWith(1, 'evt-1', 'queued', {
      pendingMondayItemId: 'item-1',
    });
    expect(qbEventStore.updateStatus).toHaveBeenNthCalledWith(2, 'evt-1', 'written', {
      writtenAt: expect.any(String),
      fetchedPayload: expect.any(String),
    });
  });

  it('resumes from a previously recorded Monday item id instead of creating a second item', async () => {
    const qbEventStore = fakeQbEventStore({
      getEvent: vi.fn().mockResolvedValue(qbEventRow({ pendingMondayItemId: 'item-from-earlier-attempt' })),
    });
    const mapStore = fakeMapStore();
    const createItem = vi.fn();
    const mondayClient = fakeMondayClient({ createItem });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore,
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(createItem).not.toHaveBeenCalled();
    expect(mapStore.createMapping).toHaveBeenCalledWith({
      entityType: 'customer',
      qbId: 'qb-1',
      mondayItemId: 'item-from-earlier-attempt',
      mondayBoardId: 111,
      createdAt: expect.any(String),
    });
    expect(message.ack).toHaveBeenCalled();
  });

  it('updates the existing Monday item instead of creating a duplicate', async () => {
    const mapStore = fakeMapStore({
      getByQbId: vi.fn().mockResolvedValue({
        entityType: 'customer',
        qbId: 'qb-1',
        mondayItemId: 'item-existing',
        mondayBoardId: 111,
        createdAt: '2026-08-22T00:00:00.000Z',
      }),
    });
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const createItem = vi.fn();
    const mondayClient = fakeMondayClient({ changeColumnValues, createItem });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore: fakeMondayEventStore(),
      mapStore,
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', { text_col: 'Acme Co', name: 'Acme Co' });
    expect(createItem).not.toHaveBeenCalled();
    expect(mapStore.createMapping).not.toHaveBeenCalled();
  });

  it('renames the Monday item when the QuickBooks name field has changed', async () => {
    const qbEventStore = fakeQbEventStore();
    const quickBooksClient = fakeQuickBooksClient({
      getEntity: vi.fn().mockResolvedValue({ Id: 'qb-1', DisplayName: 'Acme Co (renamed)' }),
    });
    const mapStore = fakeMapStore({
      getByQbId: vi.fn().mockResolvedValue({
        entityType: 'customer',
        qbId: 'qb-1',
        mondayItemId: 'item-existing',
        mondayBoardId: 111,
        createdAt: '2026-08-22T00:00:00.000Z',
      }),
    });
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient = fakeMondayClient({ changeColumnValues });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore,
      mondayClient,
      quickBooksClient,
      config,
    });

    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', {
      text_col: 'Acme Co (renamed)',
      name: 'Acme Co (renamed)',
    });
  });

  it('links an invoice to its customer via qb_monday_map when the customer is already mapped', async () => {
    const qbEventStore = fakeQbEventStore({
      getEvent: vi.fn().mockResolvedValue(
        qbEventRow({ entityType: 'invoice', qbId: 'inv-1' })
      ),
    });
    const quickBooksClient = fakeQuickBooksClient({
      getEntity: vi.fn().mockResolvedValue({ DocNumber: '1001', TotalAmt: 250, CustomerRef: { value: 'qb-1' } }),
    });
    const mapStore = fakeMapStore({
      getByQbId: vi.fn(async (entityType: EntityType, qbId: string): Promise<MapEntry | null> => {
        if (entityType === 'customer' && qbId === 'qb-1') {
          return { entityType: 'customer', qbId: 'qb-1', mondayItemId: '111', mondayBoardId: 111, createdAt: '' };
        }
        return null;
      }),
    });
    const createItem = vi.fn().mockResolvedValue({ id: 'inv-item-1' });
    const mondayClient = fakeMondayClient({ createItem });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore,
      mondayClient,
      quickBooksClient,
      config,
    });

    expect(createItem).toHaveBeenCalledWith(222, '1001', {
      text_col: '1001',
      numeric_col: 250,
      connect_col: { item_ids: [111] },
    });
  });

  it('marks the qb_events row failed and retries the message on a Monday write failure', async () => {
    const qbEventStore = fakeQbEventStore();
    const mondayClient = fakeMondayClient({ createItem: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')) });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', { error: 'monday API: HTTP 500' });
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('fails and retries when the qb_events row is missing', async () => {
    const qbEventStore = fakeQbEventStore({ getEvent: vi.fn().mockResolvedValue(null) });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'missing-evt' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(message.retry).toHaveBeenCalled();
    expect(qbEventStore.updateStatus).toHaveBeenCalledWith('missing-evt', 'failed', { error: expect.any(String) });
  });
});

describe('processSyncQueueBatch — monday-to-qb', () => {
  it('creates a QuickBooks customer and records the new mapping', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const mapStore = fakeMapStore();
    const createCustomer = vi.fn().mockResolvedValue({ id: 'qb-new' });
    const quickBooksClient = fakeQuickBooksClient({ createCustomer });
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore,
      mondayClient: fakeMondayClient(),
      quickBooksClient,
      config,
    });

    expect(createCustomer).toHaveBeenCalledWith({ DisplayName: 'New Co' });
    expect(mapStore.createMapping).toHaveBeenCalledWith({
      entityType: 'customer',
      qbId: 'qb-new',
      mondayItemId: '42',
      mondayBoardId: 111,
      createdAt: expect.any(String),
    });
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'written', {
      qbId: 'qb-new',
      writtenAt: expect.any(String),
    });
    expect(message.ack).toHaveBeenCalled();
  });

  it('marks the monday_events row failed and retries on a QuickBooks create failure', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const quickBooksClient = fakeQuickBooksClient({
      createCustomer: vi.fn().mockRejectedValue(new Error('quickbooks API: HTTP 500 creating customer')),
    });
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient,
      config,
    });

    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', {
      error: 'quickbooks API: HTTP 500 creating customer',
    });
    expect(message.retry).toHaveBeenCalled();
  });

  it('persists the new QuickBooks id in its own write before recording the mapping', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    // The id lands in D1 as 'fetched' before createMapping runs, so a failure in any later step
    // leaves a row a retry can resume from instead of creating a second QuickBooks Customer.
    expect(mondayEventStore.updateStatus).toHaveBeenNthCalledWith(1, '42', 'fetched', { qbId: 'qb-new' });
    expect(mondayEventStore.updateStatus).toHaveBeenNthCalledWith(2, '42', 'written', {
      qbId: 'qb-new',
      writtenAt: expect.any(String),
    });
  });

  it('does not create a second QuickBooks customer when a retry resumes a row that already has a qbId', async () => {
    const mondayEventStore = fakeMondayEventStore({
      getEvent: vi.fn().mockResolvedValue(mondayEventRow({ status: 'fetched', qbId: 'qb-already-created' })),
    });
    const mapStore = fakeMapStore();
    const createCustomer = vi.fn();
    const quickBooksClient = fakeQuickBooksClient({ createCustomer });
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore,
      mondayClient: fakeMondayClient(),
      quickBooksClient,
      config,
    });

    expect(createCustomer).not.toHaveBeenCalled();
    expect(mapStore.createMapping).toHaveBeenCalledWith({
      entityType: 'customer',
      qbId: 'qb-already-created',
      mondayItemId: '42',
      mondayBoardId: 111,
      createdAt: expect.any(String),
    });
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'written', {
      qbId: 'qb-already-created',
      writtenAt: expect.any(String),
    });
    expect(message.ack).toHaveBeenCalled();
  });

  it('fails and retries when the monday_events row is missing', async () => {
    const mondayEventStore = fakeMondayEventStore({ getEvent: vi.fn().mockResolvedValue(null) });
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: 'missing-item' });

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(message.retry).toHaveBeenCalled();
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('missing-item', 'failed', { error: expect.any(String) });
  });
});

// #33: retries were immediate, so a Monday or QuickBooks outage of a few seconds burned all three
// attempts at once and dead-lettered the change. They now back off by attempt number.
describe('retry backoff', () => {
  it("grows by attempt: 1 min, 4 min, 16 min, capped at Queues' 12 h maximum", () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(240);
    expect(retryDelaySeconds(3)).toBe(960);
    expect(retryDelaySeconds(20)).toBe(43200);
  });

  it('treats a missing or nonsensical attempt count as the first attempt', () => {
    expect(retryDelaySeconds(undefined)).toBe(60);
    expect(retryDelaySeconds(0)).toBe(60);
    expect(retryDelaySeconds(Number.NaN)).toBe(60);
  });

  it('retries a failed message with the delay for its attempt number', async () => {
    const mondayClient = fakeMondayClient({ createItem: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')) });
    const message = { ...fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' }), attempts: 2 };

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
  });

  it('still retries the message (with backoff) when recording the failure in D1 also fails', async () => {
    const qbEventStore = fakeQbEventStore({
      getEvent: vi.fn().mockRejectedValue(new Error('D1_ERROR: overloaded')),
      updateStatus: vi.fn().mockRejectedValue(new Error('D1_ERROR: overloaded')),
    });
    const message = { ...fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' }), attempts: 1 };

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });
});
