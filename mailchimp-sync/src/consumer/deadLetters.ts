import { CREDENTIALS_REJECTED_MARKER } from '../mailchimp/client';
import type { InboundSyncMessage, OutboundSyncMessage, PendingRow, PendingStatus } from '../types';
import type { QueueMessageLike } from './outbound';
import { errorText, memberId } from '../logSafe';

// Consumer for the four mailchimp-sync DLQs (#37): mailchimp-sync-{outbound,inbound}-dlq and
// their -sandbox- twins. Mirrors funraise-sync's and donation-rollups' processDeadLetters.ts.
// Until this existed nothing consumed them: a sync that exhausted its retries expired there
// unseen after the queue's retention, leaving a pending row whose 'failed' status looked the
// same as a failure still being retried. A dead message now stamps its row's error with
// DEAD_LETTER_PREFIX (keeping the last error the consumer recorded), and each batch logs ONE
// console.error naming every affected Monday item / Mailchimp member, sent as ONE alert too when
// SLACK_WEBHOOK_URL is set. Nothing is re-driven from
// here — scripts/redrive-dead-lettered.mjs is the tool once the cause is fixed.
//
// A dead message is only evidence about the row as of the moment it was sent (donation-rollups'
// first-deploy incident: attaching a DLQ consumer to a backlog downgraded rows that had since
// been written by hand). So a row written at or after the message was sent, a row 'skipped'
// (only a completed delivery sets that), or a row replaced by a newer webhook delivery since
// (which carries its own queue message) is left alone.
//
// Inbound rows are keyed by email address. Logs name the Mailchimp member id instead (see
// src/logSafe.ts), so no address ever reaches Workers Logs from here.

export const DEAD_LETTER_PREFIX = 'dead-lettered after retries: ';

// A D1 failure while marking is retried after this delay, bounded by the DLQ consumer's
// max_retries in wrangler.jsonc (2, no further DLQ) — never an unbounded wedge.
const D1_RETRY_DELAY_SECONDS = 60;

export interface DeadLetterMessage<T> extends QueueMessageLike<T> {
  // Cloudflare's Message.timestamp — when the message was first sent. Optional for tests.
  timestamp?: Date;
}

export interface DeadLetterStore {
  get(key: string): Promise<PendingRow | null>;
  updateStatus(key: string, status: PendingStatus, error?: string): Promise<void>;
}

export interface DeadLetterDeps {
  store: DeadLetterStore;
  // One alert per batch that dead-lettered anything (src/alert.ts; a no-op when
  // SLACK_WEBHOOK_URL is unset). Runs after every ack, and a failure here is only logged.
  alert?: (text: string) => Promise<void>;
}

export type Direction = 'outbound' | 'inbound';

// What a batch dead-lettered, for the one log line (and alert) per batch.
export interface DeadLetterSummary {
  direction: Direction;
  ids: string[];
  credentialsRejected: boolean;
}

export function isCredentialsError(error: string | null): boolean {
  return error !== null && error.includes(CREDENTIALS_REJECTED_MARKER);
}

export async function processOutboundDeadLetters(
  messages: readonly DeadLetterMessage<OutboundSyncMessage>[],
  deps: DeadLetterDeps,
): Promise<DeadLetterSummary> {
  return processDeadLetters('outbound', messages, (body) => body.donorItemId, (body) => body.donorItemId, deps);
}

export async function processInboundDeadLetters(
  messages: readonly DeadLetterMessage<InboundSyncMessage>[],
  deps: DeadLetterDeps,
): Promise<DeadLetterSummary> {
  return processDeadLetters('inbound', messages, (body) => body.email, (body) => memberId(body.email), deps);
}

