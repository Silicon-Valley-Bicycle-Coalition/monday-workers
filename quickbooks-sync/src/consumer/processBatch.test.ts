import { describe, it, expect, vi } from 'vitest';
import { consumeSyncBatch, processSyncQueueBatch, TERMINAL_PREFIX, type QueueMessageLike } from './processBatch';
import { TerminalError } from '../errors';
import { MondayApiError } from '../monday/graphql';
import type { QbEventStore } from '../db/qbEvents';
import type { MondayEventStore } from '../db/mondayEvents';
import { MappingConflictError, type MapStore } from '../db/map';
import type { MondayClient, MondayItemSnapshot } from '../monday/client';
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
    customerQbIdColumn: 'qb_id_col',
    currency: 'USD',
    payloadRetentionDays: 30,
    unresolvedRetentionDays: 90,
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
    createAttempt: 0,
    createSends: 0,
    ...overrides,
  };
}

function fakeQbEventStore(overrides: Partial<QbEventStore> = {}): QbEventStore {
  return {
    recordEvents: vi.fn(),
    markEvents: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(qbEventRow()),
    findByPendingMondayItemId: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function fakeMondayEventStore(overrides: Partial<MondayEventStore> = {}): MondayEventStore {
  return {
    insertEvent: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(mondayEventRow()),
    findByQbId: vi.fn().mockResolvedValue(null),
    markCreateSent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// The Monday item '42' as the API returns it: named, with the QuickBooks Id column empty.
function mondayItem(overrides: Partial<MondayItemSnapshot> = {}): MondayItemSnapshot {
  return {
    id: '42',
    name: 'New Co',
    state: 'active',
    boardId: '111', // the Customers board in config
    columnValues: { text_col: { text: 'New Co', value: '"New Co"' }, qb_id_col: { text: '', value: null } },
    ...overrides,
  };
}

function fakeMapStore(overrides: Partial<MapStore> = {}): MapStore {
  return {
    getByQbId: vi.fn().mockResolvedValue(null),
    getByMondayItemId: vi.fn().mockResolvedValue(null),
    createMapping: vi.fn().mockResolvedValue(undefined),
    repointMapping: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    createItem: vi.fn().mockResolvedValue({ id: 'item-new' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    getItem: vi.fn().mockResolvedValue(mondayItem()),
    findItemIdsByColumnValue: vi.fn().mockResolvedValue([]),
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

    expect(createItem).toHaveBeenCalledWith(111, 'Acme Co', { text_col: 'Acme Co', qb_id_col: 'qb-1' });
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

  // GL#33: the webhook used to capture the entity at notification time and the consumer wrote that
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
    expect(createItem).toHaveBeenCalledWith(111, 'Fresh Name', { text_col: 'Fresh Name', qb_id_col: 'qb-1' });
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

    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', { text_col: 'Acme Co', qb_id_col: 'qb-1', name: 'Acme Co' });
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
      qb_id_col: 'qb-1',
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

  describe('currency (#76)', () => {
    async function syncInvoice(record: Record<string, unknown>) {
      const qbEventStore = fakeQbEventStore({ getEvent: vi.fn().mockResolvedValue(qbEventRow({ entityType: 'invoice', qbId: 'inv-1' })) });
      const mondayClient = fakeMondayClient({ createItem: vi.fn().mockResolvedValue({ id: 'inv-item-1' }) });
      const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await processSyncQueueBatch([message], {
          qbEventStore,
          mondayEventStore: fakeMondayEventStore(),
          mapStore: fakeMapStore(),
          mondayClient,
          quickBooksClient: fakeQuickBooksClient({ getEntity: vi.fn().mockResolvedValue(record) }),
          config,
        });
      } finally {
        error.mockRestore();
      }
      return { qbEventStore, mondayClient, message };
    }

    it('fails an invoice in another currency terminally, writing nothing to Monday', async () => {
      const { qbEventStore, mondayClient, message } = await syncInvoice({ DocNumber: '1001', TotalAmt: 250, CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' } });
      expect(mondayClient.createItem).not.toHaveBeenCalled();
      expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
      expect(qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', { error: expect.stringMatching(new RegExp(`^${TERMINAL_PREFIX}QuickBooks invoice inv-1 is in CAD, not USD`)) });
      expect(message.ack).toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
    });

    it('writes a record in the home currency, or with no CurrencyRef at all', async () => {
      for (const record of [{ DocNumber: '1001', TotalAmt: 250, CurrencyRef: { value: 'USD' } }, { DocNumber: '1001', TotalAmt: 250 }]) {
        const { mondayClient, message } = await syncInvoice(record);
        expect(mondayClient.createItem).toHaveBeenCalledWith(222, '1001', { text_col: '1001', numeric_col: 250 });
        expect(message.ack).toHaveBeenCalled();
      }
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

    // requestid makes QuickBooks answer a repeat of this create with the original Customer.
    expect(createCustomer).toHaveBeenCalledWith({ DisplayName: 'New Co' }, 'monday-item-42');
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

  // GL#33: a staff-typed Customer arrives as a create_pulse whose name is the item name and whose
  // columns are raw Monday shapes; both used to reach QuickBooks unmapped and 400.
  // GL#33 review: fields come from the item as it stands now (re-read from Monday), not the
  // create_pulse payload stored at webhook time — so fixing the item in Monday and redriving works.
  it('creates the customer from the re-read item, not the stored webhook payload', async () => {
    const withName: QuickbooksSyncConfig = {
      ...config,
      quickbooksSync: { ...config.quickbooksSync, customerCreateFieldMap: { name: 'DisplayName', email_col: 'PrimaryEmailAddr.Address' } },
    };
    const mondayEventStore = fakeMondayEventStore({
      getEvent: vi.fn().mockResolvedValue(mondayEventRow({ rawPayload: JSON.stringify({ name: 'Stale Name' }) })),
    });
    const mondayClient = fakeMondayClient({
      getItem: vi.fn().mockResolvedValue(
        mondayItem({
          name: 'Staff Typed Co',
          columnValues: { email_col: { text: 'ap@staff.test', value: '{"email":"ap@staff.test","text":"AP"}' }, qb_id_col: { text: '', value: null } },
        })
      ),
    });
    const createCustomer = vi.fn().mockResolvedValue({ id: 'qb-new' });

    await processSyncQueueBatch([fakeMessage({ direction: 'monday-to-qb', eventId: '42' })], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore: fakeMapStore(),
      mondayClient,
      quickBooksClient: fakeQuickBooksClient({ createCustomer }),
      config: withName,
    });

    expect(createCustomer.mock.calls[0]![0]).toEqual({ DisplayName: 'Staff Typed Co', PrimaryEmailAddr: { Address: 'ap@staff.test' } });
  });

  it('uses a fresh requestid after a terminal failure, so a redrive is not answered with the cached failure', async () => {
    const createCustomer = vi.fn().mockResolvedValue({ id: 'qb-new' });
    const mondayEventStore = fakeMondayEventStore({
      getEvent: vi.fn().mockResolvedValue(mondayEventRow({ status: 'failed', createAttempt: 2 })),
    });

    await processSyncQueueBatch([fakeMessage({ direction: 'monday-to-qb', eventId: '42' })], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient: fakeQuickBooksClient({ createCustomer }),
      config,
    });

    expect(createCustomer).toHaveBeenCalledWith({ DisplayName: 'New Co' }, 'monday-item-42-r2');
  });

  // GL#33 second review: attempt 1's create committed but its response was lost; a later attempt
  // is rejected (e.g. 6240 Duplicate Name — possibly against that very Customer). Advancing the
  // requestid then would let a rename-and-redrive create a second Customer.
  it('counts each send, and after an unanswered earlier send keeps the requestid and says what to check', async () => {
    const mondayEventStore = fakeMondayEventStore({
      getEvent: vi.fn().mockResolvedValue(mondayEventRow({ status: 'failed', createSends: 1 })),
    });
    const createCustomer = vi.fn().mockRejectedValue(new TerminalError('quickbooks API: HTTP 400 creating customer — ValidationFault 6240 Duplicate Name Exists Error'));
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient: fakeQuickBooksClient({ createCustomer }),
      config,
    });

    expect(mondayEventStore.markCreateSent).toHaveBeenCalledWith('42');
    expect((mondayEventStore.markCreateSent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!).toBeLessThan(createCustomer.mock.invocationCallOrder[0]!);
    expect(message.ack).toHaveBeenCalled();
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', {
      error: expect.stringMatching(/6240 Duplicate Name.*may have succeeded.*Search QuickBooks Customers for "New Co"/),
    });
    vi.restoreAllMocks();
  });

  it('advances the requestid on a rejection when every earlier send was answered', async () => {
    const mondayEventStore = fakeMondayEventStore(); // createSends 0: this is the first send
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient: fakeQuickBooksClient({ createCustomer: vi.fn().mockRejectedValue(new TerminalError('6240 Duplicate Name')) }),
      config,
    });

    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', { error: `${TERMINAL_PREFIX}6240 Duplicate Name`, bumpCreateAttempt: true });
    vi.restoreAllMocks();
  });

  it('refuses to send QuickBooks a customer with no name, naming the problem', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const mondayClient = fakeMondayClient({
      getItem: vi.fn().mockResolvedValue(mondayItem({ name: '', columnValues: { text_col: { text: '', value: null } } })),
    });
    const createCustomer = vi.fn();
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore: fakeMapStore(),
      mondayClient,
      quickBooksClient: fakeQuickBooksClient({ createCustomer }),
      config,
    });

    expect(createCustomer).not.toHaveBeenCalled();
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', { error: expect.stringMatching(/no name/), bumpCreateAttempt: true });
    vi.restoreAllMocks();
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

// GL#33: the create loop. A QuickBooks-originated Customer is created on Monday before its mapping
// exists; Monday's create_pulse webhook can arrive in between, miss the mapping check, and turn
// the item back into a duplicate QuickBooks Customer (or a 400 on the duplicate DisplayName).
describe('create-loop guard', () => {
  const deps = (overrides: Partial<Parameters<typeof processSyncQueueBatch>[1]> = {}) => ({
    qbEventStore: fakeQbEventStore(),
    mondayEventStore: fakeMondayEventStore(),
    mapStore: fakeMapStore(),
    mondayClient: fakeMondayClient(),
    quickBooksClient: fakeQuickBooksClient(),
    config,
    ...overrides,
  });

  it('stamps the QuickBooks Id on the Monday item in the create_item call itself', async () => {
    const createItem = vi.fn().mockResolvedValue({ id: 'item-1' });

    await processSyncQueueBatch([fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' })], deps({ mondayClient: fakeMondayClient({ createItem }) }));

    expect(createItem).toHaveBeenCalledWith(111, 'Acme Co', { text_col: 'Acme Co', qb_id_col: 'qb-1' });
  });

  it('keeps the QuickBooks Id column on updates too (backfills older items)', async () => {
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mapStore = fakeMapStore({
      getByQbId: vi.fn().mockResolvedValue({ entityType: 'customer', qbId: 'qb-1', mondayItemId: 'item-x', mondayBoardId: 111, createdAt: '' }),
    });

    await processSyncQueueBatch([fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' })], deps({ mapStore, mondayClient: fakeMondayClient({ changeColumnValues }) }));

    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-x', { text_col: 'Acme Co', qb_id_col: 'qb-1', name: 'Acme Co' });
  });

  it("finds its own earlier item by the QuickBooks Id column when create_item's response was lost", async () => {
    const createItem = vi.fn();
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mapStore = fakeMapStore();
    const mondayClient = fakeMondayClient({ createItem, changeColumnValues, findItemIdsByColumnValue: vi.fn().mockResolvedValue(['item-lost']) });

    await processSyncQueueBatch([fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' })], deps({ mapStore, mondayClient }));

    expect(mondayClient.findItemIdsByColumnValue).toHaveBeenCalledWith(111, 'qb_id_col', 'qb-1');
    expect(createItem).not.toHaveBeenCalled();
    expect(mapStore.createMapping).toHaveBeenCalledWith(expect.objectContaining({ qbId: 'qb-1', mondayItemId: 'item-lost' }));
    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-lost', expect.objectContaining({ qb_id_col: 'qb-1' }));
  });

  // Review #5: a Customer created from Monday whose mapping write failed; QuickBooks' own webhook
  // for that new Customer must not make a second Monday item.
  it('links a Customer created from a Monday item to that item instead of creating another', async () => {
    const createItem = vi.fn();
    const mapStore = fakeMapStore();
    const mondayEventStore = fakeMondayEventStore({
      findByQbId: vi.fn().mockResolvedValue(mondayEventRow({ mondayItemId: '42', qbId: 'qb-1', status: 'failed' })),
    });

    await processSyncQueueBatch([fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' })], deps({ mapStore, mondayEventStore, mondayClient: fakeMondayClient({ createItem }) }));

    expect(createItem).not.toHaveBeenCalled();
    expect(mapStore.createMapping).toHaveBeenCalledWith(expect.objectContaining({ qbId: 'qb-1', mondayItemId: '42' }));
  });

  it('re-checks the mapping in the consumer and skips an item already linked to a Customer', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const createCustomer = vi.fn();
    const mapStore = fakeMapStore({
      getByMondayItemId: vi.fn().mockResolvedValue({ entityType: 'customer', qbId: 'qb-7', mondayItemId: '42', mondayBoardId: 111, createdAt: '' }),
    });
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await processSyncQueueBatch([message], deps({ mondayEventStore, mapStore, quickBooksClient: fakeQuickBooksClient({ createCustomer }) }));

    expect(createCustomer).not.toHaveBeenCalled();
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'written', { qbId: 'qb-7', writtenAt: expect.any(String) });
    expect(message.ack).toHaveBeenCalled();
  });

  it('adopts an item the QuickBooks side created but has not mapped yet, instead of creating a Customer', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const createCustomer = vi.fn();
    const mapStore = fakeMapStore();
    const qbEventStore = fakeQbEventStore({
      findByPendingMondayItemId: vi.fn().mockResolvedValue(qbEventRow({ qbId: 'qb-9', pendingMondayItemId: '42', status: 'failed' })),
    });
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await processSyncQueueBatch([message], deps({ qbEventStore, mondayEventStore, mapStore, quickBooksClient: fakeQuickBooksClient({ createCustomer }) }));

    expect(qbEventStore.findByPendingMondayItemId).toHaveBeenCalledWith('customer', '42');
    expect(createCustomer).not.toHaveBeenCalled();
    expect(mapStore.createMapping).toHaveBeenCalledWith({
      entityType: 'customer',
      qbId: 'qb-9',
      mondayItemId: '42',
      mondayBoardId: 111,
      createdAt: expect.any(String),
    });
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'written', { qbId: 'qb-9', writtenAt: expect.any(String) });
    expect(message.ack).toHaveBeenCalled();
  });

  // Review #1/#2: the echo of an item created from QuickBooks carries the QuickBooks Id on the item
  // itself, however far the QuickBooks side got (even a lost create_item response) — no global
  // claim, no deferral, nothing blocks unrelated staff-created Customers.
  it('adopts an item that carries a QuickBooks Id instead of creating a Customer', async () => {
    const createCustomer = vi.fn();
    const mapStore = fakeMapStore();
    const mondayEventStore = fakeMondayEventStore();
    const mondayClient = fakeMondayClient({
      getItem: vi.fn().mockResolvedValue(mondayItem({ columnValues: { qb_id_col: { text: '77', value: '"77"' } } })),
    });
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await processSyncQueueBatch([message], deps({ mapStore, mondayEventStore, mondayClient, quickBooksClient: fakeQuickBooksClient({ createCustomer }) }));

    expect(mondayClient.getItem).toHaveBeenCalledWith('42');
    expect(createCustomer).not.toHaveBeenCalled();
    expect(mapStore.createMapping).toHaveBeenCalledWith(expect.objectContaining({ qbId: '77', mondayItemId: '42' }));
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'written', { qbId: '77', writtenAt: expect.any(String) });
    expect(message.ack).toHaveBeenCalled();
  });

  it('refuses (terminally) an item whose QuickBooks Id is already linked to another item — a copy', async () => {
    const createCustomer = vi.fn();
    const mapStore = fakeMapStore({
      getByQbId: vi.fn().mockResolvedValue({ entityType: 'customer', qbId: '77', mondayItemId: 'original', mondayBoardId: 111, createdAt: '' }),
    });
    const mondayEventStore = fakeMondayEventStore();
    const mondayClient = fakeMondayClient({
      getItem: vi.fn().mockResolvedValue(mondayItem({ columnValues: { qb_id_col: { text: '77', value: '"77"' } } })),
    });
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processSyncQueueBatch([message], deps({ mapStore, mondayEventStore, mondayClient, quickBooksClient: fakeQuickBooksClient({ createCustomer }) }));

    expect(createCustomer).not.toHaveBeenCalled();
    expect(mapStore.createMapping).not.toHaveBeenCalled();
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', {
      error: expect.stringMatching(/Monday item "original" already stands for — archive whichever of the two is the duplicate/),
      bumpCreateAttempt: true,
    });
    expect(message.ack).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  // GL#33 focused check: staff follow the "may have succeeded" advice — put the Customer's Id on
  // this item and archive the item QuickBooks' webhook made for it. The guard must honor the
  // archive (as linkMapping does) and adopt, re-pointing the link, without creating a Customer.
  it('adopts a carried Id whose currently linked item is archived, re-pointing the link', async () => {
    const createCustomer = vi.fn();
    const existing = { entityType: 'customer' as const, qbId: '77', mondayItemId: 'webhook-made', mondayBoardId: 111, createdAt: '' };
    const mapStore = fakeMapStore({
      getByQbId: vi.fn().mockResolvedValue(existing),
      createMapping: vi.fn().mockRejectedValue(new MappingConflictError('customer', '77', 'webhook-made', '42')),
    });
    const mondayEventStore = fakeMondayEventStore();
    const mondayClient = fakeMondayClient({
      getItem: vi.fn(async (itemId: string) =>
        itemId === 'webhook-made'
          ? mondayItem({ id: 'webhook-made', state: 'archived' })
          : mondayItem({ columnValues: { qb_id_col: { text: '77', value: '"77"' } } })
      ),
    });
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await processSyncQueueBatch([message], deps({ mapStore, mondayEventStore, mondayClient, quickBooksClient: fakeQuickBooksClient({ createCustomer }) }));

    expect(createCustomer).not.toHaveBeenCalled();
    expect(mapStore.repointMapping).toHaveBeenCalledWith(expect.objectContaining({ qbId: '77', mondayItemId: '42' }));
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'written', { qbId: '77', writtenAt: expect.any(String) });
    expect(message.ack).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('never defers: an unrelated staff-created item is created at once, and marked with its new id', async () => {
    const createCustomer = vi.fn().mockResolvedValue({ id: 'qb-new' });
    const mondayClient = fakeMondayClient();
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await processSyncQueueBatch([message], deps({ mondayClient, quickBooksClient: fakeQuickBooksClient({ createCustomer }) }));

    expect(createCustomer).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(111, '42', { qb_id_col: 'qb-new' });
  });

  it('refuses creates (terminally, no retries) while customerQbIdColumn is not configured', async () => {
    const createCustomer = vi.fn();
    const mondayEventStore = fakeMondayEventStore();
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processSyncQueueBatch(
      [message],
      deps({
        mondayEventStore,
        quickBooksClient: fakeQuickBooksClient({ createCustomer }),
        config: { ...config, quickbooksSync: { ...config.quickbooksSync, customerQbIdColumn: null } },
      })
    );

    expect(createCustomer).not.toHaveBeenCalled();
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', { error: expect.stringMatching(/customerQbIdColumn/), bumpCreateAttempt: true });
    expect(message.ack).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('refuses (terminally) an item that no longer exists', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processSyncQueueBatch([message], deps({ mondayEventStore, mondayClient: fakeMondayClient({ getItem: vi.fn().mockResolvedValue(null) }) }));

    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', { error: expect.stringMatching(/no longer exists/), bumpCreateAttempt: true });
    expect(message.ack).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it.each([
    ['another board', '999'],
    ['no board at all', null],
  ])('refuses (terminally) an item on %s, whatever the webhook said, and creates no Customer', async (_name, boardId) => {
    const mondayEventStore = fakeMondayEventStore();
    const createCustomer = vi.fn();
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processSyncQueueBatch(
      [message],
      deps({ mondayEventStore, mondayClient: fakeMondayClient({ getItem: vi.fn().mockResolvedValue(mondayItem({ boardId })) }), quickBooksClient: fakeQuickBooksClient({ createCustomer }) })
    );

    expect(createCustomer).not.toHaveBeenCalled();
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', {
      error: expect.stringMatching(/not the Customers board \(111\)/),
      bumpCreateAttempt: true,
    });
    expect(message.ack).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('refuses (terminally) an archived or deleted item — items(ids:) still returns those', async () => {
    for (const state of ['archived', 'deleted']) {
      const mondayEventStore = fakeMondayEventStore();
      const createCustomer = vi.fn();
      const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await processSyncQueueBatch(
        [message],
        deps({ mondayEventStore, mondayClient: fakeMondayClient({ getItem: vi.fn().mockResolvedValue(mondayItem({ state })) }), quickBooksClient: fakeQuickBooksClient({ createCustomer }) })
      );

      expect(createCustomer, state).not.toHaveBeenCalled();
      expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', {
        error: expect.stringMatching(new RegExp(`no longer exists \\(${state}\\)`)),
        bumpCreateAttempt: true,
      });
      expect(message.ack).toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it('QuickBooks -> Monday: a conflicting mapping with a live item is terminal; with an archived one it re-points', async () => {
    for (const [state, terminal] of [['active', true], ['archived', false]] as const) {
      const conflict = new MappingConflictError('customer', 'qb-1', 'item-live', 'item-lost');
      const mapStore = fakeMapStore({ createMapping: vi.fn().mockRejectedValue(conflict) });
      const qbEventStore = fakeQbEventStore();
      const mondayClient = fakeMondayClient({
        findItemIdsByColumnValue: vi.fn().mockResolvedValue(['item-lost']),
        getItem: vi.fn().mockResolvedValue(mondayItem({ id: 'item-live', state })),
      });
      const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await processSyncQueueBatch([message], deps({ mapStore, qbEventStore, mondayClient }));

      expect(message.ack, state).toHaveBeenCalled();
      if (terminal) {
        expect(mapStore.repointMapping).not.toHaveBeenCalled();
        expect(qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', { error: `${TERMINAL_PREFIX}${conflict.message}` });
      } else {
        expect(mapStore.repointMapping).toHaveBeenCalledWith(expect.objectContaining({ qbId: 'qb-1', mondayItemId: 'item-lost' }));
      }
      vi.restoreAllMocks();
    }
  });

  it('skips the guards on a resumed row that already created its Customer', async () => {
    const mondayEventStore = fakeMondayEventStore({
      getEvent: vi.fn().mockResolvedValue(mondayEventRow({ status: 'fetched', qbId: 'qb-already' })),
    });
    const mondayClient = fakeMondayClient();
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await processSyncQueueBatch([message], deps({ mondayEventStore, mondayClient }));

    expect(mondayClient.getItem).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });
});

// GL#33 review: a failure QuickBooks will always repeat (duplicate name, validation) used to burn
// three retries into the DLQ. It is now recorded and acked.
describe('terminal failures', () => {
  it('acks a terminal failure without retrying and records the readable reason', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });
    const reason = 'quickbooks API: HTTP 400 creating customer — ValidationFault 6240 Duplicate Name Exists Error';
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processSyncQueueBatch([message], {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore,
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient: fakeQuickBooksClient({ createCustomer: vi.fn().mockRejectedValue(new TerminalError(reason)) }),
      config,
    });

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', { error: `${TERMINAL_PREFIX}${reason}`, bumpCreateAttempt: true });
    vi.restoreAllMocks();
  });

  it('treats a qb-to-monday terminal failure (e.g. the record was deleted) the same way', async () => {
    const qbEventStore = fakeQbEventStore();
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(),
      quickBooksClient: fakeQuickBooksClient({ getEntity: vi.fn().mockRejectedValue(new TerminalError('Object Not Found')) }),
      config,
    });

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', { error: `${TERMINAL_PREFIX}Object Not Found` });
    vi.restoreAllMocks();
  });
});

// GL#33: retries were immediate, so a Monday or QuickBooks outage of a few seconds burned all the
// attempts at once and dead-lettered the change. They now back off by attempt number (the shared
// schedule in src/flags.ts).
describe('retry backoff', () => {
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

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
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

// The write switch (src/flags.ts, src/writeSwitch.ts): consumeSyncBatch decides per message
// whether to write, dry-run (record sinks, drop store writes, ack) or retry untouched.
describe('consumeSyncBatch — write switch', () => {
  const gateFor = (mode: 'on' | 'hold' | 'off' | 'unknown') => ({
    worker: 'quickbooks-sync',
    environment: 'production',
    mode,
    logLevel: 'normal' as const,
    piiKeys: ['name', 'email', 'phone', 'address'],
  });

  function depsWithSpies(overrides: { quickBooksClient?: QuickBooksClient; mondayClient?: MondayClient } = {}) {
    return {
      qbEventStore: fakeQbEventStore(),
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      mondayClient: overrides.mondayClient ?? fakeMondayClient(),
      quickBooksClient: overrides.quickBooksClient ?? fakeQuickBooksClient(),
      config,
    };
  }

  function expectNoWrites(deps: ReturnType<typeof depsWithSpies>) {
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(deps.quickBooksClient.createCustomer).not.toHaveBeenCalled();
    expect(deps.qbEventStore.updateStatus).not.toHaveBeenCalled();
    expect(deps.mondayEventStore.updateStatus).not.toHaveBeenCalled();
    expect(deps.mondayEventStore.markCreateSent).not.toHaveBeenCalled();
    expect(deps.mapStore.createMapping).not.toHaveBeenCalled();
    expect(deps.mapStore.repointMapping).not.toHaveBeenCalled();
  }

  function skipLines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('"writeSwitch":"skipped"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('off, qb-to-monday create: records the Monday create, writes nothing, acks', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = depsWithSpies();
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await consumeSyncBatch([message], deps, gateFor('off'));

    expectNoWrites(deps);
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(skipLines(log).map((l) => `${l.sink}.${l.operation}`)).toEqual(['Monday.createItem']);
    vi.restoreAllMocks();
  });

  it('off, qb-to-monday update of a mapped record: records changeColumnValues, writes nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = depsWithSpies();
    deps.mapStore = fakeMapStore({
      getByQbId: vi.fn().mockResolvedValue({ entityType: 'customer', qbId: 'qb-1', mondayItemId: '9', mondayBoardId: 111, createdAt: 'x' }),
    });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await consumeSyncBatch([message], deps, gateFor('off'));

    expectNoWrites(deps);
    expect(message.ack).toHaveBeenCalled();
    expect(skipLines(log).map((l) => `${l.sink}.${l.operation}`)).toEqual(['Monday.changeColumnValues']);
    vi.restoreAllMocks();
  });

  it('off, monday-to-qb create: no QuickBooks create, no markCreateSent, no store writes, acks', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = depsWithSpies();
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await consumeSyncBatch([message], deps, gateFor('off'));

    expectNoWrites(deps);
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    // The chain still runs on the placeholder Customer id: the QuickBooks create, then the
    // Monday stamp of that id on the item — each a skip line, neither a real write.
    expect(skipLines(log).map((l) => `${l.sink}.${l.operation}`)).toEqual(['QuickBooks.createCustomer', 'Monday.changeColumnValues']);
    vi.restoreAllMocks();
  });

  it('still reads under off: getEntity and getItem pass through to the real clients', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = depsWithSpies();

    await consumeSyncBatch([fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' })], deps, gateFor('off'));
    await consumeSyncBatch([fakeMessage({ direction: 'monday-to-qb', eventId: '42' })], deps, gateFor('off'));

    expect(deps.quickBooksClient.getEntity).toHaveBeenCalled();
    expect(deps.mondayClient.getItem).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("a message stamped 'dropped' stays a dry run even when the mode is now on", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = depsWithSpies();
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1', writeStamp: 'dropped' });

    await consumeSyncBatch([message], deps, gateFor('on'));

    expectNoWrites(deps);
    expect(message.ack).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('an unstamped legacy message (enqueued before the switch existed) writes under on', async () => {
    const deps = depsWithSpies();
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await consumeSyncBatch([message], deps, gateFor('on'));

    expect(deps.mondayClient.createItem).toHaveBeenCalled();
    expect(deps.mapStore.createMapping).toHaveBeenCalled();
    expect(deps.qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'written', expect.anything());
    expect(message.ack).toHaveBeenCalled();
  });

  it('on, monday-to-qb: still marks the create sent and creates the Customer', async () => {
    const deps = depsWithSpies();
    const message = fakeMessage({ direction: 'monday-to-qb', eventId: '42' });

    await consumeSyncBatch([message], deps, gateFor('on'));

    expect(deps.mondayEventStore.markCreateSent).toHaveBeenCalledWith('42');
    expect(deps.quickBooksClient.createCustomer).toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it.each(['hold', 'unknown'] as const)('%s: retries at 60 s without reading or writing anything', async (mode) => {
    const deps = depsWithSpies();
    const message = { ...fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' }), attempts: 1 };

    await consumeSyncBatch([message], deps, gateFor(mode));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(deps.qbEventStore.getEvent).not.toHaveBeenCalled();
    expectNoWrites(deps);
  });

  it('hold at attempt 8 backs off to the one-hour cap', async () => {
    const message = { ...fakeMessage({ direction: 'monday-to-qb', eventId: '42' }), attempts: 8 };

    await consumeSyncBatch([message], depsWithSpies(), gateFor('hold'));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
  });

  it('a TerminalError under on is still recorded and acked, not retried', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = depsWithSpies({
      quickBooksClient: fakeQuickBooksClient({ getEntity: vi.fn().mockRejectedValue(new TerminalError('Object Not Found')) }),
    });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await consumeSyncBatch([message], deps, gateFor('on'));

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(deps.qbEventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', { error: `${TERMINAL_PREFIX}Object Not Found` });
    vi.restoreAllMocks();
  });

  it('a retryable failure under on retries with the shared backoff (attempt 8: 3600 s)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = depsWithSpies({ mondayClient: fakeMondayClient({ createItem: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')) }) });
    const message = { ...fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' }), attempts: 8 };

    await consumeSyncBatch([message], deps, gateFor('on'));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
    vi.restoreAllMocks();
  });
});

// GL#101: once one message hits a Monday outage, the rest of the batch is retried with backoff
// without calling Monday or QuickBooks, instead of each repeating the transport's in-process attempts.
describe('consumeSyncBatch — outage breaker', () => {
  const gateFor = (mode: 'on' | 'hold') => ({
    worker: 'quickbooks-sync',
    environment: 'production',
    mode,
    logLevel: 'normal' as const,
    piiKeys: ['name', 'email', 'phone', 'address'],
  });
  const msg = (eventId: string, attempts: number) => ({ ...fakeMessage({ direction: 'qb-to-monday', eventId }), attempts });

  async function quietly(fn: () => Promise<void>): Promise<void> {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await fn();
    } finally {
      errors.mockRestore();
    }
  }

  it('stops calling upstream after a Monday outage and retries the rest of the batch with backoff', async () => {
    const createItem = vi.fn().mockRejectedValue(new MondayApiError('monday API: HTTP 504', { httpStatus: 504 }));
    const quickBooksClient = fakeQuickBooksClient();
    const qbEventStore = fakeQbEventStore();
    const messages = [msg('evt-1', 2), msg('evt-2', 1), msg('evt-3', 4)];

    await quietly(() => consumeSyncBatch(messages, {
      qbEventStore, mondayEventStore: fakeMondayEventStore(), mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient({ createItem }), quickBooksClient, config,
    }, gateFor('on')));

    expect(createItem).toHaveBeenCalledTimes(1);
    expect(quickBooksClient.getEntity).toHaveBeenCalledTimes(1);
    expect(qbEventStore.getEvent).toHaveBeenCalledTimes(1);
    expect(messages.map((m) => m.retry.mock.calls[0]?.[0])).toEqual([{ delaySeconds: 120 }, { delaySeconds: 60 }, { delaySeconds: 480 }]);
    for (const m of messages) expect(m.ack).not.toHaveBeenCalled();
  });

  it("raises the deferral to Monday's Retry-After hint", async () => {
    const createItem = vi.fn().mockRejectedValue(new MondayApiError('monday API: HTTP 429', { httpStatus: 429, retryAfterSeconds: 400 }));
    const messages = [msg('evt-1', 1), msg('evt-2', 1)];

    await quietly(() => processSyncQueueBatch(messages, {
      qbEventStore: fakeQbEventStore(), mondayEventStore: fakeMondayEventStore(), mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient({ createItem }), quickBooksClient: fakeQuickBooksClient(), config,
    }));

    expect(messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 400 });
    expect(messages[1]!.retry).toHaveBeenCalledWith({ delaySeconds: 400 });
  });

  it('a per-message failure (a rejected value) does not stop the batch: the next message still runs', async () => {
    const createItem = vi.fn()
      .mockRejectedValueOnce(new MondayApiError('monday API: invalid value', { httpStatus: 200, code: 'ColumnValueException' }))
      .mockResolvedValue({ id: 'item-2' });
    const messages = [msg('evt-1', 1), msg('evt-2', 1)];

    await quietly(() => consumeSyncBatch(messages, {
      qbEventStore: fakeQbEventStore(), mondayEventStore: fakeMondayEventStore(), mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient({ createItem }), quickBooksClient: fakeQuickBooksClient(), config,
    }, gateFor('on')));

    expect(createItem).toHaveBeenCalledTimes(2);
    expect(messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(messages[1]!.ack).toHaveBeenCalled();
  });

  it('hold is unchanged: every message backs off and nothing is read', async () => {
    const qbEventStore = fakeQbEventStore();
    const messages = [msg('evt-1', 3), msg('evt-2', 1)];

    await consumeSyncBatch(messages, {
      qbEventStore, mondayEventStore: fakeMondayEventStore(), mapStore: fakeMapStore(),
      mondayClient: fakeMondayClient(), quickBooksClient: fakeQuickBooksClient(), config,
    }, gateFor('hold'));

    expect(messages.map((m) => m.retry.mock.calls[0]?.[0])).toEqual([{ delaySeconds: 240 }, { delaySeconds: 60 }]);
    expect(qbEventStore.getEvent).not.toHaveBeenCalled();
  });
});
