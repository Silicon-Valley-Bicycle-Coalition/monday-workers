import type { EventStore } from '../db/events';
import type { FunraiseQueueMessage, QueueMessageLike } from './processBatch';
import { errorMessage } from '../util/errorMessage';

// Consumer for funraise-sync-writes-dlq (GL#25), mirroring donation-rollups'
// src/consumer/processDeadLetters.ts. Until this existed nothing consumed the DLQ: a gift that
// exhausted its retries expired there unseen after ~4 days, and the only trace was an events row
// whose 'failed' status looked the same as a failure still being retried. A dead message now
// stamps its row's error with DEAD_LETTER_PREFIX (keeping the last error the consumer recorded)
// and the batch logs ONE console.error naming every transaction — visible in Workers Logs.
// Nothing is re-driven from here: a dead-lettered gift is a signal for a human, and
// scripts/redrive-failed.mjs is the tool once the cause (a missing status label, a Monday
// outage) is fixed.
//
// A dead message is only evidence about the row as of the moment it was sent (donation-rollups'
// first-deploy incident: attaching a DLQ consumer to a backlog downgraded rows that had since been
// written by hand). So a row written at or after the message was sent, or replaced by a newer
// Funraise delivery since then (which carries its own queue message), is left alone.
export interface DeadLetterDeps {
  eventStore: EventStore;
}

export const DEAD_LETTER_PREFIX = 'dead-lettered after retries: ';

export async function processDeadLetters(
  messages: QueueMessageLike<FunraiseQueueMessage>[],
  deps: DeadLetterDeps
): Promise<void> {
  const dead: string[] = [];
  for (const message of messages) {
    const { entityType, entityId } = message.body;
    try {
      const row = await deps.eventStore.getEventByEntity(entityType, entityId);
      const sentAt = message.timestamp?.toISOString();
      if (row === null) {
        console.warn(`funraise-sync dlq: no events row for ${entityType} "${entityId}"; nothing to mark`);
        message.ack();
        continue;
      }
      const writtenSince = row.status === 'written' && row.writtenAt !== null && (sentAt === undefined || row.writtenAt >= sentAt);
      const replacedSince = sentAt !== undefined && row.receivedAt > sentAt;
      if (writtenSince || replacedSince) {
        console.log(
          `funraise-sync dlq: stale dead letter for ${entityType} "${entityId}" — row is ${row.status} (received ${row.receivedAt}, written ${row.writtenAt ?? 'never'}), message sent ${sentAt ?? '(unknown)'}; leaving it`
        );
        message.ack();
        continue;
      }
      const prior = row.error ?? '(no recorded error)';
      await deps.eventStore.updateStatusByEntity(entityType, entityId, 'failed', {
        error: prior.startsWith(DEAD_LETTER_PREFIX) ? prior : `${DEAD_LETTER_PREFIX}${prior}`,
      });
      dead.push(entityId);
      message.ack();
    } catch (err) {
      console.error(`funraise-sync dlq: could not mark ${entityType} "${entityId}" dead-lettered: ${errorMessage(err)}`);
      message.retry({ delaySeconds: 60 });
    }
  }
  if (dead.length > 0) {
    console.error(
      `funraise-sync: ${dead.length} transaction${dead.length === 1 ? '' : 's'} dead-lettered after exhausting retries — ` +
        `${dead.join(', ')}. Not on the Donations board (or not updated there). See events.error for each; ` +
        `re-drive with scripts/redrive-failed.mjs once the cause is fixed.`
    );
  }
}
