import { env } from 'cloudflare:workers';
import { describe, it, expect, vi } from 'vitest';
import { createApp } from './webhook/route';
import { D1EventStore } from './db/events';
import { processFunraiseQueueBatch } from './consumer/processBatch';
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

describe('integration: webhook -> D1 -> Queue -> consumer -> Monday write', () => {
  it('carries a real D1 row from the route through the consumer to a Monday write', async () => {
    const eventStore = new D1EventStore(env.DB);

    const routeMondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'donor-int-1' }),
      createItem: vi.fn(),
      changeColumnValues: vi.fn(),
    };

    let captured: { eventId: string } | undefined;
    const queue = { send: async (m: { eventId: string }) => { captured = m; } };

    const app = createApp({ eventStore, mondayClient: routeMondayClient, config, queue });

    const res = await app.request('/webhooks/funraise/transaction', {
      method: 'POST',
      body: JSON.stringify({
        id: 'int-evt-1',
        amount: 100,
        description: 'Integration test gift',
        donor: { contactId: 'fr-int-1', email: 'int@example.com' },
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(captured).toEqual({ eventId: 'int-evt-1' });

    const afterRoute = await eventStore.getEvent('int-evt-1');
    expect(afterRoute?.status).toBe('queued');
    expect(afterRoute?.matchedDonorItemId).toBe('donor-int-1');

    const consumerMondayClient: MondayClient = {
      findItemByColumnValue: vi.fn(),
      createItem: vi.fn().mockResolvedValue({ id: 'monday-item-int-1' }),
      changeColumnValues: vi.fn(),
    };

    const ack = vi.fn();
    const retry = vi.fn();
    await processFunraiseQueueBatch(
      [{ body: captured!, ack, retry }],
      { eventStore, mondayClient: consumerMondayClient, config }
    );

    expect(ack).toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();

    const afterConsumer = await eventStore.getEvent('int-evt-1');
    expect(afterConsumer?.status).toBe('written');
    expect(afterConsumer?.mondayItemId).toBe('monday-item-int-1');
  });
});
