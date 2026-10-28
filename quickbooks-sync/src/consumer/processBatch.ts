import { MappingConflictError, type MapStore } from '../db/map';
import { isTerminalError, TerminalError } from '../errors';
import type { MondayEventStore } from '../db/mondayEvents';
import type { QbEventStore } from '../db/qbEvents';
import { getPath, mapMondayToQbCustomerFields, mapQbToMondayColumns, mondayCellScalar } from '../mapping/fieldMap';
import type { MondayClient, MondayItemSnapshot } from '../monday/client';
import type { QuickBooksClient } from '../quickbooks/client';
import { logDebug, messageDisposition, retryDelaySeconds } from '../flags';
import { dryRunConsumerDeps, type BatchSkipContext } from '../writeSwitch';
import type { EntityType, MapEntry, MondayBoards, QueueMessage, QuickbooksSyncConfig } from '../types';

export interface QueueMessageLike<T> {
  body: T;
  // Cloudflare's Message.attempts (1 on first delivery) and Message.timestamp (when it was
  // sent). Optional so tests and callers that don't care can omit them.
  attempts?: number;
  timestamp?: Date;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ConsumerDeps {
  qbEventStore: QbEventStore;
  mondayEventStore: MondayEventStore;
  mapStore: MapStore;
  mondayClient: MondayClient;
  quickBooksClient: QuickBooksClient;
  config: QuickbooksSyncConfig;
}

// Marks a row's error as terminal (acked, not retried, not dead-lettered): fix the cause, then
// redrive (README "Dead letters and redrive").
export const TERMINAL_PREFIX = 'not retried: ';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const QB_CUSTOMER_NAME_FIELDS = ['DisplayName', 'Title', 'GivenName', 'MiddleName', 'FamilyName', 'Suffix'];

const BOARD_KEY_FOR_ENTITY: Record<EntityType, keyof MondayBoards> = {
  customer: 'customers',
  invoice: 'invoices',
  product: 'products',
};

/**
 * The queue() entry point for the write queue: the write switch's per-message decision in front
 * of processSyncQueueBatch. `write` runs it with the real deps; `dry-run` runs the same code
 * against recording/read-only deps (src/writeSwitch.ts), which then acks; `retry` (`hold`, or a
 * KV read failure) leaves the message on the queue untouched, backing off like any retry.
 */
export async function consumeSyncBatch(
  messages: QueueMessageLike<QueueMessage>[],
  deps: ConsumerDeps,
  gate: BatchSkipContext
): Promise<void> {
  for (const message of messages) {
    const ctx = { ...gate, deliveryId: `${message.body.direction}:${message.body.eventId}` };
    const disposition = messageDisposition(gate.mode, message.body);
    logDebug(ctx, 'disposition', { disposition, writeStamp: message.body.writeStamp ?? null, attempts: message.attempts ?? null });
    if (disposition === 'retry') {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      continue;
    }
    await processSyncQueueBatch([message], disposition === 'write' ? deps : dryRunConsumerDeps(deps, ctx));
  }
}

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
      const terminal = isTerminalError(err);
      const error = terminal ? `${TERMINAL_PREFIX}${errorMessage(err)}` : errorMessage(err);
      console.error(`quickbooks-sync consumer: ${message.body.direction} "${message.body.eventId}" failed: ${error}`);
      // Recording the failure is bookkeeping; a D1 error here must not take the retry decision
      // down with it (the throw would fail the whole batch and retry every message immediately).
      let recorded = false;
      try {
        if (message.body.direction === 'qb-to-monday') {
          await deps.qbEventStore.updateStatus(message.body.eventId, 'failed', { error });
        } else {
          // A terminal failure also advances the create's requestid (migration 0005): Intuit
          // replays a failed response for a repeated requestid, and the fix-then-redrive path
          // needs a genuinely new request. Transient failures keep the same one.
          const bump = terminal && !(err as TerminalError).keepRequestId;
          await deps.mondayEventStore.updateStatus(message.body.eventId, 'failed', bump ? { error, bumpCreateAttempt: true } : { error });
        }
        recorded = true;
      } catch (recordErr) {
        console.error(`quickbooks-sync consumer: could not record failure for "${message.body.eventId}": ${errorMessage(recordErr)}`);
      }
      // A terminal failure (#33 review) is acked once it's on the row: retrying the same request
      // can only fail the same way. If it couldn't be recorded, retry so it isn't lost silently.
      if (terminal && recorded) message.ack();
      else message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
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

