import type { MondayClient } from '../monday/client';
import { DEAD_LETTER_PREFIX, type DonationRowRecord, type RowStore } from '../db/rows';
import type { BenevityImportConfig } from '../types';
import type { ParsedRow } from '../parse/report';
import { isWithheld } from '../matching/people';
import { ensureWorklistItem } from '../matching/worklist';
import { errorMessage } from '../util/errorMessage';
import type { BenevityQueueMessage, QueueMessageLike } from './processBatch';

// Consumer for benevity-import-writes-dlq and its -sandbox- twin (#60), modelled on
// mailchimp-sync's (#37). Until this existed nothing consumed them: a gift that exhausted its
// retries expired there unseen, its row left 'ingested' forever, and re-uploading the report was
// a no-op because the row was already recorded.
//
// A dead message now marks its row 'needs-review' with DEAD_LETTER_PREFIX ahead of the last
// error the consumer recorded — D1 first, so the failure is on record even while Monday is the
// thing that's down — and then raises a Benevity Uploads worklist item for it. 'needs-review' is
// the status a staff Retry already knows how to re-queue (#34), so the worklist item is the
// retry path, with nothing new to learn. Posting the item is a Monday write: it's attempted only
// while writes are `on`, and a failure is only logged, never retried here (the message is
// already acked) — sweepDeadLetteredRows, on the daily cron, posts any the consumer couldn't.
//
// A dead message is only evidence about the row as of the moment it was sent: a row no longer
// 'ingested' was written, held for review, or skipped since, and is left alone.

// A D1 failure while marking is retried after this delay, bounded by the DLQ consumer's
// max_retries in wrangler.jsonc (2, no further DLQ) — never an unbounded wedge.
const D1_RETRY_DELAY_SECONDS = 60;

// Rows the daily sweep posts per run; the rest wait for the next one. Each is two or three
// Monday calls, and a backlog this deep means something is still wrong.
export const SWEEP_LIMIT = 25;

export interface DeadLetterDeps {
  rowStore: RowStore;
  mondayClient: MondayClient;
  config: BenevityImportConfig;
  // Whether the worklist item may be posted now — the write switch is `on`.
  writesOn: boolean;
}

export interface DeadLetterSummary {
  // Transaction IDs marked dead-lettered in this batch.
  marked: string[];
  // Of those, the ones whose worklist item is still to be posted (by the daily sweep).
  awaitingWorklist: string[];
}

export async function processDeadLetters(
  messages: readonly QueueMessageLike<BenevityQueueMessage>[],
  deps: DeadLetterDeps
): Promise<DeadLetterSummary> {
  const summary: DeadLetterSummary = { marked: [], awaitingWorklist: [] };
  for (const message of messages) {
    // A body without a Transaction ID can't be marked; ack it on its own. Throwing would fail
    // the whole batch, and after the DLQ consumer's retries the good letters in it would be
    // dropped unmarked.
    const transactionId = (message.body as Partial<BenevityQueueMessage> | null)?.transactionId;
    if (typeof transactionId !== 'string' || transactionId.trim() === '') {
      console.error('benevity-import dlq: malformed dead letter (no transactionId); acking without marking anything');
      message.ack();
      continue;
    }

    let row: DonationRowRecord;
    try {
      const found = await deps.rowStore.getRow(transactionId);
      if (found === null) {
        console.warn(`benevity-import dlq: no row for transaction "${transactionId}"; nothing to mark`);
        message.ack();
        continue;
      }
      if (found.status !== 'ingested') {
        console.log(`benevity-import dlq: stale dead letter for transaction "${transactionId}" — row is ${found.status}; leaving it`);
        message.ack();
        continue;
      }
      const prior = found.error ?? '(no recorded error)';
      const error = prior.startsWith(DEAD_LETTER_PREFIX) ? prior : `${DEAD_LETTER_PREFIX}${prior}`;
      // Leaves worklist_item_id as it is, so a row replayed from the worklist that died again
      // reports on the item it already has.
      await deps.rowStore.updateStatus(transactionId, 'needs-review', { error });
      row = { ...found, status: 'needs-review', error };
    } catch (err) {
      console.error(`benevity-import dlq: could not mark transaction "${transactionId}" dead-lettered: ${errorMessage(err)}`);
      message.retry({ delaySeconds: D1_RETRY_DELAY_SECONDS });
      continue;
    }
    summary.marked.push(transactionId);
    message.ack();

    if (!deps.writesOn) {
      summary.awaitingWorklist.push(transactionId);
      continue;
    }
    try {
      await raiseDeadLetterWorklistItem(deps, row);
    } catch (err) {
      console.error(`benevity-import dlq: could not post the worklist item for transaction "${transactionId}" (the daily sweep retries): ${errorMessage(err)}`);
      summary.awaitingWorklist.push(transactionId);
    }
  }

  if (summary.marked.length > 0) {
    console.error(deadLetterReport(summary));
  }
  return summary;
}

