import type { ChangeRequestStore } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';
import type { Config } from '../types';
import { FIELD_LABELS, type ChangeQueueMessage } from './submitChangeRequest';
import { retryDelaySeconds, type QueueMessageLike } from '../queueRetry';

export interface ProcessChangeBatchDeps {
  store: ChangeRequestStore;
  monday: MondayClient;
  config: Config;
}

export async function processChangeQueueBatch(
  messages: QueueMessageLike<ChangeQueueMessage>[],
  deps: ProcessChangeBatchDeps
): Promise<void> {
  for (const message of messages) {
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
  await deps.monday.createChangeRequestItem({
    boardId,
    columns: deps.config.changeRequests.columns,
    itemName: `${fieldLabel} change — ${row.donorName}`,
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
