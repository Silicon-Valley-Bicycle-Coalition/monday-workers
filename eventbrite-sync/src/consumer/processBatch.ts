import type { OrderStore } from '../db/orders';
import type { EventStore } from '../db/events';
import type { AttendeeStore } from '../db/attendees';
import type { QueueLike } from '../webhook/route';
import type { EventbriteClient } from '../eventbrite/client';
import type { MondayClient } from '../monday/client';
import type { EventbriteSyncConfig } from '../types';
import { PLACEHOLDER_COLUMN_ID } from '../config';
import { isItemGone } from '../monday/itemGone';
import { mapOrder } from '../mapping/order';
import { matchDonor } from '../matching/donors';
import { errorMessage } from '../util/errorMessage';
import { linkedItemId } from '../util/itemId';
import { logDebug, messageDisposition, retryDelaySeconds, type WriteStamp } from '../flags';
import { dryRunConsumerDeps, type BatchSkipContext } from '../writeSwitch';
import { describeMessage, messageDeliveryId } from './messages';
import { processEvent } from './processEvent';
import { processAttendee } from './processAttendee';

export interface QueueMessageLike<T> {
  body: T;
  // Cloudflare's Message.attempts (1 on first delivery) and Message.timestamp (when it was
  // sent). Optional so tests and callers that don't care can omit them.
  attempts?: number;
  timestamp?: Date;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

const REQUIRED_WRITE_COLUMNS = ['amountColumn', 'statusColumn', 'dateColumn', 'donorEmailColumn', 'donorLinkColumn'] as const;

// `writeStamp` (flags.ts): set by the producer when the write switch was `off` at ingest. A body
// enqueued before the switch existed has no such key and is live.
export type OrderQueueMessage = {
  // Absent on messages queued before event/attendee messages existed: no kind means order.
  kind?: 'order';
  orderId: string;
  // The webhook action that enqueued it — informational; the consumer always re-fetches.
  action: string;
} & WriteStamp;

export type EventQueueMessage = {
  kind: 'event';
  eventId: string;
  action: string;
} & WriteStamp;

export type AttendeeQueueMessage = {
  kind: 'attendee';
  eventId: string;
  attendeeId: string;
  action: string;
} & WriteStamp;

export type WriteQueueMessage = OrderQueueMessage | EventQueueMessage | AttendeeQueueMessage;

export interface ProcessBatchDeps {
  orderStore: OrderStore;
  eventStore: EventStore;
  attendeeStore: AttendeeStore;
  // For fanning an event out into per-attendee messages.
  queue: QueueLike;
  eventbriteClient: EventbriteClient;
  mondayClient: MondayClient;
  config: EventbriteSyncConfig;
}

/**
 * The queue() entry point for the write queue: the write switch's per-message decision in front
 * of processOrderQueueBatch, for every message kind. `write` runs it with the real deps; `dry-run` runs the same code
 * against recording/read-only deps (src/writeSwitch.ts), which then acks; `retry` (`hold`, or a
 * KV read failure) leaves the message on the queue untouched, backing off like any retry.
 */
export async function consumeWriteBatch(messages: QueueMessageLike<WriteQueueMessage>[], deps: ProcessBatchDeps, gate: BatchSkipContext): Promise<void> {
  for (const message of messages) {
    const ctx = { ...gate, deliveryId: messageDeliveryId(message.body) };
    const disposition = messageDisposition(gate.mode, message.body);
    logDebug(ctx, 'disposition', { disposition, writeStamp: message.body.writeStamp ?? null, attempts: message.attempts ?? null });
    if (disposition === 'retry') {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      continue;
    }
    await processOrderQueueBatch([message], disposition === 'write' ? deps : dryRunConsumerDeps(deps, ctx, message.body.kind ?? 'order'));
  }
}

export async function processOrderQueueBatch(messages: QueueMessageLike<WriteQueueMessage>[], deps: ProcessBatchDeps): Promise<void> {
  for (const message of messages) {
    const body = message.body;
    const label = describeMessage(body);
    try {
      if (body.kind === 'event') await processEvent(body, deps);
      else if (body.kind === 'attendee') await processAttendee(body, deps);
      else await processOne(body.orderId, deps);
      message.ack();
    } catch (err) {
      const errMsg = errorMessage(err);
      console.error(`eventbrite-sync consumer: failed to process ${label}: ${errMsg}`);
      // Recording the failure is bookkeeping; a D1 error here must not take the retry decision
      // down with it (the throw would fail the whole batch and retry every message immediately).
      try {
        if (body.kind === 'event') await deps.eventStore.updateStatus(body.eventId, 'failed', { error: errMsg });
        else if (body.kind === 'attendee') await deps.attendeeStore.updateStatus(body.attendeeId, 'failed', { error: errMsg });
        else await deps.orderStore.updateStatus(body.orderId, 'failed', { error: errMsg });
      } catch (recordErr) {
        console.error(`eventbrite-sync consumer: could not record failure for ${label}: ${errorMessage(recordErr)}`);
      }
      // Every failure here is retryable, as before; only the delay is shared now — 1 minute
      // doubling to an hour, across wrangler.jsonc's max_retries of 100 (about four days).
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

async function processOne(orderId: string, deps: ProcessBatchDeps): Promise<void> {
  const { orderStore, eventbriteClient, mondayClient, config } = deps;
  const row = await orderStore.getOrder(orderId);
  if (row === null) {
    throw new Error(`eventbrite-sync consumer: no orders row for "${orderId}"`);
  }

  const boardId = config.monday.boards['donations:live'];
  if (boardId === null) {
    throw new Error('config: monday.boards["donations:live"] is not configured');
  }
  const { orderIdColumn, donorLinkColumn } = config.eventbriteSync;
  // The idempotency key. Without the column nothing may be created: a create without it could
  // never be adopted later, so this is a retry-then-dead-letter failure with the fix in its
  // message — add the column, put its id in config, re-drive (README "Prerequisite column").
  if (orderIdColumn === PLACEHOLDER_COLUMN_ID) {
    throw new Error('config: eventbriteSync.orderIdColumn is the placeholder — add the "Eventbrite Order ID" text column to the Donations board and set its id before any order can be written');
  }
  // Every other column the write needs, checked up front: left as the shipped placeholder, Monday
  // rejects the write with an opaque column error that is retried and dead-lettered, and the
  // fix (real ids in config/svbc.json) is nowhere in that message.
  const unset = REQUIRED_WRITE_COLUMNS.filter((key) => config.eventbriteSync[key] === PLACEHOLDER_COLUMN_ID);
  if (unset.length > 0) {
    throw new Error(`config: eventbriteSync.${unset.join(', eventbriteSync.')} still the placeholder — set the real Monday column id${unset.length > 1 ? 's' : ''} in config before any order can be written`);
  }

  // Always the current state from Eventbrite, never the delivery: the delivery carried only a
  // pointer, and whatever Eventbrite says now is what the board should say.
  const order = await eventbriteClient.getOrder(orderId);
  if (order === null) {
    // A deleted order, or a dashboard Test delivery pointing at nothing. A retry cannot help.
    console.warn(`eventbrite-sync consumer: order "${orderId}" not found in Eventbrite (HTTP 404); marking failed without retry`);
    await orderStore.updateStatus(orderId, 'failed', { error: 'order not found in Eventbrite (HTTP 404)' });
    return;
  }

  // Adopt before create: a Donations item already carrying this order id — this Worker's own
  // orphan (a create whose D1 update was lost), a backfill re-run, or a gift staff entered by
  // hand with the id filled in — is updated, never duplicated. The ledger's item id short-circuits
  // the lookup; a miss on both means create.
  let mondayItemId = row.mondayItemId;
  let adopted = false;
  if (mondayItemId === null) {
    const existing = await mondayClient.findItemByColumnValue(boardId, orderIdColumn, orderId);
    if (existing) {
      mondayItemId = existing.id;
      adopted = true;
    }
  }

  const mapping = mapOrder(order, config, { hasItem: mondayItemId !== null });
  if (mapping.outcome === 'skip') {
    console.log(`eventbrite-sync consumer: skipped order "${orderId}": ${mapping.reason}`);
    await orderStore.updateStatus(orderId, 'skipped', { ...definedFacts(mapping.facts), error: mapping.reason });
    return;
  }
  if (mapping.outcome === 'review') {
    console.warn(`eventbrite-sync consumer: order "${orderId}" not written: ${mapping.reason}`);
    await orderStore.updateStatus(orderId, 'failed', { ...definedFacts(mapping.facts), error: mapping.reason });
    return;
  }

  // Donor: cached on the row after the first match so retries and later updates don't re-run
  // it. A match or create failure throws — retry, then DLQ — as in funraise-sync: a gift with
  // no donor is worse than a late one. An order with no email is written without the link.
  let donorItemId = row.matchedDonorItemId;
  if (donorItemId === null) {
    const match = await matchDonor(mondayClient, config, { email: order.email, name: order.name });
    if (match.donorItemId === null) {
      console.warn(`eventbrite-sync consumer: order "${orderId}" has no donor link: ${match.reason}`);
    } else {
      donorItemId = match.donorItemId;
      await orderStore.updateStatus(orderId, 'queued', { matchedDonorItemId: donorItemId });
    }
  }

  const columnValues = { ...mapping.columnValues };
  if (donorItemId !== null) {
    columnValues[donorLinkColumn] = { item_ids: [linkedItemId(donorItemId)] };
  }
  const facts = definedFacts(mapping.facts);
  const writtenAt = new Date().toISOString();

  if (mondayItemId !== null) {
    // An update of this Worker's own item keeps its Donor link current; an adopted item gets only
    // the order-owned columns — its Donor (and its stamps) were set by whoever created it.
    const { [donorLinkColumn]: _donorLink, ...adoptValues } = columnValues;
    try {
      await mondayClient.changeColumnValues(boardId, mondayItemId, adopted ? adoptValues : columnValues);
    } catch (err) {
      if (!isItemGone(err)) throw err;
      // Staff deleted (or archived) the Donations item. Retrying cannot help, and recreating it
      // would resurrect a gift someone removed on purpose — record it and stop, for a human.
      const reason = `Donations item ${mondayItemId} was deleted or archived; nothing written`;
      console.warn(`eventbrite-sync consumer: order "${orderId}": ${reason}`);
      await orderStore.updateStatus(orderId, 'failed', { ...facts, error: reason });
      return;
    }
    await orderStore.updateStatus(orderId, 'written', { ...facts, mondayItemId, writtenAt });
    return;
  }

  const item = await mondayClient.createItem(boardId, mapping.itemName, { ...columnValues, ...mapping.firstWriteValues });
  await orderStore.updateStatus(orderId, 'written', { ...facts, mondayItemId: item.id, writtenAt });
}

// The ledger's COALESCE keeps an old value on null, so only hand over facts that exist.
function definedFacts(facts: { eventId: string | null; eventbriteStatus: string | null; amount: string | null; currency: string | null; orderCreated: string | null }) {
  const out: { eventId?: string; eventbriteStatus?: string; amount?: string; currency?: string; orderCreated?: string } = {};
  if (facts.eventId !== null) out.eventId = facts.eventId;
  if (facts.eventbriteStatus !== null) out.eventbriteStatus = facts.eventbriteStatus;
  if (facts.amount !== null) out.amount = facts.amount;
  if (facts.currency !== null) out.currency = facts.currency;
  if (facts.orderCreated !== null) out.orderCreated = facts.orderCreated;
  return out;
}
