import type { MapStore } from '../db/map';
import type { MondayEventStore } from '../db/mondayEvents';
import type { QbEventStore } from '../db/qbEvents';
import { getPath, mapMondayToQbCustomerFields, mapQbToMondayColumns } from '../mapping/fieldMap';
import type { MondayClient } from '../monday/client';
import type { QuickBooksClient } from '../quickbooks/client';
import type { EntityType, MondayBoards, QueueMessage, QuickbooksSyncConfig } from '../types';

export interface QueueMessageLike<T> {
  body: T;
  // Cloudflare's Message.attempts (1 on first delivery) and Message.timestamp (when it was
  // sent). Optional so tests and callers that don't care can omit them.
  attempts?: number;
  timestamp?: Date;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

// Retry backoff (#33): immediate retries let a Monday or QuickBooks outage of a few seconds burn
// every attempt and dead-letter the change. 60 s × 4^(attempt−1) gives 1, 4 and 16 minutes across
// wrangler.jsonc's max_retries of 3 — about 21 minutes of cover — capped at Queues' 12-hour
// maximum delay. Same schedule as funraise-sync.
const RETRY_BASE_SECONDS = 60;
const RETRY_FACTOR = 4;
const MAX_RETRY_DELAY_SECONDS = 12 * 60 * 60;

export function retryDelaySeconds(attempts: number | undefined): number {
  const attempt = typeof attempts === 'number' && Number.isFinite(attempts) && attempts >= 1 ? Math.floor(attempts) : 1;
  return Math.min(RETRY_BASE_SECONDS * RETRY_FACTOR ** (attempt - 1), MAX_RETRY_DELAY_SECONDS);
}

export interface ConsumerDeps {
  qbEventStore: QbEventStore;
  mondayEventStore: MondayEventStore;
  mapStore: MapStore;
  mondayClient: MondayClient;
  quickBooksClient: QuickBooksClient;
  config: QuickbooksSyncConfig;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      const error = errorMessage(err);
      console.error(`quickbooks-sync consumer: ${message.body.direction} "${message.body.eventId}" failed: ${error}`);
      // Recording the failure is bookkeeping; a D1 error here must not take the retry decision
      // down with it (the throw would fail the whole batch and retry every message immediately).
      try {
        if (message.body.direction === 'qb-to-monday') {
          await deps.qbEventStore.updateStatus(message.body.eventId, 'failed', { error });
        } else {
          await deps.mondayEventStore.updateStatus(message.body.eventId, 'failed', { error });
        }
      } catch (recordErr) {
        console.error(`quickbooks-sync consumer: could not record failure for "${message.body.eventId}": ${errorMessage(recordErr)}`);
      }
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
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

  // Read the entity now, not at webhook time (#33): a retried or delayed message must write the
  // record as it currently stands, never an older snapshot over a newer one. A fetch failure
  // throws into the queue's retry/backoff/DLQ path like any other failure.
  const record = await deps.quickBooksClient.getEntity(event.entityType, event.qbId);
  const fetchedPayload = JSON.stringify(record);
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
    // monday.com's Name column is a reserved pseudo-column addressable as column_id "name"
    // through the same change_multiple_column_values mutation used for every other mapped
    // column (developer.monday.com/api-reference/reference/name) — confirmed against monday's
    // public API docs, not yet exercised against a live account. This keeps the item's title in
    // sync with the QuickBooks-side name field (DisplayName, DocNumber, ...) on every update.
    await deps.mondayClient.changeColumnValues(boardId, existing.mondayItemId, {
      ...columnValues,
      name: itemName,
    });
  } else {
    let mondayItemId = event.pendingMondayItemId;
    if (mondayItemId === null) {
      const created = await deps.mondayClient.createItem(boardId, itemName, columnValues);
      mondayItemId = created.id;

      // Durably record the created item's id, status unchanged, before writing the mapping.
      // A queue retry that resumes here (the mapping lookup above still misses, because
      // createMapping below is what's about to fail or hasn't run yet) reuses this id instead
      // of calling createItem again -- closing the duplicate-item window.
      await deps.qbEventStore.updateStatus(eventId, event.status, { pendingMondayItemId: mondayItemId });
    }

    await deps.mapStore.createMapping({
      entityType: event.entityType,
      qbId: event.qbId,
      mondayItemId,
      mondayBoardId: boardId,
      createdAt: new Date().toISOString(),
    });
  }

  // fetchedPayload is kept as a record of what was written, for inspecting a row after the fact.
  await deps.qbEventStore.updateStatus(eventId, 'written', { writtenAt: new Date().toISOString(), fetchedPayload });
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

  // Idempotency guard. A queue retry re-runs this function from the top, so calling
  // createCustomer unconditionally would create a duplicate Customer in the accounting system
  // of record every time a later step failed. event.qbId is persisted in its own D1 write the
  // moment createCustomer resolves (below), so a non-null value here means a prior attempt
  // already created the Customer — resume from that id instead of creating another.
  let qbId = event.qbId;

  if (qbId === null) {
    const columnValues = JSON.parse(event.rawPayload) as Record<string, unknown>;
    const qbFields = mapMondayToQbCustomerFields(columnValues, deps.config);
    const created = await deps.quickBooksClient.createCustomer(qbFields);
    qbId = created.id;

    // Durably record the new id before doing anything else. 'fetched' is the intermediate
    // signal for "the QuickBooks side is done, the local bookkeeping is not"; if either write
    // below fails, the retry finds qbId set and skips straight past createCustomer.
    await deps.mondayEventStore.updateStatus(eventId, 'fetched', { qbId });
  }

  // Safe to re-run on a resumed attempt: createMapping is an idempotent UPSERT on
  // (entity_type, qb_id).
  await deps.mapStore.createMapping({
    entityType: 'customer',
    qbId,
    mondayItemId: event.mondayItemId,
    mondayBoardId: customersBoardId,
    createdAt: new Date().toISOString(),
  });

  await deps.mondayEventStore.updateStatus(eventId, 'written', {
    qbId,
    writtenAt: new Date().toISOString(),
  });
}
