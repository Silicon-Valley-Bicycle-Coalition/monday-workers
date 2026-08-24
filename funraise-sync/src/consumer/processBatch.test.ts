import { describe, it, expect, vi } from 'vitest';
import { processFunraiseQueueBatch, type QueueMessageLike, type FunraiseQueueMessage } from './processBatch';
import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { EventRow, FunraiseSyncConfig } from '../types';

const config: FunraiseSyncConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { 'donations:live': 111, 'recurring-gifts': 222, 'event-registrations': 333, 'people-live': 42 },
  },
  funraiseSync: {
    columnMap: {
      transaction: { amount: 'numeric_col' },
      recurringGift: { amount: 'numeric_col' },
      registration: { eventName: 'text_col' },
    },
    itemNameField: {
      transaction: 'description',
      recurringGift: 'description',
      registration: 'eventName',
    },
    entityIdField: {
      transaction: 'id',
      recurringGift: 'id',
      registration: 'id',
    },
    entityIdColumn: 'entity_col',
    rawPayloadRetentionDays: 90,
    unresolvedPayloadRetentionDays: 365,
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

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    eventId: 'evt-1',
    entityType: 'transaction',
    entityId: 'txn-1',
    rawPayload: JSON.stringify({ amount: 100, donor: { contactId: 'fr-1', email: 'a@b.org', name: 'Ada' } }),
    matchedDonorItemId: null,
    mondayItemId: null,
    status: 'queued',
    error: null,
    receivedAt: '2026-08-22T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function fakeStore(row: EventRow | null): EventStore {
  return {
    upsertEvent: vi.fn(),
    updateStatusByEntity: vi.fn().mockResolvedValue(undefined),
    getEventByEntity: vi.fn().mockResolvedValue(row),
    purgeWrittenPayloads: vi.fn(),
    purgeUnresolvedPayloads: vi.fn().mockResolvedValue(0),
  };
}

function fakeMessage(
  entityType: FunraiseQueueMessage['entityType'] = 'transaction',
  entityId = 'txn-1'
): QueueMessageLike<FunraiseQueueMessage> & { ack: any; retry: any } {
  return { body: { entityType, entityId }, ack: vi.fn(), retry: vi.fn() };
}

