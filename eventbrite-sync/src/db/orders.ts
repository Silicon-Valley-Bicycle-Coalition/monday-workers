import type { OrderRow, OrderStatus } from '../types';

export interface NewDelivery {
  orderId: string;
  action: string;
  receivedAt: string;
}

// What the consumer learned from the fetched order; recorded alongside the status change so the
// ledger says what was last written without holding the payload.
export interface OrderStatusPatch {
  eventId?: string;
  eventbriteStatus?: string;
  amount?: string;
  currency?: string;
  orderCreated?: string;
  matchedDonorItemId?: string;
  mondayItemId?: string;
  error?: string;
  writtenAt?: string;
}

export interface OrderStore {
  // Insert the order on first sight, or bump its delivery count and reset it to 'received' —
  // keeping the Monday item id, donor match and order facts a previous write recorded.
  recordDelivery(delivery: NewDelivery): Promise<'inserted' | 'updated'>;
  updateStatus(orderId: string, status: OrderStatus, patch?: OrderStatusPatch): Promise<void>;
  getOrder(orderId: string): Promise<OrderRow | null>;
}

interface D1OrderRecord {
  order_id: string;
  event_id: string | null;
  last_action: string;
  status: OrderStatus;
  eventbrite_status: string | null;
  amount: string | null;
  currency: string | null;
  order_created: string | null;
  matched_donor_item_id: string | null;
  monday_item_id: string | null;
  error: string | null;
  deliveries: number;
  received_at: string;
  written_at: string | null;
}

function toOrderRow(record: D1OrderRecord): OrderRow {
  return {
    orderId: record.order_id,
    eventId: record.event_id,
    lastAction: record.last_action,
    status: record.status,
    eventbriteStatus: record.eventbrite_status,
    amount: record.amount,
    currency: record.currency,
    orderCreated: record.order_created,
    matchedDonorItemId: record.matched_donor_item_id,
    mondayItemId: record.monday_item_id,
    error: record.error,
    deliveries: record.deliveries,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
  };
}

const COLUMNS =
  'order_id, event_id, last_action, status, eventbrite_status, amount, currency, order_created, matched_donor_item_id, monday_item_id, error, deliveries, received_at, written_at';

// D1 caps a statement at 100 bound parameters.
const KNOWN_IDS_CHUNK = 100;

export class D1OrderStore implements OrderStore {
  constructor(private db: D1Database) {}

  // Which of `orderIds` the ledger has a row for, whatever its status: the missed-order check
  // (src/missedOrders/check.ts) only asks whether a delivery ever arrived.
  async knownOrderIds(orderIds: string[]): Promise<Set<string>> {
    const known = new Set<string>();
    for (let i = 0; i < orderIds.length; i += KNOWN_IDS_CHUNK) {
      const chunk = orderIds.slice(i, i + KNOWN_IDS_CHUNK);
      const placeholders = chunk.map((_, j) => `?${j + 1}`).join(', ');
      const { results } = await this.db.prepare(`SELECT order_id FROM orders WHERE order_id IN (${placeholders})`).bind(...chunk).all<{ order_id: string }>();
      for (const row of results) known.add(row.order_id);
    }
    return known;
  }

  async recordDelivery(delivery: NewDelivery): Promise<'inserted' | 'updated'> {
    // The pre-SELECT only classifies the result; the primary key is what makes a concurrent
    // insert of the same order land on the ON CONFLICT path.
    const existing = await this.db.prepare(`SELECT order_id FROM orders WHERE order_id = ?1`).bind(delivery.orderId).first<{ order_id: string }>();
    await this.db
      .prepare(
        `INSERT INTO orders (order_id, last_action, status, deliveries, received_at)
         VALUES (?1, ?2, 'received', 1, ?3)
         ON CONFLICT (order_id) DO UPDATE SET
           last_action = excluded.last_action,
           status = 'received',
           error = NULL,
           deliveries = orders.deliveries + 1,
           received_at = excluded.received_at`
      )
      .bind(delivery.orderId, delivery.action, delivery.receivedAt)
      .run();
    return existing === null ? 'inserted' : 'updated';
  }

  async updateStatus(orderId: string, status: OrderStatus, patch: OrderStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE orders SET
           status = ?2,
           event_id = COALESCE(?3, event_id),
           eventbrite_status = COALESCE(?4, eventbrite_status),
           amount = COALESCE(?5, amount),
           currency = COALESCE(?6, currency),
           order_created = COALESCE(?7, order_created),
           matched_donor_item_id = COALESCE(?8, matched_donor_item_id),
           monday_item_id = COALESCE(?9, monday_item_id),
           error = ?10,
           written_at = COALESCE(?11, written_at)
         WHERE order_id = ?1`
      )
      .bind(
        orderId,
        status,
        patch.eventId ?? null,
        patch.eventbriteStatus ?? null,
        patch.amount ?? null,
        patch.currency ?? null,
        patch.orderCreated ?? null,
        patch.matchedDonorItemId ?? null,
        patch.mondayItemId ?? null,
        patch.error ?? null,
        patch.writtenAt ?? null
      )
      .run();
  }

  async getOrder(orderId: string): Promise<OrderRow | null> {
    const record = await this.db.prepare(`SELECT ${COLUMNS} FROM orders WHERE order_id = ?1`).bind(orderId).first<D1OrderRecord>();
    return record === null ? null : toOrderRow(record);
  }
}
