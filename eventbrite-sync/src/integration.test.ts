import { env } from 'cloudflare:workers';
import { describe, it, expect, vi } from 'vitest';
import { createApp } from './webhook/route';
import { D1OrderStore } from './db/orders';
import { D1EventStore } from './db/events';
import { D1AttendeeStore } from './db/attendees';
import { processOrderQueueBatch, type OrderQueueMessage } from './consumer/processBatch';
import type { EventbriteClient } from './eventbrite/client';
import type { MondayClient } from './monday/client';
import { mondayItem } from './test/mondayItem';
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
    const queue = { send: async (m: OrderQueueMessage) => { captured = m; }, sendBatch: async () => {} };
    const app = createApp({ orderStore, eventStore: new D1EventStore(env.DB), attendeeStore: new D1AttendeeStore(env.DB), config, queue, webhookSecret: 'int-secret', writeMode: async () => 'on' as const });

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
    await processOrderQueueBatch([{ body: captured!, ack, retry }], { orderStore, eventStore: new D1EventStore(env.DB), attendeeStore: new D1AttendeeStore(env.DB), queue, eventbriteClient, mondayClient, config });
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

    await processOrderQueueBatch([{ body: captured!, ack: vi.fn(), retry: vi.fn() }], { orderStore, eventStore: new D1EventStore(env.DB), attendeeStore: new D1AttendeeStore(env.DB), queue, eventbriteClient, mondayClient, config });

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

describe('integration: event + attendee webhooks -> D1 -> Queue -> consumers -> Monday', () => {
  it('writes the Events item and a registration', async () => {
    const eventStore = new D1EventStore(env.DB);
    const attendeeStore = new D1AttendeeStore(env.DB);
    const orderStore = new D1OrderStore(env.DB);
    const cfg = testConfig({}, { 'people-live': 555666 });

    const sent: unknown[] = [];
    const queue = { send: async (m: unknown) => { sent.push(m); }, sendBatch: async (ms: unknown[]) => { sent.push(...ms); } };
    const app = createApp({ orderStore, eventStore, attendeeStore, config: cfg, queue: queue as never, webhookSecret: 'int-secret', writeMode: async () => 'on' as const });
    const post = (apiUrl: string, action: string) =>
      app.request('/webhooks/eventbrite/attendee?secret=int-secret', {
        method: 'POST',
        body: JSON.stringify({ api_url: `https://www.eventbriteapi.com/v3${apiUrl}`, config: { action, user_id: '308733706151', webhook_id: '2006537' } }),
        headers: { 'Content-Type': 'application/json' },
      });

    // Monday mock: items created by the consumers are readable back.
    const items = new Map<string, { board: number; name: string; columns: Record<string, string> }>();
    let next = 0;
    // Monday's `text` for a column: a string stays, a status/email object reads as its label/address.
    const text = (v: unknown): string => {
      if (typeof v === 'string') return v;
      if (typeof v === 'object' && v !== null) {
        const o = v as { label?: string; email?: string };
        return o.label ?? o.email ?? '';
      }
      return '';
    };
    const flat = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, text(v)]));
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockResolvedValue(null),
      createItem: vi.fn().mockImplementation(async (board: number, name: string, values: Record<string, unknown>) => {
        const id = `item-${++next}`;
        items.set(id, { board, name, columns: flat(values) });
        return { id };
      }),
      changeColumnValues: vi.fn().mockImplementation(async (_board: number, id: string, values: Record<string, unknown>) => {
        Object.assign(items.get(id)!.columns, flat(values));
      }),
      getItems: vi.fn().mockImplementation(async (_board: number, ids: string[]) => ids.filter((id) => items.has(id)).map((id) => mondayItem(id, items.get(id)!.name, items.get(id)!.columns))),
      notify: vi.fn().mockResolvedValue(undefined),
    };
    const eventbriteClient: EventbriteClient = {
      getOrder: vi.fn(),
      getEvent: vi.fn().mockResolvedValue({
        id: '9001', name: { text: 'Adult Learn to Ride' }, start: { utc: '2026-10-31T17:00:00Z' }, end: { utc: '2026-10-31T19:00:00Z' },
        status: 'completed', organizer_id: 'org-public', organizer: { name: 'Silicon Valley Bicycle Coalition' }, online_event: false,
        venue: { name: 'Mitchell Park', address: { localized_address_display: '600 E Meadow Dr, Palo Alto, CA' } },
      }),
      getAttendee: vi.fn().mockResolvedValue({ id: '7001', event_id: '9001', checked_in: true, cancelled: false, refunded: false, profile: { name: 'Pat Rider', first_name: 'Pat', email: 'pat@example.com' } }),
    };
    const deps = { orderStore, eventStore, attendeeStore, queue, eventbriteClient, mondayClient, config: cfg };
    const drain = async () => {
      while (sent.length > 0) {
        await processOrderQueueBatch([{ body: sent.shift() as never, ack: vi.fn(), retry: vi.fn() }], deps);
      }
    };

    // Event delivery, then attendee delivery: each is a pointer; the consumers fetch the rest.
    expect((await post('/events/9001/', 'event.published')).status).toBe(200);
    await drain();
    expect((await post('/events/9001/attendees/7001/', 'attendee.updated')).status).toBe(200);
    await drain();

    const eventRow = await eventStore.getEvent('9001');
    expect(eventRow?.status).toBe('written');
    expect(eventRow?.endsAt).toBe('2026-10-31T19:00:00.000Z');
    const attendeeRow = await attendeeStore.getAttendee('7001');
    expect(attendeeRow?.status).toBe('written');
    const registrationId = attendeeRow!.mondayItemId!;
    expect(items.get(registrationId)!.columns['att_attendance_col']).toBe('Attended');
    // Nothing personal reached D1.
    expect(JSON.stringify(attendeeRow)).not.toContain('pat@example.com');

  });
});
