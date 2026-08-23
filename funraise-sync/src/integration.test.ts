import { env } from 'cloudflare:workers';
import { describe, it, expect, vi } from 'vitest';
import { createApp } from './webhook/route';
import { D1EventStore } from './db/events';
import { processFunraiseQueueBatch, type FunraiseQueueMessage } from './consumer/processBatch';
import type { MondayClient } from './monday/client';
import type { FunraiseSyncConfig } from './types';

const config: FunraiseSyncConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { 'donations:live': 8845443596, 'recurring-gifts': 111222, 'event-registrations': 333444, 'people-live': 555666 },
  },
  funraiseSync: {
    columnMap: {
      transaction: { amount: 'numeric_col', description: 'text_col' },
      recurringGift: { amount: 'numeric_col' },
      registration: { eventName: 'text_col' },
    },
    itemNameField: {
      transaction: 'description',
      recurringGift: 'description',
      registration: 'eventName',
    },
    entityIdField: {
      transaction: 'transactionId',
      recurringGift: 'id',
      registration: 'id',
    },
    entityIdColumn: null,
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
    doNotMigrateFields: ['paymentMethod.lastFour'],
  },
};

describe('integration: webhook -> D1 -> Queue -> consumer -> Monday write', () => {
  it('carries a real D1 row from the route through the consumer to a create, then an update', async () => {
    const eventStore = new D1EventStore(env.DB);

    let captured: FunraiseQueueMessage | undefined;
    const queue = { send: async (m: FunraiseQueueMessage) => { captured = m; } };
    const app = createApp({ eventStore, config, queue });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      body: JSON.stringify({
        id: 'int-evt-1',
        transactionId: 'int-txn-1',
        amount: 100,
        description: 'Integration test gift',
        donor: { contactId: 'fr-int-1', email: 'int@example.com' },
        paymentMethod: { lastFour: '4242' },
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(captured).toEqual({ entityType: 'transaction', entityId: 'int-txn-1' });

    const afterRoute = await eventStore.getEventByEntity('transaction', 'int-txn-1');
    expect(afterRoute?.status).toBe('queued');
    // Matching hasn't happened yet — it belongs to the consumer now.
    expect(afterRoute?.matchedDonorItemId).toBeNull();
    // Denylisted PII never lands in D1.
    expect(afterRoute?.rawPayload).not.toContain('4242');

    const consumerMondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'donor-int-1' }),
      createItem: vi.fn().mockResolvedValue({ id: 'monday-item-int-1' }),
      changeColumnValues: vi.fn().mockResolvedValue(undefined),
    };

    const ack = vi.fn();
    const retry = vi.fn();
    await processFunraiseQueueBatch(
      [{ body: captured!, ack, retry }],
      { eventStore, mondayClient: consumerMondayClient, config }
    );

    expect(ack).toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();

    const afterConsumer = await eventStore.getEventByEntity('transaction', 'int-txn-1');
    expect(afterConsumer?.status).toBe('written');
    expect(afterConsumer?.matchedDonorItemId).toBe('donor-int-1');
    expect(afterConsumer?.mondayItemId).toBe('monday-item-int-1');

    // A second delivery for the same transaction updates the existing item instead of creating another.
    const res2 = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      body: JSON.stringify({
        id: 'int-evt-2',
        transactionId: 'int-txn-1',
        amount: 100,
        description: 'Integration test gift',
        status: 'Refunded',
        donor: { contactId: 'fr-int-1', email: 'int@example.com' },
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res2.status).toBe(200);
    expect(captured).toEqual({ entityType: 'transaction', entityId: 'int-txn-1' });

    await processFunraiseQueueBatch(
      [{ body: captured!, ack: vi.fn(), retry: vi.fn() }],
      { eventStore, mondayClient: consumerMondayClient, config }
    );

    expect(consumerMondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(consumerMondayClient.changeColumnValues).toHaveBeenCalledWith(
      8845443596,
      'monday-item-int-1',
      expect.objectContaining({ numeric_col: 100 })
    );
  });
});
