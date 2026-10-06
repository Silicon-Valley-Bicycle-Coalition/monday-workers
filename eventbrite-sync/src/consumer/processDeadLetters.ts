import type { OrderStore } from '../db/orders';
import type { OrderQueueMessage, QueueMessageLike } from './processBatch';
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
}

export const DEAD_LETTER_PREFIX = 'dead-lettered after retries: ';

export async function processDeadLetters(messages: QueueMessageLike<OrderQueueMessage>[], deps: DeadLetterDeps): Promise<void> {
  const dead: string[] = [];
  for (const message of messages) {
    const { orderId } = message.body;
    try {
      const row = await deps.orderStore.getOrder(orderId);
      const sentAt = message.timestamp?.toISOString();
      if (row === null) {
        console.warn(`eventbrite-sync dlq: no orders row for "${orderId}"; nothing to mark`);
        message.ack();
        continue;
      }
      const writtenSince = row.status === 'written' && row.writtenAt !== null && (sentAt === undefined || row.writtenAt >= sentAt);
      const replacedSince = sentAt !== undefined && row.receivedAt > sentAt;
      if (writtenSince || replacedSince) {
        console.log(
          `eventbrite-sync dlq: stale dead letter for order "${orderId}" — row is ${row.status} (received ${row.receivedAt}, written ${row.writtenAt ?? 'never'}), message sent ${sentAt ?? '(unknown)'}; leaving it`
        );
        message.ack();
        continue;
      }
      const prior = row.error ?? '(no recorded error)';
      await deps.orderStore.updateStatus(orderId, 'failed', {
        error: prior.startsWith(DEAD_LETTER_PREFIX) ? prior : `${DEAD_LETTER_PREFIX}${prior}`,
      });
      dead.push(orderId);
      message.ack();
    } catch (err) {
      console.error(`eventbrite-sync dlq: could not mark order "${orderId}" dead-lettered: ${errorMessage(err)}`);
      message.retry({ delaySeconds: 60 });
    }
  }
  if (dead.length > 0) {
    console.error(
      `eventbrite-sync: ${dead.length} order${dead.length === 1 ? '' : 's'} dead-lettered after exhausting retries — ` +
        `${dead.join(', ')}. Not on the Donations board (or not updated there). See orders.error for each; ` +
        `re-drive with scripts/backfill-orders.mjs once the cause is fixed.`
    );
  }
}
