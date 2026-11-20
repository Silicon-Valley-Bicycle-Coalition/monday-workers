import { env } from 'cloudflare:workers';
import { describe, it, expect, vi } from 'vitest';
import { createApp } from './webhook/route';
import { D1EventStore } from './db/events';
import { consumeFunraiseBatch, processFunraiseQueueBatch, type FunraiseQueueMessage } from './consumer/processBatch';
import type { MondayClient } from './monday/client';
import type { FunraiseSyncConfig } from './types';
import { testConfig } from './test/testConfig';

const config: FunraiseSyncConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { 'donations:live': 8845443596, 'recurring-gifts': 111222, 'people-live': 555666 },
  },
  funraiseSync: {
    // Field paths follow Funraise's documented webhook payload (the entity under `data`, which
    // the route unwraps): amount and status under `transaction`, the donor under `supporter`.
    columnMap: { 'transaction.amount': 'numeric_col', 'transaction.status': 'status_col', donationDate: 'date_col' },
    itemNameField: 'description',
    entityIdField: 'id',
    entityIdColumn: null,
    thankYouSentColumn: null,
    giftTypeColumn: null,
    giftTypeValue: 'Donation',
    eventGiftTypeValue: 'Event Ticket',
    fiscalYearColumn: 'fiscal_year_col',
    oldestActiveFiscalYear: null,
    recurringGiftLinkColumn: null,
    rawPayloadRetentionDays: 90,
    unresolvedPayloadRetentionDays: 365,
    donorExternalIdField: 'supporter.id',
    donorExternalIdColumn: 'funraise_id_col',
    donorEmailColumn: 'email_col',
    donorNameField: 'supporter.name',
    donorFirstNameField: 'supporter.firstName',
    donorLastNameField: 'supporter.lastName',
    donorFirstNameColumn: 'first_col',
    donorLastNameColumn: 'last_col',
    donorLinkColumn: 'connect_col',
    emailFieldPrecedence: ['supporter.email'],
    statusField: 'transaction.status',
    statusValueMap: { Complete: 'Received' },
    doNotMigrateFields: ['transaction.lastFour', 'transaction.expirationDate'],
  },
  subscriptionsPoll: testConfig().subscriptionsPoll,
  employerAnswers: { enabled: false },
};

// The example delivery from help.funraise.io "Webhooks", trimmed to the fields this Worker reads
// plus the PII it must strip. `id` and `supporter.id` are numbers, dates are epoch milliseconds.
function funraiseDelivery(overrides: { sentAt: number; status?: string }) {
  return {
    sentAt: overrides.sentAt,
    event: 'DONATION',
    data: {
      id: 123,
      description: 'Debbie Donor - Funraise 2020-09-02T17:31:20.174045Z',
      donationDate: 1599067880174,
      cretime: 1599067880174,
      transaction: {
        amount: 51.5,
        status: overrides.status ?? 'Complete',
        lastFour: '0005',
        expirationDate: 1780271999999,
        paymentMethod: 'card',
      },
      supporter: { id: 7276, firstName: 'Debbie', lastName: 'Donor', name: 'Debbie Donor', email: 'debbie@example.com' },
    },
  };
}

