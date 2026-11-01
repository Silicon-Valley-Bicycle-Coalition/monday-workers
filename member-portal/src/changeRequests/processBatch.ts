import type { ChangeRequestStore } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';
import type { Config } from '../types';
import { FIELD_LABELS, type ChangeQueueMessage } from './submitChangeRequest';
import { retryDelaySeconds, type QueueMessageLike } from '../queueRetry';
import { logDebug, messageDisposition } from '../flags';
import { dryRunChangeDeps, type BatchSkipContext } from '../writeSwitch';

export interface ProcessChangeBatchDeps {
  store: ChangeRequestStore;
  monday: MondayClient;
  config: Config;
}

// The queue entry point (index.ts): the write switch's mode, read once for the batch, decides per
// message whether it writes (`on`, unstamped — including messages enqueued before the switch
// existed), dry-runs against recording proxies (`off`, or stamped dropped), or waits on the queue
// (`hold`, `unknown`). A dry run leaves the row 'queued': nothing re-enqueues queued rows on its
// own (the purge keeps them, and only the donor re-submitting the same change re-sends one).
export async function consumeChangeQueueBatch(
  messages: QueueMessageLike<ChangeQueueMessage>[],
  deps: ProcessChangeBatchDeps,
  gate: BatchSkipContext
): Promise<void> {
  for (const message of messages) {
    if (!hasValidShape(message.body)) {
      rejectMalformed(message);
      continue;
    }
    const disposition = messageDisposition(gate.mode, message.body);
    if (disposition === 'retry') {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    } else if (disposition === 'write') {
      await handleMessage(message, deps);
    } else {
      const ctx = { ...gate, deliveryId: `change-request:${message.body.requestId}` };
      logDebug(ctx, 'message', message.body);
      await handleMessage(message, dryRunChangeDeps(deps, ctx));
    }
  }
}

// Every message live — the `write` path above, and the tests that predate the switch.
export async function processChangeQueueBatch(
  messages: QueueMessageLike<ChangeQueueMessage>[],
  deps: ProcessChangeBatchDeps
): Promise<void> {
  for (const message of messages) {
    if (!hasValidShape(message.body)) {
      rejectMalformed(message);
      continue;
    }
    await handleMessage(message, deps);
  }
}

// The queue body is all this consumer trusts before it reads D1, so it must be a positive integer
// id. Anything else can never succeed: log it (no body contents — it is untrusted) and retry
// rather than ack, so it exhausts its retries into the dead-letter queue instead of vanishing.
function hasValidShape(body: unknown): body is ChangeQueueMessage {
  if (typeof body !== 'object' || body === null) return false;
  const id = (body as { requestId?: unknown }).requestId;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

function rejectMalformed(message: QueueMessageLike<ChangeQueueMessage>): void {
  console.error('member-portal consumer: malformed change-request message (requestId is not a positive integer); retrying, so it reaches the dead-letter queue after max_retries');
  message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
}

async function handleMessage(message: QueueMessageLike<ChangeQueueMessage>, deps: ProcessChangeBatchDeps): Promise<void> {
  try {
    await processOne(message.body.requestId, deps);
    message.ack();
  } catch (err) {
    console.error(
      `member-portal consumer: failed to process change request ${message.body.requestId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  }
}

async function processOne(requestId: number, deps: ProcessChangeBatchDeps): Promise<void> {
  const row = await deps.store.getRequest(requestId);
  if (row === null) {
    // A queued message with no row is a bug worth surfacing — let retries exhaust into the DLQ
    // rather than acking it into silence.
    throw new Error(`no change_requests row for id ${requestId}`);
  }
  if (row.status === 'written') {
    return; // redelivery after a crash between write and ack — nothing to do
  }

  const boardId = deps.config.changeRequests.boardId;
  if (boardId === null) {
    throw new Error('config: changeRequests.boardId is not configured');
  }

  const fieldLabel = FIELD_LABELS[row.field];
  // The D1 id in the name makes it unique per request (AUTOINCREMENT never reuses an id), so the
  // lookup below can tell "my earlier create landed" from "another request for the same donor".
  const itemName = `${fieldLabel} change — ${row.donorName} (#${row.id})`;

  // A create that failed ambiguously (5xx, timeout — AmbiguousWriteError) may have committed on
  // Monday's side while this row stayed unwritten; the retry must adopt that item, not create a
  // second one for staff to deduplicate by hand.
  const existingItemId = await deps.monday.findChangeRequestItem({ boardId, itemName });
  if (existingItemId !== null) {
    console.log(
      `member-portal consumer: change request ${row.id} already on Monday as item ${existingItemId}; adopting it`
    );
    await deps.store.markWritten(row.id, new Date().toISOString());
    return;
  }

  await deps.monday.createChangeRequestItem({
    boardId,
    columns: deps.config.changeRequests.columns,
    itemName,
    donorItemId: row.donorItemId,
    fieldLabel,
    oldValue: row.oldValue,
    newValue: row.newValue,
    // Use the row's own submission time, not "now" — this consumer may be processing a retry
    // or a DLQ replay well after the donor actually submitted (see Finding 2).
    submittedAtISO: row.createdAt,
  });
  await deps.store.markWritten(row.id, new Date().toISOString());
}
