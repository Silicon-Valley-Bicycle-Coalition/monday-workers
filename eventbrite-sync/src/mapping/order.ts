import type { EventbriteOrder } from '../eventbrite/client';
import type { EventbriteSyncConfig } from '../types';
import { toISODate } from '../util/isoDate';
import { fiscalYearEnding } from './fiscalYear';

// A fetched order, reduced to what the Donations write needs. Pure: no Monday, no D1.
export type OrderMapping =
  | { outcome: 'skip'; reason: string; facts: OrderFacts }
  | {
      outcome: 'write';
      itemName: string;
      // Order-owned columns: written on create, update and adopt alike.
      columnValues: Record<string, unknown>;
      // First-write stamps (Thank You Sent, Gift Type, Fiscal Year Ending): create only.
      firstWriteValues: Record<string, unknown>;
      facts: OrderFacts;
    };

// What the ledger records about the order as last seen — none of it personal.
export interface OrderFacts {
  eventId: string | null;
  eventbriteStatus: string | null;
  amount: string | null;
  currency: string | null;
  orderCreated: string | null;
}

export interface MapOptions {
  // Whether a Donations item already exists for this order (ledger or adoption). A free order
  // is skipped only when it has no item yet — an item on the board is always updated, so a
  // refund that zeroes `gross` can never be masked by the skip (spec decision 6).
  hasItem: boolean;
}

export function mapOrder(order: EventbriteOrder, config: EventbriteSyncConfig, options: MapOptions): OrderMapping {
  const sync = config.eventbriteSync;
  const cost = order.costs?.[sync.amountSource] ?? null;
  const amount = cost?.major_value ?? null;
  const facts: OrderFacts = {
    eventId: order.event_id ?? order.event?.id ?? null,
    eventbriteStatus: order.status ?? null,
    amount,
    currency: cost?.currency ?? null,
    orderCreated: order.created ?? null,
  };

  const status = order.status ?? null;
  const label = status === null ? undefined : sync.statusLabelMap[status];
  if (label === undefined) {
    return { outcome: 'skip', reason: `order status "${status ?? '(none)'}" is not a mapped Donations label — not giving`, facts };
  }

  const amountNumber = amount === null ? 0 : Number(amount);
  if (!Number.isFinite(amountNumber)) {
    return { outcome: 'skip', reason: `order costs.${sync.amountSource}.major_value "${amount}" is not a number`, facts };
  }
  if (sync.skipFreeOrders && amountNumber === 0 && !options.hasItem) {
    return { outcome: 'skip', reason: 'free order (amount 0) with no Donations item — not giving', facts };
  }

  const columnValues: Record<string, unknown> = {
    [sync.amountColumn]: amountNumber,
    [sync.statusColumn]: label,
    [sync.orderIdColumn]: order.id,
  };
  // Monday's date column wants { date: 'YYYY-MM-DD' }; the order's `created` is a UTC timestamp,
  // normalized to the Pacific calendar day. Left out rather than written raw when unparseable.
  const orderDate = toISODate(order.created ?? null);
  if (orderDate !== null) columnValues[sync.dateColumn] = { date: orderDate };

  const firstWriteValues: Record<string, unknown> = {};
  if (sync.thankYouSentColumn) firstWriteValues[sync.thankYouSentColumn] = { checked: 'true' };
  if (sync.giftTypeColumn) firstWriteValues[sync.giftTypeColumn] = sync.giftTypeValue;
  if (sync.fiscalYearColumn) {
    const fiscalYear = fiscalYearEnding(orderDate);
    if (fiscalYear !== null) firstWriteValues[sync.fiscalYearColumn] = fiscalYear;
  }

  return { outcome: 'write', itemName: itemName(order, sync.itemNameTemplate), columnValues, firstWriteValues, facts };
}

// `{buyer} - {event}` by default. Eventbrite's `name` is "the ticket buyer's name" and the
// event's `name.text` comes with the `event` expansion; either missing falls back so the item
// is still identifiable.
export function itemName(order: EventbriteOrder, template: string): string {
  const buyer = nonEmpty(order.name) ?? [order.first_name, order.last_name].map(nonEmpty).filter((s) => s !== null).join(' ');
  const event = nonEmpty(order.event?.name?.text) ?? '';
  const filled = template
    .replaceAll('{buyer}', buyer || 'Unknown buyer')
    .replaceAll('{event}', event || 'Eventbrite event')
    .replaceAll('{orderId}', order.id)
    .trim();
  return filled === '' ? `Eventbrite order ${order.id}` : filled;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
