import type { MondayClient } from '../monday/client';
import type { RowStore, DonationRowRecord } from '../db/rows';
import type { DisbursementStore } from '../db/disbursements';
import type { AliasStore } from '../db/aliases';
import type { BenevityImportConfig } from '../types';
import type { ParsedRow } from '../parse/report';
import { resolveOrganization } from '../matching/organizations';
import { isWithheld, resolvePerson } from '../matching/people';
import { splitRowIntoGifts } from '../mapping/giftSplit';
import { ensureWorklistItem, setWorklistLabel } from '../matching/worklist';
import { errorMessage } from '../util/errorMessage';
import { logDebug, messageDisposition, retryDelaySeconds, type WriteStamp } from '../flags';
import { dryRunConsumerDeps, type BatchSkipContext } from '../writeSwitch';
import { ingestUpload, type IngestDeps } from './ingestUpload';

// Two kinds share the write queue: an uploaded report to fetch and parse (#74), sent by the upload
// webhook, and a row to write, sent once the report is ingested (or by a staff Retry). The
// optional stamp is the write switch's (src/flags.ts): a message enqueued while writes were `off`
// stays a dry run even if the mode is `on` by the time it is consumed.
export type RowMessage = { transactionId: string } & WriteStamp;
export type UploadMessage = { assetId: string } & WriteStamp;
export type BenevityQueueMessage = RowMessage | UploadMessage;

function isUploadMessage(body: BenevityQueueMessage): body is UploadMessage {
  return 'assetId' in body;
}