/**
 * The daily cron's pass (#60): posts the worklist item for every dead-lettered row that doesn't
 * have one yet, up to SWEEP_LIMIT. The caller runs it only while writes are `on`. One row's
 * failure doesn't stop the rest; it is tried again tomorrow.
 */
export async function sweepDeadLetteredRows(
  deps: Omit<DeadLetterDeps, 'writesOn'>
): Promise<{ posted: string[]; failed: string[] }> {
  const rows = await deps.rowStore.listDeadLetteredWithoutWorklistItem(SWEEP_LIMIT);
  const posted: string[] = [];
  const failed: string[] = [];
  for (const row of rows) {
    try {
      await raiseDeadLetterWorklistItem(deps, row);
      posted.push(row.transactionId);
    } catch (err) {
      console.error(`benevity-import dlq sweep: could not post the worklist item for transaction "${row.transactionId}": ${errorMessage(err)}`);
      failed.push(row.transactionId);
    }
  }
  return { posted, failed };
}

/**
 * Posts (or, for a row that already has one, re-reports on) the worklist item for a
 * dead-lettered row, and records its id. The row must already be 'needs-review' with its
 * dead-letter error. ensureWorklistItem's key lookup keeps a retry from posting a second item.
 */
export async function raiseDeadLetterWorklistItem(
  deps: Pick<DeadLetterDeps, 'rowStore' | 'mondayClient' | 'config'>,
  row: DonationRowRecord
): Promise<string> {
  const error = row.error ?? DEAD_LETTER_PREFIX;
  // raw_row may already be emptied by the retention purge ('{}'); the item then falls back to
  // the Transaction ID for its name and carries what it can.
  let parsed: Partial<ParsedRow> = {};
  try {
    parsed = JSON.parse(row.rawRow) as Partial<ParsedRow>;
  } catch {
    // Leave it empty.
  }
  const name = [parsed.donorFirstName ?? '', parsed.donorLastName ?? ''].filter((part) => !isWithheld(part)).join(' ');
  const worklistItemId = await ensureWorklistItem(
    deps.mondayClient,
    deps.config,
    {
      key: row.transactionId,
      reason: deadLetterReason(error),
      name: name || (parsed.company ? '' : `Benevity transaction ${row.transactionId}`),
      email: parsed.email ?? '',
      company: parsed.company ?? '',
      amount: (parsed.totalDonationToBeAcknowledged ?? 0) + (parsed.matchAmount ?? 0),
      date: parsed.donationDate ?? row.ingestedAt.slice(0, 10),
    },
    row.worklistItemId
  );
  await deps.rowStore.updateStatus(row.transactionId, 'needs-review', { error, worklistItemId });
  return worklistItemId;
}

// What staff read on the worklist item.
export function deadLetterReason(error: string): string {
  const last = error.startsWith(DEAD_LETTER_PREFIX) ? error.slice(DEAD_LETTER_PREFIX.length) : error;
  return (
    `Couldn't write this gift to Monday: it failed on every retry for about four days. ` +
    `Last error: ${last}. Once the cause is fixed, set Retry to write it.`
  );
}

// The one line per batch.
export function deadLetterReport(summary: DeadLetterSummary): string {
  const n = summary.marked.length;
  const s = n === 1 ? '' : 's';
  const waiting = summary.awaitingWorklist.length;
  return (
    `benevity-import: ${n} gift${s} dead-lettered after exhausting retries — Transaction ID${s} ${summary.marked.join(', ')}; ` +
    `marked needs-review (see rows.error)` +
    (waiting === 0
      ? ' and posted to the Benevity Uploads worklist for a staff Retry.'
      : `; ${waiting} worklist item${waiting === 1 ? '' : 's'} not posted yet (${summary.awaitingWorklist.join(', ')}) — the daily sweep posts them while writes are on.`)
  );
}
