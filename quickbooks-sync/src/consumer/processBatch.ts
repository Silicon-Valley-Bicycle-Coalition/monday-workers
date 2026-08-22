import type { MapStore } from '../db/map';
import type { MondayEventStore } from '../db/mondayEvents';
import type { QbEventStore } from '../db/qbEvents';
import { getPath, mapMondayToQbCustomerFields, mapQbToMondayColumns } from '../mapping/fieldMap';
import type { MondayClient } from '../monday/client';
import type { QuickBooksClient } from '../quickbooks/client';
import type { EntityType, MondayBoards, QueueMessage, QuickbooksSyncConfig } from '../types';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface ConsumerDeps {
  qbEventStore: QbEventStore;
  mondayEventStore: MondayEventStore;
  mapStore: MapStore;
  mondayClient: MondayClient;
  quickBooksClient: QuickBooksClient;
  config: QuickbooksSyncConfig;
}

const BOARD_KEY_FOR_ENTITY: Record<EntityType, keyof MondayBoards> = {
  customer: 'customers',
  invoice: 'invoices',
  product: 'products',
};

export async function processSyncQueueBatch(
  messages: QueueMessageLike<QueueMessage>[],
  deps: ConsumerDeps
): Promise<void> {
  for (const message of messages) {
    try {
      if (message.body.direction === 'qb-to-monday') {
        await processQbToMonday(message.body.eventId, deps);
      } else {
        await processMondayToQb(message.body.eventId, deps);
      }
      message.ack();
    } catch (err) {
      const error = (err as Error).message;
      if (message.body.direction === 'qb-to-monday') {
        await deps.qbEventStore.updateStatus(message.body.eventId, 'failed', { error });
      } else {
        await deps.mondayEventStore.updateStatus(message.body.eventId, 'failed', { error });
      }
      message.retry();
    }
  }
}

async function processQbToMonday(eventId: string, deps: ConsumerDeps): Promise<void> {
  const event = await deps.qbEventStore.getEvent(eventId);
  if (event === null) {
    throw new Error(`quickbooks-sync consumer: no qb_events row for "${eventId}"`);
  }

  const boardKey = BOARD_KEY_FOR_ENTITY[event.entityType];
  const boardId = deps.config.monday.boards[boardKey];
  if (boardId === null) {
    throw new Error(`config: monday.boards.${boardKey} is not configured`);
  }

  const record = JSON.parse(event.fetchedPayload ?? '{}') as Record<string, unknown>;
  const columnValues = mapQbToMondayColumns(event.entityType, record, deps.config);

  if (event.entityType === 'invoice') {
    const customerRef = record.CustomerRef as { value?: string } | undefined;
    if (customerRef?.value) {
      const customerMapping = await deps.mapStore.getByQbId('customer', customerRef.value);
      if (customerMapping) {
        columnValues[deps.config.quickbooksSync.linkColumn.invoice] = {
          item_ids: [Number(customerMapping.mondayItemId)],
        };
      }
    }
  }

  const existing = await deps.mapStore.getByQbId(event.entityType, event.qbId);
  const itemNameValue = getPath(record, deps.config.quickbooksSync.itemNameField[event.entityType]);
  const itemName = typeof itemNameValue === 'string' && itemNameValue.length > 0 ? itemNameValue : event.qbId;

  if (existing) {
    await deps.mondayClient.changeColumnValues(boardId, existing.mondayItemId, columnValues);
  } else {
    const created = await deps.mondayClient.createItem(boardId, itemName, columnValues);
    await deps.mapStore.createMapping({
      entityType: event.entityType,
      qbId: event.qbId,
      mondayItemId: created.id,
      mondayBoardId: boardId,
      createdAt: new Date().toISOString(),
    });
  }

  await deps.qbEventStore.updateStatus(eventId, 'written', { writtenAt: new Date().toISOString() });
}

async function processMondayToQb(eventId: string, deps: ConsumerDeps): Promise<void> {
  const event = await deps.mondayEventStore.getEvent(eventId);
  if (event === null) {
    throw new Error(`quickbooks-sync consumer: no monday_events row for "${eventId}"`);
  }

  const customersBoardId = deps.config.monday.boards.customers;
  if (customersBoardId === null) {
    throw new Error('config: monday.boards.customers is not configured');
  }

  const columnValues = JSON.parse(event.rawPayload) as Record<string, unknown>;
  const qbFields = mapMondayToQbCustomerFields(columnValues, deps.config);
  const created = await deps.quickBooksClient.createCustomer(qbFields);

  await deps.mapStore.createMapping({
    entityType: 'customer',
    qbId: created.id,
    mondayItemId: event.mondayItemId,
    mondayBoardId: customersBoardId,
    createdAt: new Date().toISOString(),
  });

  await deps.mondayEventStore.updateStatus(eventId, 'written', {
    qbId: created.id,
    writtenAt: new Date().toISOString(),
  });
}
