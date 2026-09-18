import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { EntityType, EventRow, FunraiseSyncConfig } from '../types';
import { mapToMondayColumns, ENTITY_MAP_KEY } from '../mapping/fieldMap';
import { fiscalYearEnding } from '../mapping/fiscalYear';
import { matchDonor } from '../matching/donors';
import { getPath } from '../util/getPath';
import { toISODate } from '../util/isoDate';
import { errorMessage } from '../util/errorMessage';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface FunraiseQueueMessage {
  entityType: EntityType;
  entityId: string;
}

export interface ProcessBatchDeps {
  eventStore: EventStore;
  mondayClient: MondayClient;
  config: FunraiseSyncConfig;
}

type BoardKey = keyof FunraiseSyncConfig['monday']['boards'];

// The Funraise transaction field the Donations board's Date column is mapped from
// (`columnMap.transaction.donationDate` in config/svbc.json). Funraise sends it as epoch
// milliseconds, so it's normalized to YYYY-MM-DD before the write, and Fiscal Year Ending is
// derived from that same normalized value so the two columns can never disagree.
const TRANSACTION_DATE_FIELD = 'donationDate';

const BOARD_FOR_ENTITY: Record<EntityType, BoardKey> = {
  transaction: 'donations:live',
  subscription: 'recurring-gifts',
  pledge: 'recurring-gifts',
  registration: 'event-registrations',
};

export async function processFunraiseQueueBatch(
  messages: QueueMessageLike<FunraiseQueueMessage>[],
  deps: ProcessBatchDeps
): Promise<void> {
  for (const message of messages) {
    const { entityType, entityId } = message.body;
    try {
      await processOne(entityType, entityId, deps);
      message.ack();
    } catch (err) {
      const errMsg = errorMessage(err);
      console.error(`funraise-sync consumer: failed to process ${entityType} "${entityId}": ${errMsg}`);
      await deps.eventStore.updateStatusByEntity(entityType, entityId, 'failed', {
        error: errMsg,
      });
      message.retry();
    }
  }
}