  // Stamp the QuickBooks Id on the customer's Monday item (#33 review) — in the same create_item
  // mutation, so the item carries it from the instant it exists. Monday's create_pulse echo of an
  // item we create is recognized by it in processMondayToQb.
  const qbIdColumn = event.entityType === 'customer' ? deps.config.quickbooksSync.customerQbIdColumn : null;
  if (qbIdColumn !== null) columnValues[qbIdColumn] = event.qbId;

  const existing = await deps.mapStore.getByQbId(event.entityType, event.qbId);
  const itemNameValue = getPath(record, deps.config.quickbooksSync.itemNameField[event.entityType]);
  const itemName = typeof itemNameValue === 'string' && itemNameValue.length > 0 ? itemNameValue : event.qbId;

  // The Monday item that already stands for this record, when the mapping doesn't say so yet.
  const unmappedItemId = existing ? null : (event.pendingMondayItemId ?? (await findUnmappedItem(event.entityType, event.qbId, boardId, deps)));

  if (existing || unmappedItemId !== null) {
    const mondayItemId = existing ? existing.mondayItemId : unmappedItemId!;
    if (!existing) {
      await linkMapping(deps, {
        entityType: event.entityType,
        qbId: event.qbId,
        mondayItemId,
        mondayBoardId: boardId,
        createdAt: new Date().toISOString(),
      });
    }
    // monday.com's Name column is a reserved pseudo-column addressable as column_id "name"
    // through the same change_multiple_column_values mutation used for every other mapped
    // column (developer.monday.com/api-reference/reference/name) — confirmed against monday's
    // public API docs, not yet exercised against a live account. This keeps the item's title in
    // sync with the QuickBooks-side name field (DisplayName, DocNumber, ...) on every update.
    await deps.mondayClient.changeColumnValues(boardId, mondayItemId, {
      ...columnValues,
      name: itemName,
    });
  } else {
    const created = await deps.mondayClient.createItem(boardId, itemName, columnValues);

    // Durably record the created item's id, status unchanged, before writing the mapping.
    // A queue retry that resumes here (the mapping lookup above still misses, because
    // createMapping below is what's about to fail or hasn't run yet) reuses this id instead
    // of calling createItem again -- closing the duplicate-item window.
    await deps.qbEventStore.updateStatus(eventId, event.status, { pendingMondayItemId: created.id });

    await linkMapping(deps, {
      entityType: event.entityType,
      qbId: event.qbId,
      mondayItemId: created.id,
      mondayBoardId: boardId,
      createdAt: new Date().toISOString(),
    });
  }

  // fetchedPayload is kept as a record of what was written, for inspecting a row after the fact.
  await deps.qbEventStore.updateStatus(eventId, 'written', { writtenAt: new Date().toISOString(), fetchedPayload });
}

// Every mapping write goes through here (#33 review). createMapping refuses to re-point a record
// already linked to a different item (it used to upsert silently). The one safe re-point: the
// item it's linked to is gone — archived or deleted in Monday, which is exactly what staff do to
// resolve the conflict ("archive the duplicate, then redrive"). While that item is live, the
// conflict stands as a terminal failure naming both items.
async function linkMapping(deps: ConsumerDeps, entry: MapEntry): Promise<void> {
  try {
    await deps.mapStore.createMapping(entry);
  } catch (err) {
    if (!(err instanceof MappingConflictError)) throw err;
    const linked = await deps.mondayClient.getItem(err.existingMondayItemId);
    if (linked !== null && linked.state === 'active') throw err;
    console.log(
      `quickbooks-sync consumer: re-pointing QuickBooks ${entry.entityType} ${entry.qbId} from Monday item "${err.existingMondayItemId}" (${linked === null ? 'not found' : linked.state}) to "${entry.mondayItemId}"`
    );
    await deps.mapStore.repointMapping(entry);
  }
}