export interface QueueMessageLike<T> {
  body: T;
  // Cloudflare's Message.attempts (1 on first delivery). Optional so tests can omit it.
  attempts?: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ProcessBatchDeps extends IngestDeps {
  aliasStore: AliasStore;
}

/**
 * The queue() entry point for the write queue: the write switch's per-message decision in front
 * of processBenevityQueueBatch. `write` runs it with the real deps; `dry-run` runs the same code
 * against recording/read-only deps (src/writeSwitch.ts), which then acks; `retry` (`hold`, or a
 * KV read failure) leaves the message on the queue untouched, backing off like any retry.
 */
export async function consumeBenevityBatch(
  messages: QueueMessageLike<BenevityQueueMessage>[],
  deps: ProcessBatchDeps,
  gate: BatchSkipContext
): Promise<void> {
  for (const message of messages) {
    const ctx = { ...gate, deliveryId: isUploadMessage(message.body) ? `asset:${message.body.assetId}` : message.body.transactionId };
    const disposition = messageDisposition(gate.mode, message.body);
    logDebug(ctx, 'disposition', { disposition, writeStamp: message.body.writeStamp ?? null, attempts: message.attempts ?? null });
    if (disposition === 'retry') {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      continue;
    }
    await processBenevityQueueBatch([message], disposition === 'write' ? deps : dryRunConsumerDeps(deps, ctx));
  }
}

export async function processBenevityQueueBatch(
  messages: QueueMessageLike<BenevityQueueMessage>[],
  deps: ProcessBatchDeps
): Promise<void> {
  for (const message of messages) {
    if (isUploadMessage(message.body)) {
      await processUpload(message.body.assetId, message, deps);
      continue;
    }
    const { transactionId } = message.body;
    try {
      await processOne(transactionId, deps);
      message.ack();
    } catch (err) {
      const errMsg = errorMessage(err);
      console.error(`benevity consumer: failed to process "${transactionId}": ${errMsg}`);
      // Left at 'ingested' (its only possible pre-write status here) so the queue's own
      // retry+DLQ handles it — this is an unexpected/transient failure, not a business
      // decision, so it must not read as 'needs-review' on the board. Recording it is
      // bookkeeping: a D1 error here must not take the retry decision down with it (the throw
      // would fail the whole batch and retry every message in it immediately).
      try {
        await deps.rowStore.updateStatus(transactionId, 'ingested', { error: errMsg });
      } catch (recordErr) {
        console.error(`benevity consumer: could not record failure for "${transactionId}": ${errorMessage(recordErr)}`);
      }
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

async function processUpload(assetId: string, message: QueueMessageLike<BenevityQueueMessage>, deps: ProcessBatchDeps): Promise<void> {
  try {
    await ingestUpload(assetId, deps);
    message.ack();
  } catch (err) {
    // ingestUpload has already marked the upload 'error' if it got as far as recording it; the
    // retry resumes the same asset from its first unfinished block.
    console.error(`benevity consumer: failed to ingest asset "${assetId}": ${errorMessage(err)}`);
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  }
}

async function processOne(transactionId: string, deps: ProcessBatchDeps): Promise<void> {
  const row = await deps.rowStore.getRow(transactionId);
  if (row === null) {
    throw new Error(`benevity consumer: no row for transaction id "${transactionId}"`);
  }
  // Only an 'ingested' row has work left. 'written' is done; 'needs-review' is waiting on staff
  // (a Retry on its worklist item moves it back to 'ingested' before re-enqueueing it); 'skipped'
  // belongs to a disbursement the cutoff excluded, and stays that way unless staff Retry that
  // disbursement's notice (#40). A message for any of those is a redelivery or a stale duplicate.
  if (row.status !== 'ingested') return;

  const parsed = JSON.parse(row.rawRow) as ParsedRow;

  if (parsed.currency !== 'USD') {
    await worklistAndMarkReview(deps, row, parsed, `currency "${parsed.currency}" is not USD`);
    return;
  }
  if (parsed.totalDonationToBeAcknowledged < 0 || parsed.matchAmount < 0) {
    await worklistAndMarkReview(deps, row, parsed, 'row has a negative amount');
    return;
  }

  const orgResult = await resolveOrganization(deps.mondayClient, deps.aliasStore, deps.config, parsed.company);
  if (orgResult.status === 'unresolved') {
    await worklistAndMarkReview(deps, row, parsed, orgResult.reason);
    return;
  }

  const personResult = await resolvePerson(
    deps.mondayClient,
    deps.config,
    {
      company: parsed.company,
      donorFirstName: parsed.donorFirstName,
      donorLastName: parsed.donorLastName,
      email: parsed.email,
    },
    orgResult.organizationItemId
  );
  if (personResult.status === 'unresolved') {
    await worklistAndMarkReview(deps, row, parsed, personResult.reason);
    return;
  }
  const personItemId = personResult.status === 'resolved' ? personResult.personItemId : null;

  const disbursement = await deps.disbursementStore.getDisbursement(row.disbursementId);
  if (disbursement === null) {
    throw new Error(`benevity consumer: no disbursement ${row.disbursementId} for transaction "${transactionId}"`);
  }

  const gifts = splitRowIntoGifts(
    {
      row: parsed,
      disbursementPeriodEnding: disbursement.periodEnding,
      organizationItemId: orgResult.organizationItemId,
      personItemId,
    },
    deps.config
  );

  const donationsBoardId = deps.config.monday.boards.donations;
  if (donationsBoardId === null) {
    throw new Error('config: monday.boards.donations is not configured');
  }
  const txnIdColumn = deps.config.benevityImport.donationsColumns.transactionId;

  let employeeItemId: string | undefined;
  let matchItemId: string | undefined;

  for (const gift of gifts) {
    const existing = await deps.mondayClient.findItemsByColumnValue(donationsBoardId, txnIdColumn, gift.transactionId);
    let itemId: string;
    if (existing.length > 0) {
      itemId = existing[0]!.id; // guarded by existing.length > 0 above
      await deps.mondayClient.changeColumnValues(donationsBoardId, itemId, gift.columnValues);
    } else {
      const created = await deps.mondayClient.createItem(donationsBoardId, gift.itemName, gift.columnValues);
      itemId = created.id;
    }
    if (gift.transactionId === transactionId) {
      employeeItemId = itemId;
    } else {
      matchItemId = itemId;
    }
  }

  // A row replayed from the worklist (#34): close the loop for staff. Before the D1 write, so a
  // failure here retries the (idempotent) row rather than leaving the item showing Queued.
  if (row.worklistItemId !== null) {
    await setWorklistLabel(deps.mondayClient, deps.config, row.worklistItemId, 'done');
  }

  await deps.rowStore.updateStatus(transactionId, 'written', {
    ...(employeeItemId ? { mondayEmployeeItemId: employeeItemId } : {}),
    ...(matchItemId ? { mondayMatchItemId: matchItemId } : {}),
    writtenAt: deps.now(),
  });
}

async function worklistAndMarkReview(
  deps: ProcessBatchDeps,
  row: DonationRowRecord,
  parsed: ParsedRow,
  reason: string
): Promise<void> {
  // ensureWorklistItem reuses the item this row already has, or finds one an earlier attempt
  // posted before its D1 write was lost, so a retry never posts a second one (#34). Its id is
  // recorded in the same write that marks the row needs-review.
  const worklistItemId = await ensureWorklistItem(
    deps.mondayClient,
    deps.config,
    {
      key: row.transactionId,
      reason,
      // A withheld name is "Not shared by donor"; leave it out so the item falls back to the company.
      name: [parsed.donorFirstName, parsed.donorLastName].filter((part) => !isWithheld(part)).join(' '),
      email: parsed.email,
      company: parsed.company,
      amount: parsed.totalDonationToBeAcknowledged + parsed.matchAmount,
      date: parsed.donationDate,
    },
    row.worklistItemId
  );
  await deps.rowStore.updateStatus(row.transactionId, 'needs-review', { error: reason, worklistItemId });
}