describe('processFunraiseQueueBatch', () => {
  it('matches the donor in the consumer, records the match, creates the item, and marks written', async () => {
    const eventStore = fakeStore(eventRow());
    const createItem = vi.fn().mockResolvedValue({ id: 'item-1' });
    // Donor lookup on the Donors board (42) hits; the orphan pre-create lookup on the target board misses.
    const findItemByColumnValue = vi.fn().mockImplementation(async (boardId: number) =>
      boardId === 42 ? { id: '55' } : null
    );
    const mondayClient: MondayClient = { findItemByColumnValue, createItem, changeColumnValues: vi.fn() };
    const message = fakeMessage();

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(findItemByColumnValue).toHaveBeenCalledWith(42, 'funraise_id_col', 'fr-1');
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'matched', {
      matchedDonorItemId: '55',
    });
    expect(createItem).toHaveBeenCalledWith(111, 'Funraise transaction', {
      numeric_col: 100,
      connect_col: { item_ids: [55] },
      entity_col: 'txn-1',
    });
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'written', {
      mondayItemId: 'item-1',
      writtenAt: expect.any(String),
    });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('skips donor matching when the event already has a matched donor', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const findItemByColumnValue = vi.fn();
    const createItem = vi.fn().mockResolvedValue({ id: 'item-2' });
    const mondayClient: MondayClient = { findItemByColumnValue, createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });

    // No donor lookups on the Donors board (42) — the only find call is the pre-create
    // orphan check on the target board.
    expect(findItemByColumnValue).not.toHaveBeenCalledWith(42, expect.anything(), expect.anything());
    expect(createItem).toHaveBeenCalledWith(111, expect.any(String), expect.objectContaining({
      connect_col: { item_ids: [7] },
    }));
  });

  it('updates the existing Monday item instead of creating when the event already has one', async () => {
    const eventStore = fakeStore(
      eventRow({ matchedDonorItemId: '7', mondayItemId: 'item-existing', rawPayload: JSON.stringify({ amount: 50 }) })
    );
    const createItem = vi.fn();
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem, changeColumnValues };
    const message = fakeMessage();

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(createItem).not.toHaveBeenCalled();
    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', {
      numeric_col: 50,
      connect_col: { item_ids: [7] },
      entity_col: 'txn-1',
    });
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'written', {
      writtenAt: expect.any(String),
    });
    expect(message.ack).toHaveBeenCalled();
  });

  it('marks the event failed and retries the message on a donor-match failure', async () => {
    const eventStore = fakeStore(eventRow());
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockRejectedValue(new Error('monday API: HTTP 429')),
      createItem: vi.fn(),
      changeColumnValues: vi.fn(),
    };
    const message = fakeMessage();

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'failed', {
      error: 'monday API: HTTP 429',
    });
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('marks the event failed and retries the message on a Monday write failure', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn(),
      createItem: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
      changeColumnValues: vi.fn(),
    };
    const message = fakeMessage();

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'failed', {
      error: 'monday API: HTTP 500',
    });
    expect(message.retry).toHaveBeenCalled();
  });

  it('routes subscription and pledge to the recurring-gifts board', async () => {
    const eventStore = fakeStore(eventRow({ entityType: 'pledge', entityId: 'sub-1', matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-3' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage('pledge', 'sub-1')], { eventStore, mondayClient, config });

    expect(createItem).toHaveBeenCalledWith(222, expect.any(String), expect.any(Object));
  });

  it('uses the description field as the item name when present', async () => {
    const eventStore = fakeStore(
      eventRow({ matchedDonorItemId: '7', rawPayload: JSON.stringify({ amount: 50, description: 'Monthly gift' }) })
    );
    const createItem = vi.fn().mockResolvedValue({ id: 'item-4' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });

    expect(createItem).toHaveBeenCalledWith(111, 'Monthly gift', expect.any(Object));
  });

  it('fails and retries when the D1 row is missing', async () => {
    const eventStore = fakeStore(null);
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem: vi.fn(), changeColumnValues: vi.fn() };
    const message = fakeMessage('transaction', 'missing-txn');

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(message.retry).toHaveBeenCalled();
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'missing-txn', 'failed', {
      error: expect.any(String),
    });
  });
});

describe('create idempotency via the entity-id column', () => {
  it('stamps the entity id column on created items', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });
    const findItemByColumnValue = vi.fn().mockResolvedValue(null);
    const mondayClient: MondayClient = { findItemByColumnValue, createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });

    expect(createItem).toHaveBeenCalledWith(111, expect.any(String), expect.objectContaining({
      entity_col: 'txn-1',
    }));
  });

  it('recovers an orphaned Monday item (created but never recorded) instead of duplicating it', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn();
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const findItemByColumnValue = vi.fn().mockResolvedValue({ id: 'item-orphan' });
    const mondayClient: MondayClient = { findItemByColumnValue, createItem, changeColumnValues };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });

    expect(findItemByColumnValue).toHaveBeenCalledWith(111, 'entity_col', 'txn-1');
    expect(createItem).not.toHaveBeenCalled();
    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-orphan', expect.any(Object));
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'written', {
      mondayItemId: 'item-orphan',
      writtenAt: expect.any(String),
    });
  });

  it('creates directly without a lookup when entityIdColumn is null', async () => {
    const noColumnConfig = {
      ...config,
      funraiseSync: { ...config.funraiseSync, entityIdColumn: null },
    };
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });
    const findItemByColumnValue = vi.fn();
    const mondayClient: MondayClient = { findItemByColumnValue, createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: noColumnConfig });

    expect(findItemByColumnValue).not.toHaveBeenCalled();
    expect(createItem).toHaveBeenCalled();
  });
});
