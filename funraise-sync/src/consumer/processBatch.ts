import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { EntityType, EventRow, FunraiseSyncConfig } from '../types';
import { mapToMondayColumns, ENTITY_MAP_KEY } from '../mapping/fieldMap';
import { matchDonor } from '../matching/donors';
import { getPath } from '../util/getPath';
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

  const columnValues = mapToMondayColumns(event.entityType, rawPayload, deps.config);
  if (donorItemId) {
    columnValues[deps.config.funraiseSync.donorLinkColumn] = {
      item_ids: [Number(donorItemId)],
    };
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
