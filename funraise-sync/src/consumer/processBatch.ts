import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { EntityType, FunraiseSyncConfig } from '../types';
import { mapToMondayColumns, ENTITY_MAP_KEY } from '../mapping/fieldMap';
import { getPath } from '../util/getPath';
import { errorMessage } from '../util/errorMessage';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface FunraiseQueueMessage {
  eventId: string;
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
    try {
      await processOne(message.body.eventId, deps);
      message.ack();
    } catch (err) {
      const errMsg = errorMessage(err);
      console.error(`funraise-sync consumer: failed to process event "${message.body.eventId}": ${errMsg}`);
      await deps.eventStore.updateStatus(message.body.eventId, 'failed', {
        error: errMsg,
      });
      message.retry();
    }
  }
}

async function processOne(eventId: string, deps: ProcessBatchDeps): Promise<void> {
  const event = await deps.eventStore.getEvent(eventId);
  if (event === null) {
    throw new Error(`funraise-sync consumer: no event row for "${eventId}"`);
  }

  // Idempotency guard: at-least-once delivery means a redelivery after a successful
  // Monday write (but a failed subsequent D1 status update) must not create a duplicate item.
  if (event.mondayItemId !== null) {
    return;
  }

  const boardKey = BOARD_FOR_ENTITY[event.entityType];
  const boardId = deps.config.monday.boards[boardKey];
  if (boardId === null) {
    throw new Error(`config: monday.boards["${boardKey}"] is not configured`);
  }

  const rawPayload = JSON.parse(event.rawPayload) as Record<string, unknown>;
  const columnValues = mapToMondayColumns(event.entityType, rawPayload, deps.config);
  if (event.matchedDonorItemId) {
    columnValues[deps.config.funraiseSync.donorLinkColumn] = {
      item_ids: [Number(event.matchedDonorItemId)],
    };
  }

  const item = await deps.mondayClient.createItem(
    boardId,
    describeItemName(event.entityType, rawPayload, deps.config),
    columnValues
  );

  await deps.eventStore.updateStatus(eventId, 'written', {
    mondayItemId: item.id,
    writtenAt: new Date().toISOString(),
  });
}

function describeItemName(entityType: EntityType, rawPayload: Record<string, unknown>, config: FunraiseSyncConfig): string {
  const fieldPath = config.funraiseSync.itemNameField[ENTITY_MAP_KEY[entityType]];
  const value = getPath(rawPayload, fieldPath);
  return typeof value === 'string' && value.length > 0 ? value : `Funraise ${entityType}`;
}