// Before creating a Monday item for a QuickBooks record, look for one that already stands for it
// but isn't mapped yet (#33 review):
//   - a Customer created *from* Monday: its monday_events row recorded the new QuickBooks id right
//     after createCustomer, before the mapping — so QuickBooks' own webhook for that Customer
//     must not make a second Monday item;
//   - an item this path created earlier whose create_item response was lost (so no
//     pending_monday_item_id): found on the board by the QuickBooks Id it was stamped with.
async function findUnmappedItem(entityType: EntityType, qbId: string, boardId: number, deps: ConsumerDeps): Promise<string | null> {
  if (entityType !== 'customer') return null;
  const origin = await deps.mondayEventStore.findByQbId(qbId);
  if (origin !== null) return origin.mondayItemId;
  const qbIdColumn = deps.config.quickbooksSync.customerQbIdColumn;
  if (qbIdColumn === null) return null;
  const ids = await deps.mondayClient.findItemIdsByColumnValue(boardId, qbIdColumn, qbId);
  if (ids.length > 1) {
    console.error(`quickbooks-sync consumer: ${ids.length} Monday items carry QuickBooks Customer ${qbId} (${ids.join(', ')}); using ${ids[0]}`);
  }
  return ids[0] ?? null;
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

  const qbIdColumn = deps.config.quickbooksSync.customerQbIdColumn;

  if (qbId === null) {
    // Create-loop guards (#33) — is this item one the QuickBooks -> Monday path created? The
    // webhook checked the mapping too, but it can run before that path has written it.
    const linked = await deps.mapStore.getByMondayItemId('customer', event.mondayItemId);
    if (linked !== null) {
      await deps.mondayEventStore.updateStatus(eventId, 'written', { qbId: linked.qbId, writtenAt: new Date().toISOString() });
      return;
    }
    // Created from QuickBooks, item id recorded, mapping not written yet (a retry is pending):
    // adopt it — write the mapping here from the recorded QuickBooks id.
    const creator = await deps.qbEventStore.findByPendingMondayItemId('customer', event.mondayItemId);
    if (creator !== null) qbId = creator.qbId;
  }

  let item: MondayItemSnapshot | null = null;
  if (qbId === null) {
    // The decisive guard is the item itself. QuickBooks -> Monday writes the QuickBooks Id into
    // qbIdColumn in the same create_item call that makes the item, so an item created from
    // QuickBooks carries it however far that side got — even if create_item's response was lost
    // and nothing in D1 knows the item. Without the column that can't be told, so creating is
    // refused rather than risking a duplicate Customer in the books.
    if (qbIdColumn === null) {
      throw new TerminalError(
        'Monday -> QuickBooks Customer creates are disabled until config quickbooksSync.customerQbIdColumn names the Customers board’s QuickBooks Id column'
      );
    }
    // Re-read the item: the create_pulse payload need not include column values set at creation.
    item = await deps.mondayClient.getItem(event.mondayItemId);
    if (item === null || item.state !== 'active') {
      // items(ids:) returns archived and deleted items too — never create a Customer from one.
      throw new TerminalError(`monday item "${event.mondayItemId}" no longer exists (${item === null ? 'not found' : item.state})`);
    }
    const carried = mondayCellScalar(item.columnValues[qbIdColumn]);
    if (carried !== undefined) {
      const carriedQbId = String(carried);
      const other = await deps.mapStore.getByQbId('customer', carriedQbId);
      if (other !== null && other.mondayItemId !== event.mondayItemId) {
        // Another item already stands for this Customer: a copied item, or (after a lost create
        // response) the item QuickBooks' own webhook made for it. Same rule as linkMapping: while
        // that item is live it's a conflict for staff; once it's archived or deleted, adopt and
        // let linkMapping move the link here.
        const otherItem = await deps.mondayClient.getItem(other.mondayItemId);
        if (otherItem !== null && otherItem.state === 'active') {
          throw new TerminalError(
            `monday item "${event.mondayItemId}" carries QuickBooks Id ${carriedQbId}, which Monday item "${other.mondayItemId}" already stands for — archive whichever of the two is the duplicate (or clear this item's QuickBooks Id column if it was copied), then redrive`
          );
        }
      }
      qbId = carriedQbId;
    }
  }

  if (qbId === null) {
    // Build the Customer from the item as it stands now, not the create_pulse payload stored at
    // webhook time (#33 review): a create that failed terminally (say, a duplicate name) is fixed
    // by editing the item in Monday and redriving the row. raw_payload is kept only as a record.
    // (item is set here: every path that leaves qbId null above read it or threw.)
    const current = item!;
    const columnValues: Record<string, unknown> = { name: current.name };
    for (const [columnId, cell] of Object.entries(current.columnValues)) columnValues[columnId] = mondayCellScalar(cell);
    const qbFields = mapMondayToQbCustomerFields(columnValues, deps.config);
    // QuickBooks rejects a Customer with none of these (DisplayName is derived from the others
    // when absent). Fail with a readable error instead of a bare HTTP 400.
    if (!QB_CUSTOMER_NAME_FIELDS.some((field) => qbFields[field] !== undefined)) {
      throw new TerminalError(
        `monday item "${event.mondayItemId}" has no name to create a QuickBooks Customer from — check config customerCreateFieldMap maps "name" (the item name) to DisplayName`
      );
    }
    // requestid makes the create itself idempotent at QuickBooks: if a previous attempt's create
    // succeeded but its response was lost (so qbId was never recorded), the retry gets the
    // original Customer back instead of a second one. The -r<n> suffix changes only after a
    // terminal failure, so a redrive after fixing the item isn't answered with that failure.
    const requestId = `monday-item-${event.mondayItemId}${event.createAttempt > 0 ? `-r${event.createAttempt}` : ''}`;
    // Count the send before making it (migration 0006). If an earlier send under this requestid
    // got no answer (a transient failure after sending), it may have created the Customer — so
    // a rejection now (e.g. 6240 Duplicate Name, possibly against that very Customer) must not
    // advance the requestid, and staff must check QuickBooks before redriving.
    const priorSends = event.createSends;
    await deps.mondayEventStore.markCreateSent(eventId);
    let created: { id: string };
    try {
      created = await deps.quickBooksClient.createCustomer(qbFields, requestId);
    } catch (err) {
      if (isTerminalError(err) && priorSends > 0) {
        const displayName = typeof qbFields.DisplayName === 'string' ? qbFields.DisplayName : current.name;
        throw new TerminalError(
          `${err.message} — but an earlier attempt to create this Customer (requestid ${requestId}) got no answer and may have succeeded, so QuickBooks may already hold this item's own Customer. ` +
            `Search QuickBooks Customers for "${displayName}": if it's there, put its Id in this item's QuickBooks Id column (and if a Monday item already exists for that Customer, archive the duplicate first), then redrive; if not, see README "Dead letters and redrive" before redriving`,
          { keepRequestId: true }
        );
      }
      throw err;
    }
    qbId = created.id;

    // Durably record the new id before doing anything else. 'fetched' is the intermediate
    // signal for "the QuickBooks side is done, the local bookkeeping is not"; if either write
    // below fails, the retry finds qbId set and skips straight past createCustomer.
    await deps.mondayEventStore.updateStatus(eventId, 'fetched', { qbId });
  }

  // Safe to re-run on a resumed attempt: linking the same pair again is a no-op. Linking a
  // Customer that another live item already stands for (e.g. QuickBooks' webhook for this very
  // Customer made its own item while our create's response was lost) is a terminal conflict,
  // before this item is stamped with the Id.
  await linkMapping(deps, {
    entityType: 'customer',
    qbId,
    mondayItemId: event.mondayItemId,
    mondayBoardId: customersBoardId,
    createdAt: new Date().toISOString(),
  });

  // Mark the item with its Customer's id too, so an item that stands for a QuickBooks Customer
  // always says so on the item (idempotent; covers adopted items as well).
  if (qbIdColumn !== null) {
    await deps.mondayClient.changeColumnValues(customersBoardId, event.mondayItemId, { [qbIdColumn]: qbId });
  }

  await deps.mondayEventStore.updateStatus(eventId, 'written', {
    qbId,
    writtenAt: new Date().toISOString(),
  });
}
