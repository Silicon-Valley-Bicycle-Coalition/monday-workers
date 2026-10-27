import { env } from 'cloudflare:workers';
import { describe, it, expect, vi } from 'vitest';
import { createApp } from './webhook/route';
import { D1OrderStore } from './db/orders';
import { processOrderQueueBatch, type OrderQueueMessage } from './consumer/processBatch';
import type { EventbriteClient } from './eventbrite/client';
import type { MondayClient } from './monday/client';
import { testConfig, testOrder } from './test/testConfig';

const config = testConfig({ thankYouSentColumn: 'tys_col', giftTypeColumn: 'gift_col', fiscalYearColumn: 'fy_col' }, { 'donations:live': 8845443596, 'people-live': 555666 });

// Eventbrite's documented delivery: a pointer, no order data.
const delivery = (action: string) => ({
  api_url: 'https://www.eventbriteapi.com/v3/orders/442719216/',
  config: { action, user_id: '308733706151', webhook_id: '2006536', endpoint_url: 'https://x.example/webhooks/eventbrite/order' },
});

describe('integration: webhook -> D1 -> Queue -> consumer -> Eventbrite fetch -> Monday write', () => {
  it('carries a real D1 row from the route through the consumer to a create, then a refund update', async () => {
    const orderStore = new D1OrderStore(env.DB);

    let captured: OrderQueueMessage | undefined;
    const queue = { send: async (m: OrderQueueMessage) => { captured = m; } };
    const app = createApp({ orderStore, config, queue, webhookSecret: 'int-secret' });

    const res = await app.request('/webhooks/eventbrite/order?secret=int-secret', {
      method: 'POST',
      body: JSON.stringify(delivery('order.placed')),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(captured).toEqual({ orderId: '442719216', action: 'order.placed' });

    const afterRoute = await orderStore.getOrder('442719216');
    expect(afterRoute?.status).toBe('queued');
    expect(afterRoute?.deliveries).toBe(1);
    // Nothing personal reached D1: the row has no name, email or payload column at all.
    expect(Object.keys(afterRoute!)).not.toContain('rawPayload');
    expect(JSON.stringify(afterRoute)).not.toContain('jane@example.com');

    // The consumer fetches the order itself; the delivery carried only the pointer.
    const eventbriteClient: EventbriteClient = { getOrder: vi.fn().mockResolvedValue(testOrder()), getEvent: vi.fn(), getAttendee: vi.fn() };
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockImplementation(async (boardId: number) => (boardId === 555666 ? { id: '9001' } : null)),
      createItem: vi.fn().mockResolvedValue({ id: 'monday-item-int-1' }),
      changeColumnValues: vi.fn().mockResolvedValue(undefined),
      getItems: vi.fn(), notify: vi.fn(),
    };

    const ack = vi.fn();
    const retry = vi.fn();
    await processOrderQueueBatch([{ body: captured!, ack, retry }], { orderStore, eventbriteClient, mondayClient, config });
    expect(ack).toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();

    expect(eventbriteClient.getOrder).toHaveBeenCalledWith('442719216');
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledWith(8845443596, 'order_id_col', '442719216');
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledWith(555666, 'email_col', 'jane@example.com');
    expect(mondayClient.createItem).toHaveBeenCalledWith(
      8845443596,
      'Jane Rider - Bike Summit 2026',
      expect.objectContaining({
        amount_col: 45.32,
        status_col: 'Received',
        order_id_col: '442719216',
        date_col: { date: '2026-09-14' },
        fy_col: '2027',
        gift_col: 'Event Ticket',
        tys_col: { checked: 'true' },
        connect_col: { item_ids: [9001] },
      })
    );

    const afterConsumer = await orderStore.getOrder('442719216');
    expect(afterConsumer?.status).toBe('written');
    expect(afterConsumer?.matchedDonorItemId).toBe('9001');
    expect(afterConsumer?.mondayItemId).toBe('monday-item-int-1');
    expect(afterConsumer?.eventbriteStatus).toBe('placed');
    expect(afterConsumer?.amount).toBe('45.32');
    expect(afterConsumer?.eventId).toBe('17937020110');

    // A refund: the delivery is the same pointer with another action; the fetch now says refunded.
    (eventbriteClient.getOrder as any).mockResolvedValue(testOrder({ status: 'refunded' }));
    const res2 = await app.request('/webhooks/eventbrite/order?secret=int-secret', {
      method: 'POST',
      body: JSON.stringify(delivery('order.refunded')),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res2.status).toBe(200);
    expect(captured).toEqual({ orderId: '442719216', action: 'order.refunded' });
    expect((await orderStore.getOrder('442719216'))?.deliveries).toBe(2);

    await processOrderQueueBatch([{ body: captured!, ack: vi.fn(), retry: vi.fn() }], { orderStore, eventbriteClient, mondayClient, config });

    expect(mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(
      8845443596,
      'monday-item-int-1',
      expect.objectContaining({ status_col: 'Refunded', connect_col: { item_ids: [9001] } })
    );
    // No second donor lookup: the match is cached on the row.
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledTimes(2);
    const afterRefund = await orderStore.getOrder('442719216');
    expect(afterRefund?.status).toBe('written');
    expect(afterRefund?.eventbriteStatus).toBe('refunded');
  });
});
