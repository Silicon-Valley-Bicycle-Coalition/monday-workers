import type { OrderStore } from '../db/orders';
import type { EventStore } from '../db/events';
import type { AttendeeStore } from '../db/attendees';
import type { WriteQueueMessage, QueueMessageLike } from './processBatch';
import { describeMessage } from './messages';
import { errorMessage } from '../util/errorMessage';

// Consumer for eventbrite-sync-writes-dlq, mirroring funraise-sync's processDeadLetters (#25):
// a dead message stamps its orders row's error with DEAD_LETTER_PREFIX (keeping the last error
// the consumer recorded) and the batch logs ONE console.error naming every order — visible in
// Workers Logs — instead of expiring from the DLQ unseen. Nothing is re-driven from here: fix the
// cause (the missing column, a bad token, the missing Status label), then re-run
// scripts/backfill-orders.mjs for the affected event, which goes through the normal path.
//
// A dead message is only evidence about the row as of the moment it was sent, so a row written
// at or after that moment, or replaced by a newer delivery since, is left alone.
export interface DeadLetterDeps {
  orderStore: OrderStore;
  eventStore: EventStore;
  attendeeStore: AttendeeStore;
}

// What the dead-letter logic needs from any of the three ledgers, picked by the message's kind.
interface LedgerRow {
  status: string;
  error: string | null;
  receivedAt: string;
  writtenAt: string | null;
}
interface Ledger {
  noun: string;
  id: string;
  get(): Promise<LedgerRow | null>;
  markFailed(error: string): Promise<void>;
}

function ledgerFor(body: WriteQueueMessage, deps: DeadLetterDeps): Ledger {
  if (body.kind === 'event') {
    return { noun: 'event', id: body.eventId, get: () => deps.eventStore.getEvent(body.eventId), markFailed: (error) => deps.eventStore.updateStatus(body.eventId, 'failed', { error }) };
  }
  if (body.kind === 'attendee') {
    return { noun: 'attendee', id: body.attendeeId, get: () => deps.attendeeStore.getAttendee(body.attendeeId), markFailed: (error) => deps.attendeeStore.updateStatus(body.attendeeId, 'failed', { error }) };
  }
  return { noun: 'order', id: body.orderId, get: () => deps.orderStore.getOrder(body.orderId), markFailed: (error) => deps.orderStore.updateStatus(body.orderId, 'failed', { error }) };
}

export const DEAD_LETTER_PREFIX = 'dead-lettered after retries: ';

export async function processDeadLetters(messages: QueueMessageLike<WriteQueueMessage>[], deps: DeadLetterDeps): Promise<void> {
  const dead: string[] = [];
  let orderDead = false;
  for (const message of messages) {
    const ledger = ledgerFor(message.body, deps);
    const label = describeMessage(message.body);
    try {
      const row = await ledger.get();
      const sentAt = message.timestamp?.toISOString();
      if (row === null) {
        console.warn(`eventbrite-sync dlq: no ${ledger.noun}s row for "${ledger.id}"; nothing to mark`);
        message.ack();
        continue;
      }
      const writtenSince = row.status === 'written' && row.writtenAt !== null && (sentAt === undefined || row.writtenAt >= sentAt);
      const replacedSince = sentAt !== undefined && row.receivedAt > sentAt;
      if (writtenSince || replacedSince) {
        console.log(
          `eventbrite-sync dlq: stale dead letter for ${label} — row is ${row.status} (received ${row.receivedAt}, written ${row.writtenAt ?? 'never'}), message sent ${sentAt ?? '(unknown)'}; leaving it`
        );
        message.ack();
        continue;
      }
      const prior = row.error ?? '(no recorded error)';
      await ledger.markFailed(prior.startsWith(DEAD_LETTER_PREFIX) ? prior : `${DEAD_LETTER_PREFIX}${prior}`);
      dead.push(label);
      if (message.body.kind === undefined || message.body.kind === 'order') orderDead = true;
      message.ack();
    } catch (err) {
      console.error(`eventbrite-sync dlq: could not mark ${label} dead-lettered: ${errorMessage(err)}`);
      message.retry({ delaySeconds: 60 });
    }
  }
  if (dead.length > 0) {
    console.error(
      `eventbrite-sync: ${dead.length} message${dead.length === 1 ? '' : 's'} dead-lettered after exhausting retries — ` +
        `${dead.join(', ')}. Not on the board (or not updated there). See each ledger row's error; ` +
        (orderDead ? `re-drive orders with scripts/backfill-orders.mjs once the cause is fixed.` : `fix the cause, then redeliver from Eventbrite.`)
    );
  }
}
