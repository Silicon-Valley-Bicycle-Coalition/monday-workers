import { describe, it, expect, vi } from 'vitest';
import { processSyncQueueBatch, type QueueMessageLike } from './processBatch';
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
    fetchedPayload: JSON.stringify({ Id: 'qb-1', DisplayName: 'Acme Co' }),
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
    getEntity: vi.fn(),
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
    expect(qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'written', { writtenAt: expect.any(String) });
    expect(message.ack).toHaveBeenCalled();
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

    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', { text_col: 'Acme Co' });
    expect(createItem).not.toHaveBeenCalled();
    expect(mapStore.createMapping).not.toHaveBeenCalled();
  });

  it('links an invoice to its customer via qb_monday_map when the customer is already mapped', async () => {
    const qbEventStore = fakeQbEventStore({
      getEvent: vi.fn().mockResolvedValue(
        qbEventRow({
          entityType: 'invoice',
          qbId: 'inv-1',
          fetchedPayload: JSON.stringify({ DocNumber: '1001', TotalAmt: 250, CustomerRef: { value: 'qb-1' } }),
        })
      ),
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
      quickBooksClient: fakeQuickBooksClient(),
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
