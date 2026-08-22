import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { EntityType, FunraiseSyncConfig } from '../types';
import { mapToMondayColumns } from '../mapping/fieldMap';

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
      await deps.eventStore.updateStatus(message.body.eventId, 'failed', {
        error: (err as Error).message,
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

  const item = await deps.mondayClient.createItem(boardId, describeItemName(event.entityType, rawPayload), columnValues);

  await deps.eventStore.updateStatus(eventId, 'written', {
    mondayItemId: item.id,
    writtenAt: new Date().toISOString(),
  });
}

function describeItemName(entityType: EntityType, rawPayload: Record<string, unknown>): string {
  const description = rawPayload.description;
  return typeof description === 'string' && description.length > 0 ? description : `Funraise ${entityType}`;
}
