import { describe, it, expect, vi } from 'vitest';
import { processFunraiseQueueBatch, type FunraiseQueueMessage, type QueueMessageLike } from './processBatch';
import type { EventStore } from '../db/events';
import type { SubscriptionStore } from '../db/subscriptions';
import type { FunraiseClient } from '../funraise/client';
import type { MondayClient } from '../monday/client';
import type { EventRow } from '../types';
import { testConfig } from '../test/testConfig';

// Spec 2026-09-18 "Webhook side": an installment (a transaction carrying subscription.id) gets
// the Recurring Gift connect column set on every write, fetching a never-seen subscription on
// the spot; a transaction carrying fundraisingEvent gets the event gift type, never Donation.

const config = testConfig({
  recurringGiftLinkColumn: 'rg_link_col',
  giftTypeColumn: 'gt_col',
  giftTypeValue: 'Donation',
  eventGiftTypeValue: 'Event Ticket',
  donorExternalIdField: 'supporter.id',
  emailFieldPrecedence: ['supporter.email'],
  donorNameField: 'supporter.name',
});

function eventRow(payload: Record<string, unknown>, overrides: Partial<EventRow> = {}): EventRow {
  return {
    eventId: '123:1',
    entityType: 'transaction',
    entityId: '123',
    rawPayload: JSON.stringify(payload),
    matchedDonorItemId: '7',
    mondayItemId: null,
    status: 'queued',
    error: null,
    receivedAt: '2026-09-18T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

const installment = {
  id: 123,
  description: 'Debbie Donor - Monthly',
  amount: 25,
  subscription: { id: 26, sequence: 3 },
  supporter: { id: 7276, name: 'Debbie Donor', email: 'debbie@example.com' },
};

function fakeStore(row: EventRow): EventStore {
  return {
    upsertEvent: vi.fn(),
    updateStatusByEntity: vi.fn().mockResolvedValue(undefined),
    getEventByEntity: vi.fn().mockResolvedValue(row),
    purgeWrittenPayloads: vi.fn(),
    purgeUnresolvedPayloads: vi.fn().mockResolvedValue(0),
  };
}

function fakeSubscriptionStore(known: { funraiseId: string; mondayItemId: string } | null): SubscriptionStore {
  return {
    getByFunraiseId: vi.fn().mockResolvedValue(
      known ? { ...known, donorItemId: '7', status: 'Active', updtime: 1, writtenAt: 'x' } : null
    ),
    upsert: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    getCursor: vi.fn().mockResolvedValue(0),
    setCursor: vi.fn().mockResolvedValue(undefined),
    claimCreate: vi.fn().mockResolvedValue(true),
    releaseCreate: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeFunraise(subscription: Record<string, unknown> | null): FunraiseClient {
  return {
    listSubscriptionsUpdatedAfter: vi.fn(),
    listSubscriptionsAtUpdtime: vi.fn(),
    getSubscription: vi.fn().mockResolvedValue(subscription),
  };
}

function fakeMonday(): MondayClient {
  return {
    // Donor lookups (board 42) match; adopt lookups (board 222) and orphan lookups miss.
    findItemByColumnValue: vi.fn().mockImplementation(async (boardId: number) => (boardId === 42 ? { id: '7' } : null)),
    createItem: vi.fn().mockImplementation(async (boardId: number) => ({ id: boardId === 222 ? '5560' : 'dn-created' })),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
  };
}

const message: QueueMessageLike<FunraiseQueueMessage> = { body: { entityType: 'transaction', entityId: '123' }, ack: vi.fn(), retry: vi.fn() };

describe('Recurring Gift link on installments', () => {
  it('sets the connect column from the ledger when the subscription is already known, on create', async () => {
    const monday = fakeMonday();

    await processFunraiseQueueBatch([message], {
      eventStore: fakeStore(eventRow(installment)),
      mondayClient: monday,
      config,
      subscriptionStore: fakeSubscriptionStore({ funraiseId: '26', mondayItemId: '5550' }),
      funraiseClient: fakeFunraise(null),
    });

    expect(monday.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.objectContaining({ rg_link_col: { item_ids: [5550] } }));
  });

  it('sets the connect column on a later update too — it is a fact about the gift, not a first-write stamp', async () => {
    const monday = fakeMonday();

    await processFunraiseQueueBatch([message], {
      eventStore: fakeStore(eventRow(installment, { mondayItemId: 'dn-existing' })),
      mondayClient: monday,
      config,
      subscriptionStore: fakeSubscriptionStore({ funraiseId: '26', mondayItemId: '5551' }),
      funraiseClient: fakeFunraise(null),
    });

    expect(monday.changeColumnValues).toHaveBeenCalledWith(111, 'dn-existing', expect.objectContaining({ rg_link_col: { item_ids: [5551] } }));
  });

  it('fetches a never-seen subscription from Funraise, creates its Recurring Gifts item, then links to it', async () => {
    const monday = fakeMonday();
    const funraise = fakeFunraise({ id: 26, name: 'Debbie Donor - Monthly', status: 'Active', frequency: 'Monthly', sourceAmount: 25, updtime: 5, supporter: installment.supporter });
    const subscriptionStore = fakeSubscriptionStore(null);

    await processFunraiseQueueBatch([message], {
      eventStore: fakeStore(eventRow(installment)),
      mondayClient: monday,
      config,
      subscriptionStore,
      funraiseClient: funraise,
    });

    expect(funraise.getSubscription).toHaveBeenCalledWith('26');
    expect(monday.createItem).toHaveBeenCalledWith(222, 'Debbie Donor - Monthly', expect.objectContaining({ rg_status: { label: 'Active' } }));
    expect(subscriptionStore.upsert).toHaveBeenCalledWith(expect.objectContaining({ funraiseId: '26', mondayItemId: '5560' }));
    expect(monday.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.objectContaining({ rg_link_col: { item_ids: [5560] } }));
  });

  it('leaves the column unset, with a warning, when Funraise no longer has the subscription', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const monday = fakeMonday();

      await processFunraiseQueueBatch([message], {
        eventStore: fakeStore(eventRow(installment)),
        mondayClient: monday,
        config,
        subscriptionStore: fakeSubscriptionStore(null),
        funraiseClient: fakeFunraise(null),
      });

      expect(monday.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.not.objectContaining({ rg_link_col: expect.anything() }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('subscription "26"'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does nothing for a one-time gift, and nothing when recurringGiftLinkColumn is null', async () => {
    const oneTime = { ...installment, subscription: null };
    const monday = fakeMonday();
    const subscriptionStore = fakeSubscriptionStore({ funraiseId: '26', mondayItemId: '5551' });

    await processFunraiseQueueBatch([message], { eventStore: fakeStore(eventRow(oneTime)), mondayClient: monday, config, subscriptionStore, funraiseClient: fakeFunraise(null) });
    expect(subscriptionStore.getByFunraiseId).not.toHaveBeenCalled();
    expect(monday.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.not.objectContaining({ rg_link_col: expect.anything() }));

    const disabled = testConfig({ ...config.funraiseSync, recurringGiftLinkColumn: null });
    const monday2 = fakeMonday();
    await processFunraiseQueueBatch([message], { eventStore: fakeStore(eventRow(installment)), mondayClient: monday2, config: disabled, subscriptionStore, funraiseClient: fakeFunraise(null) });
    expect(monday2.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.not.objectContaining({ rg_link_col: expect.anything() }));
  });

  it('skips the link with a warning when the ledger or Funraise client is not wired (a fork without the poller)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const monday = fakeMonday();
      await processFunraiseQueueBatch([message], { eventStore: fakeStore(eventRow(installment)), mondayClient: monday, config });
      expect(monday.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.not.objectContaining({ rg_link_col: expect.anything() }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('recurringGiftLinkColumn'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Recurring Gift link never fails the donation', () => {
  it('still writes the gift, without the link, when Funraise errors while fetching the subscription', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const monday = fakeMonday();
      const funraise: FunraiseClient = { listSubscriptionsUpdatedAfter: vi.fn(), listSubscriptionsAtUpdtime: vi.fn(), getSubscription: vi.fn().mockRejectedValue(new Error('funraise api: HTTP 503')) };
      const eventStore = fakeStore(eventRow(installment));

      await processFunraiseQueueBatch([message], { eventStore, mondayClient: monday, config, subscriptionStore: fakeSubscriptionStore(null), funraiseClient: funraise });

      expect(monday.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.not.objectContaining({ rg_link_col: expect.anything() }));
      expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', '123', 'written', expect.any(Object));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
    } finally {
      warn.mockRestore();
    }
  });

  it('still writes the gift, without the link, when creating the Recurring Gifts item fails in Monday', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const monday = fakeMonday();
      (monday.createItem as ReturnType<typeof vi.fn>).mockImplementation(async (boardId: number) => {
        if (boardId === 222) throw new Error('monday 500');
        return { id: '5570' };
      });
      const funraise = fakeFunraise({ id: 26, name: 'Debbie Donor - Monthly', status: 'Active', frequency: 'Monthly', sourceAmount: 25, updtime: 5, supporter: installment.supporter });
      const eventStore = fakeStore(eventRow(installment));

      await processFunraiseQueueBatch([message], { eventStore, mondayClient: monday, config, subscriptionStore: fakeSubscriptionStore(null), funraiseClient: funraise });

      expect(monday.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.not.objectContaining({ rg_link_col: expect.anything() }));
      expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', '123', 'written', expect.any(Object));
      expect(eventStore.updateStatusByEntity).not.toHaveBeenCalledWith('transaction', '123', 'failed', expect.any(Object));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Gift Type for event-tagged transactions', () => {
  it('stamps eventGiftTypeValue instead of giftTypeValue when the transaction carries a fundraisingEvent', async () => {
    const ticket = { ...installment, subscription: null, fundraisingEvent: { id: 9, name: 'Bike Summit' } };
    const monday = fakeMonday();

    await processFunraiseQueueBatch([message], { eventStore: fakeStore(eventRow(ticket)), mondayClient: monday, config });

    expect(monday.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.objectContaining({ gt_col: 'Event Ticket' }));
  });

  it('still stamps giftTypeValue when fundraisingEvent is null', async () => {
    const gift = { ...installment, subscription: null, fundraisingEvent: null };
    const monday = fakeMonday();

    await processFunraiseQueueBatch([message], { eventStore: fakeStore(eventRow(gift)), mondayClient: monday, config });

    expect(monday.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.objectContaining({ gt_col: 'Donation' }));
  });
});
