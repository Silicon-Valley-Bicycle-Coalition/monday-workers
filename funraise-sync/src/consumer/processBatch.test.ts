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
    rawPayload: JSON.stringify({ amount: 100 }),
    matchedDonorItemId: '1',
    mondayItemId: null,
    status: 'queued',
    error: null,
    receivedAt: '2026-08-22T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function fakeMessage(eventId: string): QueueMessageLike<FunraiseQueueMessage> & { ack: any; retry: any } {
  return { body: { eventId }, ack: vi.fn(), retry: vi.fn() };
}

describe('processFunraiseQueueBatch', () => {
  it('writes a matched event to Monday, links the donor, and marks it written', async () => {
    const eventStore: EventStore = {
      insertEvent: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getEvent: vi.fn().mockResolvedValue(eventRow()),
    };
    const createItem = vi.fn().mockResolvedValue({ id: 'item-1' });
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn(),
      createItem,
      changeColumnValues: vi.fn(),
    };
    const message = fakeMessage('evt-1');

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(createItem).toHaveBeenCalledWith(111, 'Funraise transaction', {
      numeric_col: 100,
      connect_col: { item_ids: [1] },
    });
    expect(eventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'written', {
      mondayItemId: 'item-1',
      writtenAt: expect.any(String),
    });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('uses the description field as the item name when present', async () => {
    const eventStore: EventStore = {
      insertEvent: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getEvent: vi.fn().mockResolvedValue(
        eventRow({ rawPayload: JSON.stringify({ amount: 50, description: 'Monthly gift' }) })
      ),
    };
    const createItem = vi.fn().mockResolvedValue({ id: 'item-2' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage('evt-1')], { eventStore, mondayClient, config });

    expect(createItem).toHaveBeenCalledWith(111, 'Monthly gift', expect.any(Object));
  });

  it('routes subscription and pledge to the recurring-gifts board', async () => {
    const eventStore: EventStore = {
      insertEvent: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getEvent: vi.fn().mockResolvedValue(eventRow({ entityType: 'pledge' })),
    };
    const createItem = vi.fn().mockResolvedValue({ id: 'item-3' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage('evt-1')], { eventStore, mondayClient, config });

    expect(createItem).toHaveBeenCalledWith(222, expect.any(String), expect.any(Object));
  });

  it('marks the event failed and retries the message on a Monday write failure', async () => {
    const eventStore: EventStore = {
      insertEvent: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getEvent: vi.fn().mockResolvedValue(eventRow()),
    };
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn(),
      createItem: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
      changeColumnValues: vi.fn(),
    };
    const message = fakeMessage('evt-1');

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(eventStore.updateStatus).toHaveBeenCalledWith('evt-1', 'failed', { error: 'monday API: HTTP 500' });
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('acks without re-creating a Monday item when the event is already written (idempotency guard)', async () => {
    const eventStore: EventStore = {
      insertEvent: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getEvent: vi.fn().mockResolvedValue(eventRow({ status: 'written', mondayItemId: 'item-already-written' })),
    };
    const createItem = vi.fn().mockResolvedValue({ id: 'item-should-not-happen' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem, changeColumnValues: vi.fn() };
    const message = fakeMessage('evt-1');

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(createItem).not.toHaveBeenCalled();
  });

  it('fails and retries when the D1 row is missing', async () => {
    const eventStore: EventStore = {
      insertEvent: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getEvent: vi.fn().mockResolvedValue(null),
    };
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem: vi.fn(), changeColumnValues: vi.fn() };
    const message = fakeMessage('missing-evt');

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(message.retry).toHaveBeenCalled();
    expect(eventStore.updateStatus).toHaveBeenCalledWith('missing-evt', 'failed', { error: expect.any(String) });
  });
});
