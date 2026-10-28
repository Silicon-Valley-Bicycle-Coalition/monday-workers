import type { PendingStore } from '../db/pending';
import type { DonationRollupsMondayClient } from '../monday/client';
import type { DonationRollupsConfig, RecomputeQueueMessage } from '../types';
import type { QueueMessageLike } from './processBatch';
import { isD1QuotaError, secondsUntilMidnightUTC } from './quota';
import { retryDelaySeconds } from '../flags';

// Consumer for donation-rollups-recompute-dlq (README "operational findings, 2026-09-17",
// fix 5). Until this existed the DLQ had no consumer: the 09-03/09-09 messages that exhausted
// their retries expired unseen after four days and their pending rows stayed 'queued' forever.
// A dead message now marks its pending row 'failed' (keeping the last error the consumer
// recorded) and the batch raises ONE alert on the custodian alert item. Nothing is re-driven
// from here — a dead-lettered row is a signal for a human (scripts/redrive-pending.mjs is the
// tool once the cause is understood), not something to retry forever.
//
// A dead message is only evidence about the row AS OF THE MOMENT IT WAS SENT. The first deploy
// (2026-09-18 20:38 UTC) attached this consumer to a DLQ still holding messages whose rows had
// since been re-driven and written by hand; marking them failed downgraded 300 correct rows and
// posted 35 alerts before delivery was paused. So: a row already 'written' at or after the
// message was sent is left alone (stale), and a written row is never downgraded by a message
// with no timestamp at all.
export interface DeadLetterDeps {
  pendingStore: PendingStore;
  mondayClient: Pick<DonationRollupsMondayClient, 'createUpdate'>;
  config: DonationRollupsConfig;
  now?: Date;
}

export const DEAD_LETTER_PREFIX = 'dead-lettered after retries: ';

export async function processDeadLetters(
  messages: QueueMessageLike<RecomputeQueueMessage>[], deps: DeadLetterDeps,
): Promise<void> {
  const dead: string[] = [];
  let quotaDelaySeconds: number | null = null;
  for (const message of messages) {
    const { donationItemId } = message.body;
    if (quotaDelaySeconds !== null) {
      message.retry({ delaySeconds: quotaDelaySeconds });
      continue;
    }
    try {
      const row = await deps.pendingStore.getPending(donationItemId);
      const sentAt = message.timestamp?.toISOString();
      if (row?.status === 'written' && row.writtenAt !== null && (sentAt === undefined || row.writtenAt >= sentAt)) {
        console.log(`donation-rollups dlq: stale dead letter for donation "${donationItemId}" — row written at ${row.writtenAt}, message sent ${sentAt ?? '(unknown)'}; leaving it`);
        message.ack();
        continue;
      }
      const prior = row?.error ?? '(no recorded error)';
      await deps.pendingStore.updateStatus(donationItemId, 'failed', {
        error: prior.startsWith(DEAD_LETTER_PREFIX) ? prior : `${DEAD_LETTER_PREFIX}${prior}`,
      });
      dead.push(donationItemId);
      message.ack();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`donation-rollups dlq: could not mark donation "${donationItemId}" failed: ${errMsg}`);
      // Same rule as the main consumer (fix 4): a D1 daily-quota error is only worth retrying
      // after midnight UTC, and the rest of the batch would hit it too.
      if (isD1QuotaError(err)) {
        quotaDelaySeconds = secondsUntilMidnightUTC(deps.now ?? new Date());
        message.retry({ delaySeconds: quotaDelaySeconds });
      } else {
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  }
  if (dead.length > 0) await alert(deps, dead);
}

// Same shape as custodian/custodian.ts alert(): console.error always, one Monday update on
// custodian.alertItemId when configured, and never a throw — the acks above already happened.
async function alert(deps: DeadLetterDeps, dead: string[]): Promise<void> {
  const message =
    `donation-rollups: ${dead.length} recompute message${dead.length === 1 ? '' : 's'} dead-lettered after exhausting retries — ` +
    `pending rows marked failed for donation${dead.length === 1 ? '' : 's'} ${dead.join(', ')}. ` +
    `See pending_recomputes.error for each; re-drive with scripts/redrive-pending.mjs --status failed once the cause is fixed.`;
  console.error(message);
  const { alertItemId } = deps.config.custodian;
  if (alertItemId === null) return;
  try {
    await deps.mondayClient.createUpdate(alertItemId, message);
  } catch (err) {
    console.error(`donation-rollups dlq: posting alert to Monday item ${alertItemId} failed: ${String(err)}`);
  }
}
