import { describe, it, expect, vi } from 'vitest';
import { fakeEventStore, fakeAttendeeStore } from '../test/fakeStores';
import { processOrderQueueBatch, retryDelaySeconds, type QueueMessageLike, type OrderQueueMessage } from './processBatch';
import type { OrderStore } from '../db/orders';
import type { EventbriteClient } from '../eventbrite/client';
import type { MondayClient } from '../monday/client';
import type { OrderRow } from '../types';
import { PLACEHOLDER_COLUMN_ID } from '../config';
import { MondayApiError } from '../monday/graphql';
import { testConfig, testOrder } from '../test/testConfig';

const config = testConfig({ thankYouSentColumn: 'tys_col', giftTypeColumn: 'gift_col', fiscalYearColumn: 'fy_col' });

function orderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderId: '442719216',
    eventId: null,
    lastAction: 'order.placed',
    status: 'queued',
    eventbriteStatus: null,
    amount: null,
    currency: null,
    orderCreated: null,
    matchedDonorItemId: null,
    mondayItemId: null,
    error: null,
    deliveries: 1,
    receivedAt: '2026-10-06T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function fakeStore(row: OrderRow | null): OrderStore {
  return {
    recordDelivery: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getOrder: vi.fn().mockResolvedValue(row),
  };
}

function fakeEventbrite(order: ReturnType<typeof testOrder> | null): EventbriteClient {
  return { getOrder: vi.fn().mockResolvedValue(order), getEvent: vi.fn(), getAttendee: vi.fn() };
}