async function processOne(entityType: EntityType, entityId: string, deps: ProcessBatchDeps): Promise<void> {
  const event = await deps.eventStore.getEventByEntity(entityType, entityId);
  if (event === null) {
    throw new Error(`funraise-sync consumer: no event row for ${entityType} "${entityId}"`);
  }

  const boardKey = BOARD_FOR_ENTITY[event.entityType];
  const boardId = deps.config.monday.boards[boardKey];
  if (boardId === null) {
    throw new Error(`config: monday.boards["${boardKey}"] is not configured`);
  }

  const rawPayload = JSON.parse(event.rawPayload) as Record<string, unknown>;

  // Matching runs here, not in the webhook handler, so a transient Monday failure
  // gets the queue's retries and lands in the DLQ instead of dying silently.
  let donorItemId = event.matchedDonorItemId;
  if (donorItemId === null) {
    const match = await matchDonor(deps.mondayClient, deps.config, rawPayload);
    donorItemId = match.donorItemId;
    await deps.eventStore.updateStatusByEntity(entityType, entityId, 'matched', {
      matchedDonorItemId: donorItemId,
    });
  }

  const { donorLinkColumn, entityIdColumn, thankYouSentColumn, giftTypeColumn, giftTypeValue, fiscalYearColumn } =
    deps.config.funraiseSync;
  const columnValues = mapToMondayColumns(event.entityType, rawPayload, deps.config);

  // columnMap writes values verbatim, which is wrong for the date: Funraise sends epoch
  // milliseconds and Monday's date column wants { date: 'YYYY-MM-DD' }. Replace the mapped
  // value with the normalized one, or drop the column rather than write a raw number.
  const transactionDate = entityType === 'transaction' ? toISODate(getPath(rawPayload, TRANSACTION_DATE_FIELD)) : null;
  const dateColumn = deps.config.funraiseSync.columnMap.transaction[TRANSACTION_DATE_FIELD];
  if (entityType === 'transaction' && dateColumn) {
    if (transactionDate !== null) columnValues[dateColumn] = { date: transactionDate };
    else delete columnValues[dateColumn];
  }

  if (donorItemId) {
    columnValues[donorLinkColumn] = {
      item_ids: [Number(donorItemId)],
    };
  }
  if (entityIdColumn) {
    columnValues[entityIdColumn] = entityId;
  }

  // At-least-once delivery: an event that already has a Monday item (an earlier
  // write whose status update was lost, or a genuine update to the entity) is
  // written as an idempotent column update, never a second item.
  if (event.mondayItemId !== null) {
    await deps.mondayClient.changeColumnValues(boardId, event.mondayItemId, columnValues);
    await deps.eventStore.updateStatusByEntity(entityType, entityId, 'written', {
      writtenAt: new Date().toISOString(),
    });
    return;
  }

  // Funraise's own transaction-time donor receipt already covers acknowledgment for
  // Funraise-sourced gifts (migration-plan.md Decisions Needed, Option 2), so this Worker
  // marks it sent itself instead of relying on Salesforce's donation-acknowledgment automation.
  // Only on a Donations item's first write, never on a later update — a later event might carry
  // a staff correction to this column that a resend would clobber. Recurring gifts and event
  // registrations aren't in scope.
  if (thankYouSentColumn && entityType === 'transaction') {
    columnValues[thankYouSentColumn] = { checked: 'true' };
  }

  // First write only, transactions only — same reasoning as Thank You Sent above.
  if (giftTypeColumn && entityType === 'transaction') {
    columnValues[giftTypeColumn] = giftTypeValue;
  }

  // Fiscal Year Ending is derived (SVBC's July–June year), not a Funraise field, so columnMap
  // can't produce it; salesforce-import stamps it on every migrated gift and donation-rollups
  // deliberately never backfills it (decision 2026-09-17, both READMEs), so the writer that
  // creates the item owns it. Same first-write-only rule as Thank You Sent, for the same reason.
  if (fiscalYearColumn && entityType === 'transaction') {
    const fiscalYear = fiscalYearEnding(transactionDate);
    if (fiscalYear !== null) {
      columnValues[fiscalYearColumn] = fiscalYear;
    } else {
      console.warn(
        `funraise-sync consumer: transaction "${entityId}" has no parseable "${TRANSACTION_DATE_FIELD}"; leaving Fiscal Year Ending blank`
      );
    }
  }

  // The D1 update recording mondayItemId can fail after a successful create, leaving
  // an orphaned item the retry would duplicate — the entity-id column stamped on every
  // created item lets the retry find and adopt it instead.
  if (entityIdColumn) {
    const orphan = await deps.mondayClient.findItemByColumnValue(boardId, entityIdColumn, entityId);
    if (orphan) {
      await deps.mondayClient.changeColumnValues(boardId, orphan.id, columnValues);
      await deps.eventStore.updateStatusByEntity(entityType, entityId, 'written', {
        mondayItemId: orphan.id,
        writtenAt: new Date().toISOString(),
      });
      return;
    }
  }

  const item = await deps.mondayClient.createItem(
    boardId,
    describeItemName(event.entityType, rawPayload, deps.config),
    columnValues
  );

  await deps.eventStore.updateStatusByEntity(entityType, entityId, 'written', {
    mondayItemId: item.id,
    writtenAt: new Date().toISOString(),
  });
}

function describeItemName(entityType: EntityType, rawPayload: Record<string, unknown>, config: FunraiseSyncConfig): string {
  const fieldPath = config.funraiseSync.itemNameField[ENTITY_MAP_KEY[entityType]];
  const value = getPath(rawPayload, fieldPath);
  return typeof value === 'string' && value.length > 0 ? value : `Funraise ${entityType}`;
}
