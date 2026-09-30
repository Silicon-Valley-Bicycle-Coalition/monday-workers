import type { MondayEventStore } from '../db/mondayEvents';
import type { QbEventStore } from '../db/qbEvents';
import type { QueueMessage } from '../types';
import type { QueueMessageLike } from './processBatch';

// Consumer for quickbooks-sync-writes-dlq (#33), same shape as donation-rollups' and
// funraise-sync's. Without it a message that exhausted its retries expired unseen in the DLQ
// after ~4 days, leaving a 'failed' row indistinguishable from one still being retried. A dead
// message now stamps its row's error with DEAD_LETTER_PREFIX (keeping the last error the consumer
// recorded) and the batch logs one error. Nothing is re-driven from here — a dead-lettered row is
// a signal for a human (README "Dead letters and redrive").
//
// A dead message is only evidence about the row AS OF THE MOMENT IT WAS SENT: a row already
// 'written' at or after that moment (redriven since) is left alone, and a written row is never
// downgraded by a message with no timestamp.
export interface DeadLetterDeps {
  qbEventStore: QbEventStore;
  mondayEventStore: MondayEventStore;
}

export const DEAD_LETTER_PREFIX = 'dead-lettered after retries: ';

export async function processDeadLetters(messages: QueueMessageLike<QueueMessage>[], deps: DeadLetterDeps): Promise<void> {
  const dead: string[] = [];
  for (const message of messages) {
    const { direction, eventId } = message.body;
    const store = direction === 'qb-to-monday' ? deps.qbEventStore : deps.mondayEventStore;
    try {
      const row = await store.getEvent(eventId);
      const sentAt = message.timestamp?.toISOString();
      if (row?.status === 'written' && row.writtenAt !== null && (sentAt === undefined || row.writtenAt >= sentAt)) {
        console.log(`quickbooks-sync dlq: stale dead letter for ${direction} "${eventId}" — row written at ${row.writtenAt}; leaving it`);
        message.ack();
        continue;
      }
      const prior = row?.error ?? '(no recorded error)';
      await store.updateStatus(eventId, 'failed', {
        error: prior.startsWith(DEAD_LETTER_PREFIX) ? prior : `${DEAD_LETTER_PREFIX}${prior}`,
      });
      dead.push(`${direction} ${eventId}`);
      message.ack();
    } catch (err) {
      console.error(`quickbooks-sync dlq: could not mark ${direction} "${eventId}" failed: ${err instanceof Error ? err.message : String(err)}`);
      // Delayed like funraise-sync's DLQ consumer (#35): a bare retry() comes straight back into
      // the same D1 failure and burns the DLQ's own retries in seconds.
      message.retry({ delaySeconds: 60 });
    }
  }
  if (dead.length > 0) {
    console.error(
      `quickbooks-sync: ${dead.length} message${dead.length === 1 ? '' : 's'} dead-lettered after exhausting retries — ` +
        `rows marked failed: ${dead.join(', ')}. See qb_events.error / monday_events.error; redrive per README once the cause is fixed.`
    );
  }
}