describe('integration: webhook -> D1 -> Queue -> consumer -> Monday write', () => {
  it('carries a real D1 row from the route through the consumer to a create, then an update', async () => {
    const eventStore = new D1EventStore(env.DB);

    let captured: FunraiseQueueMessage | undefined;
    const queue = { send: async (m: FunraiseQueueMessage) => { captured = m; } };
    const app = createApp({ eventStore, config, queue, webhookSecret: 'int-secret', writeMode: async () => 'on' });

    const res = await app.request('/webhooks/funraise/transaction?secret=int-secret', {
      method: 'POST',
      body: JSON.stringify(funraiseDelivery({ sentAt: 1599067884009 })),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(captured).toEqual({ entityType: 'transaction', entityId: '123' });

    const afterRoute = await eventStore.getEventByEntity('transaction', '123');
    expect(afterRoute?.status).toBe('queued');
    // Matching hasn't happened yet — it belongs to the consumer now.
    expect(afterRoute?.matchedDonorItemId).toBeNull();
    // Denylisted PII never lands in D1; the rest of the transaction sub-object does.
    expect(afterRoute?.rawPayload).not.toContain('0005');
    expect(afterRoute?.rawPayload).not.toContain('1780271999999');
    expect(afterRoute?.rawPayload).toContain('"paymentMethod":"card"');

    const consumerMondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockResolvedValue({ id: '9001' }),
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

    // The donor was looked up by the numeric supporter id, stringified.
    expect(consumerMondayClient.findItemByColumnValue).toHaveBeenCalledWith(555666, 'funraise_id_col', '7276');
    // Complete → Received, the epoch-ms donationDate became a Monday date object, and Fiscal
    // Year Ending was derived from that same date (September 2020 → FY 2021).
    expect(consumerMondayClient.createItem).toHaveBeenCalledWith(
      8845443596,
      'Debbie Donor - Funraise 2020-09-02T17:31:20.174045Z',
      expect.objectContaining({
        numeric_col: 51.5,
        status_col: 'Received',
        date_col: { date: '2020-09-02' },
        fiscal_year_col: '2021',
        connect_col: { item_ids: [9001] },
      })
    );

    const afterConsumer = await eventStore.getEventByEntity('transaction', '123');
    expect(afterConsumer?.status).toBe('written');
    expect(afterConsumer?.matchedDonorItemId).toBe('9001');
    expect(afterConsumer?.mondayItemId).toBe('monday-item-int-1');

    // A later edit of the same transaction (new sentAt) updates the existing item instead of
    // creating another; an identical redelivery (same sentAt) would be a duplicate instead.
    const res2 = await app.request('/webhooks/funraise/transaction?secret=int-secret', {
      method: 'POST',
      body: JSON.stringify(funraiseDelivery({ sentAt: 1599067990000, status: 'Refunded' })),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true });
    expect(captured).toEqual({ entityType: 'transaction', entityId: '123' });

    await processFunraiseQueueBatch(
      [{ body: captured!, ack: vi.fn(), retry: vi.fn() }],
      { eventStore, mondayClient: consumerMondayClient, config }
    );

    expect(consumerMondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(consumerMondayClient.changeColumnValues).toHaveBeenCalledWith(
      8845443596,
      'monday-item-int-1',
      expect.objectContaining({ numeric_col: 51.5, status_col: 'Refunded' })
    );

    // At-least-once delivery can replay the *original* Complete delivery after the Refunded
    // edit was already written. Its sentAt is older than the stored row's, so it must be
    // treated as a duplicate: nothing enqueued, and the Refunded payload left in place.
    captured = undefined;
    const res3 = await app.request('/webhooks/funraise/transaction?secret=int-secret', {
      method: 'POST',
      body: JSON.stringify(funraiseDelivery({ sentAt: 1599067884009 })),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res3.status).toBe(200);
    expect(await res3.json()).toEqual({ ok: true, duplicate: true });
    expect(captured).toBeUndefined();
    const afterStale = await eventStore.getEventByEntity('transaction', '123');
    expect(afterStale?.status).toBe('written');
    expect(afterStale?.rawPayload).toContain('"status":"Refunded"');
  });
});

// Write switch, against real D1: a delivery ingested under `off` is stamped, and consuming it
// even after the switch is back `on` writes nothing — no placeholder donor id, no item id, no
// status change (Review Focus 2).
describe('integration: write switch off at ingest', () => {
  it('records the delivery, then dry-runs it without touching its D1 row', async () => {
    const eventStore = new D1EventStore(env.DB);
    let captured: FunraiseQueueMessage | undefined;
    const app = createApp({
      eventStore,
      config,
      queue: { send: async (m: FunraiseQueueMessage) => { captured = m; } },
      webhookSecret: 'int-secret',
      writeMode: async () => 'off',
    });

    const res = await app.request('/webhooks/funraise/transaction?secret=int-secret', {
      method: 'POST',
      body: JSON.stringify({ ...funraiseDelivery({ sentAt: 1600000000000 }), data: { ...funraiseDelivery({ sentAt: 1600000000000 }).data, id: 456 } }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(captured).toEqual({ entityType: 'transaction', entityId: '456', writeStamp: 'dropped' });

    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockResolvedValue(null),
      createItem: vi.fn(),
      changeColumnValues: vi.fn(),
    };
    const ack = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await consumeFunraiseBatch([{ body: captured!, ack, retry: vi.fn() }], { eventStore, mondayClient, config }, {
        worker: 'funraise-sync', environment: 'production', mode: 'on', logLevel: 'normal', piiKeys: ['name', 'email'],
      });
    } finally {
      log.mockRestore();
    }

    expect(ack).toHaveBeenCalled();
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    const row = await eventStore.getEventByEntity('transaction', '456');
    expect(row?.status).toBe('queued');
    expect(row?.matchedDonorItemId).toBeNull();
    expect(row?.mondayItemId).toBeNull();
  });
});