async function processDeadLetters<T>(
  direction: Direction,
  messages: readonly DeadLetterMessage<T>[],
  keyOf: (body: T) => string,
  // What logs may name: the Monday item id (outbound) or the Mailchimp member id (inbound).
  logIdOf: (body: T) => string,
  deps: DeadLetterDeps,
): Promise<DeadLetterSummary> {
  const summary: DeadLetterSummary = { direction, ids: [], credentialsRejected: false };
  const what = direction === 'outbound' ? 'Monday item' : 'Mailchimp member';
  for (const message of messages) {
    // A body missing its key can't be marked; log and ack it on its own. Throwing here would
    // fail the whole batch, and after the DLQ consumer's retries (no further DLQ) the good
    // letters in it would be dropped unmarked. The body itself is never logged (it may hold
    // an email address).
    let key: string;
    let logId: string;
    try {
      const k = keyOf(message.body);
      if (typeof k !== 'string' || k.trim() === '') throw new Error('missing key');
      key = k;
      logId = logIdOf(message.body);
    } catch {
      console.error(`mailchimp-sync ${direction} dlq: malformed dead letter (no ${direction === 'outbound' ? 'donorItemId' : 'email'}); acking without marking anything`);
      message.ack();
      continue;
    }
    try {
      const row = await deps.store.get(key);
      const sentAt = message.timestamp?.toISOString();
      if (row === null) {
        console.warn(`mailchimp-sync ${direction} dlq: no pending row for ${what} ${logId}; nothing to mark`);
        message.ack();
        continue;
      }
      const writtenSince = row.status === 'written' && row.writtenAt !== null && (sentAt === undefined || row.writtenAt >= sentAt);
      const replacedSince = sentAt !== undefined && row.receivedAt > sentAt;
      if (writtenSince || row.status === 'skipped' || replacedSince) {
        console.log(
          `mailchimp-sync ${direction} dlq: stale dead letter for ${what} ${logId} — row is ${row.status} ` +
            `(received ${row.receivedAt}, written ${row.writtenAt ?? 'never'}), message sent ${sentAt ?? '(unknown)'}; leaving it`,
        );
        message.ack();
        continue;
      }
      const prior = row.error ?? '(no recorded error)';
      await deps.store.updateStatus(key, 'failed', prior.startsWith(DEAD_LETTER_PREFIX) ? prior : `${DEAD_LETTER_PREFIX}${prior}`);
      summary.ids.push(logId);
      if (isCredentialsError(row.error)) summary.credentialsRejected = true;
      message.ack();
    } catch (err) {
      console.error(`mailchimp-sync ${direction} dlq: could not mark ${what} ${logId} dead-lettered: ${errorText(err)}`);
      message.retry({ delaySeconds: D1_RETRY_DELAY_SECONDS });
    }
  }
  if (summary.ids.length > 0) {
    const report = deadLetterReport(summary);
    console.error(report);
    if (deps.alert) {
      try {
        await deps.alert(report);
      } catch (err) {
        console.error(`mailchimp-sync ${direction} dlq: alert failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return summary;
}

// The one line per batch — also the alert text (src/alert.ts).
export function deadLetterReport(summary: DeadLetterSummary): string {
  const { direction, ids, credentialsRejected } = summary;
  const n = ids.length;
  const s = n === 1 ? '' : 's';
  const headline = credentialsRejected
    ? 'MAILCHIMP CREDENTIALS REJECTED — the MAILCHIMP_API_KEY secret is invalid, revoked, or lacks access; fix it before replaying. '
    : '';
  const detail =
    direction === 'outbound'
      ? `Monday Donor item${s} ${ids.join(', ')} not synced to Mailchimp. See pending_outbound_syncs.error`
      : `Mailchimp member id${s} ${ids.join(', ')} not synced to Monday. See pending_inbound_syncs.error`;
  return (
    `mailchimp-sync: ${headline}${n} ${direction} message${s} dead-lettered after exhausting retries — ${detail}; ` +
    `re-drive with scripts/redrive-dead-lettered.mjs --direction ${direction} once the cause is fixed.`
  );
}