// Donor lookup on People (42) hits by default; the adopt lookup on Donations (111) misses.
function fakeMonday(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockImplementation(async (boardId: number) => (boardId === 42 ? { id: '55' } : null)),
    createItem: vi.fn().mockResolvedValue({ id: 'item-1' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    getItems: vi.fn(), notify: vi.fn(),
    ...overrides,
  };
}

function fakeMessage(orderId = '442719216', attempts?: number): QueueMessageLike<OrderQueueMessage> & { ack: any; retry: any } {
  return { body: { orderId, action: 'order.placed' }, attempts, ack: vi.fn(), retry: vi.fn() };
}

describe('processOrderQueueBatch', () => {
  it('fetches the order, matches the donor, creates the item with the first-write stamps, and records everything', async () => {
    const orderStore = fakeStore(orderRow());
    const eventbriteClient = fakeEventbrite(testOrder());
    const mondayClient = fakeMonday();
    const message = fakeMessage();

    await processOrderQueueBatch([message], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient, mondayClient, config });

    expect(eventbriteClient.getOrder).toHaveBeenCalledWith('442719216');
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledWith(111, 'order_id_col', '442719216');
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledWith(42, 'email_col', 'jane@example.com');
    expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'queued', { matchedDonorItemId: '55' });
    expect(mondayClient.createItem).toHaveBeenCalledWith(111, 'Jane Rider - Bike Summit 2026', {
      amount_col: 45.32,
      status_col: 'Received',
      order_id_col: '442719216',
      date_col: { date: '2026-09-14' },
      connect_col: { item_ids: [55] },
      tys_col: { checked: 'true' },
      gift_col: 'Event Ticket',
      fy_col: '2027',
    });
    expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'written', {
      eventId: '17937020110',
      eventbriteStatus: 'placed',
      amount: '45.32',
      currency: 'USD',
      orderCreated: '2026-09-15T02:00:00Z',
      mondayItemId: 'item-1',
      writtenAt: expect.any(String),
    });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('skips donor matching when the row already has a match', async () => {
    const orderStore = fakeStore(orderRow({ matchedDonorItemId: '7' }));
    const mondayClient = fakeMonday();
    await processOrderQueueBatch([fakeMessage()], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(testOrder()), mondayClient, config });
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalledWith(42, expect.anything(), expect.anything());
    expect(mondayClient.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.objectContaining({ connect_col: { item_ids: [7] } }));
  });

  it('updates the existing item (no stamps, Donor link kept current) when the row has a Monday item', async () => {
    const orderStore = fakeStore(orderRow({ matchedDonorItemId: '7', mondayItemId: 'item-existing' }));
    const mondayClient = fakeMonday();
    const message = fakeMessage();

    await processOrderQueueBatch([message], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(testOrder({ status: 'refunded' })), mondayClient, config });

    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', {
      amount_col: 45.32,
      status_col: 'Refunded',
      order_id_col: '442719216',
      date_col: { date: '2026-09-14' },
      connect_col: { item_ids: [7] },
    });
    expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'written', expect.objectContaining({ mondayItemId: 'item-existing', eventbriteStatus: 'refunded' }));
    expect(message.ack).toHaveBeenCalled();
  });

  it('records a deleted or archived item as failed and acks, without retrying or recreating', async () => {
    const orderStore = fakeStore(orderRow({ matchedDonorItemId: '7', mondayItemId: 'item-gone' }));
    const mondayClient = fakeMonday({
      changeColumnValues: vi.fn().mockRejectedValue(new MondayApiError('Item not found', { code: 'ItemNotFoundException' })),
    });
    const message = fakeMessage();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await processOrderQueueBatch([message], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(testOrder()), mondayClient, config });
      expect(mondayClient.createItem).not.toHaveBeenCalled();
      expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'failed', expect.objectContaining({ error: expect.stringContaining('deleted or archived') }));
      expect(message.ack).toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('still retries an ordinary Monday failure on an existing item', async () => {
    const orderStore = fakeStore(orderRow({ matchedDonorItemId: '7', mondayItemId: 'item-existing' }));
    const mondayClient = fakeMonday({
      changeColumnValues: vi.fn().mockRejectedValue(new MondayApiError('Monday is down', { httpStatus: 503 })),
    });
    const message = fakeMessage();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await processOrderQueueBatch([message], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(testOrder()), mondayClient, config });
      expect(message.retry).toHaveBeenCalled();
      expect(message.ack).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('adopts an item already carrying the order id instead of creating: order columns only, no Donor link, no stamps', async () => {
    const orderStore = fakeStore(orderRow());
    const mondayClient = fakeMonday({
      findItemByColumnValue: vi.fn().mockImplementation(async (boardId: number) => (boardId === 111 ? { id: 'adopted-9' } : { id: '55' })),
    });

    await processOrderQueueBatch([fakeMessage()], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(testOrder()), mondayClient, config });

    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(111, 'adopted-9', {
      amount_col: 45.32,
      status_col: 'Received',
      order_id_col: '442719216',
      date_col: { date: '2026-09-14' },
    });
    expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'written', expect.objectContaining({ mondayItemId: 'adopted-9' }));
  });

  it('writes the gift without a Donor link, with a warning, when the order has no email', async () => {
    const orderStore = fakeStore(orderRow());
    const mondayClient = fakeMonday();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await processOrderQueueBatch([fakeMessage()], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(testOrder({ email: null })), mondayClient, config });
      expect(mondayClient.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.not.objectContaining({ connect_col: expect.anything() }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no donor link'));
      expect(orderStore.updateStatus).not.toHaveBeenCalledWith('442719216', 'queued', expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('marks a free order skipped and acks without any Monday write', async () => {
    const orderStore = fakeStore(orderRow());
    const mondayClient = fakeMonday();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const message = fakeMessage();
    try {
      const free = testOrder({ costs: { gross: { currency: 'USD', value: 0, major_value: '0.00', display: '$0.00' } } });
      await processOrderQueueBatch([message], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(free), mondayClient, config });
      expect(mondayClient.createItem).not.toHaveBeenCalled();
      expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
      // No donor lookup either — nothing to link.
      expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalledWith(42, expect.anything(), expect.anything());
      expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'skipped', expect.objectContaining({ error: expect.stringContaining('free order'), eventbriteStatus: 'placed' }));
      expect(message.ack).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('marks an unmapped-status order skipped', async () => {
    const orderStore = fakeStore(orderRow());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await processOrderQueueBatch([fakeMessage()], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(testOrder({ status: 'pending' })), mondayClient: fakeMonday(), config });
      expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'skipped', expect.objectContaining({ error: expect.stringContaining('"pending"') }));
    } finally {
      log.mockRestore();
    }
  });

  it('marks a 404 from Eventbrite failed and acks — a retry cannot help', async () => {
    const orderStore = fakeStore(orderRow());
    const mondayClient = fakeMonday();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const message = fakeMessage();
    try {
      await processOrderQueueBatch([message], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(null), mondayClient, config });
      expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'failed', { error: 'order not found in Eventbrite (HTTP 404)' });
      expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
      expect(message.ack).toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses to write while orderIdColumn is the placeholder: failed, retried, nothing fetched', async () => {
    const orderStore = fakeStore(orderRow());
    const eventbriteClient = fakeEventbrite(testOrder());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = fakeMessage();
    try {
      await processOrderQueueBatch([message], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient, mondayClient: fakeMonday(), config: testConfig({ orderIdColumn: PLACEHOLDER_COLUMN_ID }) });
      expect(eventbriteClient.getOrder).not.toHaveBeenCalled();
      expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'failed', { error: expect.stringContaining('Eventbrite Order ID') });
      expect(message.retry).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('names every placeholder column up front instead of letting Monday reject the write', async () => {
    const orderStore = fakeStore(orderRow());
    const eventbriteClient = fakeEventbrite(testOrder());
    const mondayClient = fakeMonday();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = fakeMessage();
    try {
      await processOrderQueueBatch([message], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient, mondayClient, config: testConfig({ amountColumn: PLACEHOLDER_COLUMN_ID, dateColumn: PLACEHOLDER_COLUMN_ID }) });
      expect(eventbriteClient.getOrder).not.toHaveBeenCalled();
      expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'failed', { error: expect.stringMatching(/amountColumn.*dateColumn/) });
      expect(message.retry).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('marks the row failed and retries with backoff on an Eventbrite failure', async () => {
    const orderStore = fakeStore(orderRow());
    const eventbriteClient: EventbriteClient = { getOrder: vi.fn().mockRejectedValue(new Error('eventbrite api: get order 442719216 failed with HTTP 503')), getEvent: vi.fn(), getAttendee: vi.fn() };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = fakeMessage('442719216', 2);
    try {
      await processOrderQueueBatch([message], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient, mondayClient: fakeMonday(), config });
      expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'failed', { error: 'eventbrite api: get order 442719216 failed with HTTP 503' });
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
      expect(message.ack).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('marks the row failed and retries on a Monday write failure', async () => {
    const orderStore = fakeStore(orderRow({ matchedDonorItemId: '7' }));
    const mondayClient = fakeMonday({ createItem: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = fakeMessage();
    try {
      await processOrderQueueBatch([message], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(testOrder()), mondayClient, config });
      expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'failed', { error: 'monday API: HTTP 500' });
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('retries when the orders row is missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = fakeMessage('nope');
    try {
      await processOrderQueueBatch([message], { orderStore: fakeStore(null), eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(testOrder()), mondayClient: fakeMonday(), config });
      expect(message.retry).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('throws before any Monday call when the Donations board is not configured', async () => {
    const orderStore = fakeStore(orderRow());
    const mondayClient = fakeMonday();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await processOrderQueueBatch([fakeMessage()], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(testOrder()), mondayClient, config: testConfig({}, { 'donations:live': null }) });
      expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
      expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'failed', { error: expect.stringContaining('donations:live') });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keeps the retry decision when recording the failure itself throws', async () => {
    const orderStore = fakeStore(orderRow());
    (orderStore.updateStatus as any).mockRejectedValue(new Error('D1 down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = fakeMessage();
    try {
      await processOrderQueueBatch([message], { orderStore, eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), queue: { send: vi.fn() }, eventbriteClient: { getOrder: vi.fn().mockRejectedValue(new Error('boom')), getEvent: vi.fn(), getAttendee: vi.fn() }, mondayClient: fakeMonday(), config });
      expect(message.retry).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('could not record failure'));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('retryDelaySeconds', () => {
  it('backs off 1, 4, 16 minutes by attempt', () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(240);
    expect(retryDelaySeconds(3)).toBe(960);
  });

  it('treats a missing or bad attempt count as the first attempt', () => {
    expect(retryDelaySeconds(undefined)).toBe(60);
    expect(retryDelaySeconds(0)).toBe(60);
    expect(retryDelaySeconds(Number.NaN)).toBe(60);
  });

  it('caps at the Queues maximum of 12 hours', () => {
    expect(retryDelaySeconds(20)).toBe(12 * 60 * 60);
  });

  describe('message kinds', () => {
    const deps = (orderStore: OrderStore, eventStore = fakeEventStore(), attendeeStore = fakeAttendeeStore()) => ({
      orderStore, eventStore, attendeeStore, queue: { send: vi.fn() }, eventbriteClient: fakeEventbrite(testOrder()), mondayClient: fakeMonday(), config,
    });

    it('treats a message with no kind as an order (queued before the union existed)', async () => {
      const orderStore = fakeStore(orderRow());
      const message = fakeMessage();
      expect('kind' in message.body).toBe(false);
      await processOrderQueueBatch([message], deps(orderStore));
      expect(orderStore.getOrder).toHaveBeenCalledWith('442719216');
      expect(message.ack).toHaveBeenCalled();
    });

    it('routes an event message to processEvent (a stub for now: retried, event ledger marked failed)', async () => {
      const orderStore = fakeStore(null);
      const eventStore = fakeEventStore();
      const message = { body: { kind: 'event' as const, eventId: 'e-1', action: 'event.updated' }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await processOrderQueueBatch([message], deps(orderStore, eventStore));
        expect(orderStore.getOrder).not.toHaveBeenCalled();
        expect(eventStore.updateStatus).toHaveBeenCalledWith('e-1', 'failed', { error: 'not implemented' });
        expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
        expect(message.ack).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('routes an attendee message to processAttendee (a stub for now: retried, attendee ledger marked failed)', async () => {
      const orderStore = fakeStore(null);
      const attendeeStore = fakeAttendeeStore();
      const message = { body: { kind: 'attendee' as const, eventId: 'e-1', attendeeId: 'a-1', action: 'attendee.updated' }, attempts: 2, ack: vi.fn(), retry: vi.fn() };
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await processOrderQueueBatch([message], deps(orderStore, fakeEventStore(), attendeeStore));
        expect(attendeeStore.updateStatus).toHaveBeenCalledWith('a-1', 'failed', { error: 'not implemented' });
        expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
