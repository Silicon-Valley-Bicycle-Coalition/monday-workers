import type { EventStore } from '../db/events';
import type { SubscriptionStore } from '../db/subscriptions';
import type { FunraiseClient } from '../funraise/client';
import type { MondayClient } from '../monday/client';
import type { EntityType, EventRow, FunraiseSyncConfig } from '../types';
import { upsertSubscription } from '../subscriptions/upsert';
import { mapToMondayColumns } from '../mapping/fieldMap';
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
  // Both needed to link an installment to its Recurring Gifts item (spec 2026-09-18 "Webhook
  // side"); optional so a fork without the subscriptions poller still runs, minus the link.
  subscriptionStore?: SubscriptionStore;
  funraiseClient?: FunraiseClient;
}

// The Funraise transaction field the Donations board's Date column is mapped from
// (`columnMap.donationDate` in config/svbc.json). Funraise sends it as epoch
// milliseconds, so it's normalized to YYYY-MM-DD before the write, and Fiscal Year Ending is
// derived from that same normalized value so the two columns can never disagree.
const TRANSACTION_DATE_FIELD = 'donationDate';
// A recurring installment is a transaction carrying its subscription (`data.subscription.id`,
// `data.subscription.sequence`); a paid event ticket carries `data.fundraisingEvent`. Both are
// Funraise facts, not per-deployment choices, hence constants.
const SUBSCRIPTION_ID_FIELD = 'subscription.id';
const EVENT_FIELD = 'fundraisingEvent';


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

  // Every delivery is a transaction (Funraise's only webhook), so every write lands on the
  // Donations board; Recurring Gifts is fed by the subscriptions poller instead.
  const boardId = deps.config.monday.boards['donations:live'];
  if (boardId === null) {
    throw new Error('config: monday.boards["donations:live"] is not configured');
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

  const {
    donorLinkColumn,
    entityIdColumn,
    thankYouSentColumn,
    giftTypeColumn,
    giftTypeValue,
    eventGiftTypeValue,
    fiscalYearColumn,
    recurringGiftLinkColumn,
  } = deps.config.funraiseSync;
  const columnValues = mapToMondayColumns(rawPayload, deps.config);

  // columnMap writes values verbatim, which is wrong for the date: Funraise sends epoch
  // milliseconds and Monday's date column wants { date: 'YYYY-MM-DD' }. Replace the mapped
  // value with the normalized one, or drop the column rather than write a raw number.
  const transactionDate = entityType === 'transaction' ? toISODate(getPath(rawPayload, TRANSACTION_DATE_FIELD)) : null;
  const dateColumn = deps.config.funraiseSync.columnMap[TRANSACTION_DATE_FIELD];
  if (entityType === 'transaction' && dateColumn) {
    if (transactionDate !== null) columnValues[dateColumn] = { date: transactionDate };
    else delete columnValues[dateColumn];
  }

  if (donorItemId) {
    columnValues[donorLinkColumn] = {
      item_ids: [Number(donorItemId)],
    };
  }

  // An installment links to its Recurring Gifts item on every write, create and update alike —
  // it is a fact about the gift, not a first-write stamp.
  if (recurringGiftLinkColumn) {
    const recurringGiftItemId = await resolveRecurringGiftItem(rawPayload, deps);
    if (recurringGiftItemId !== null) {
      columnValues[recurringGiftLinkColumn] = { item_ids: [Number(recurringGiftItemId)] };
    }
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

  // First write only — same reasoning as Thank You Sent above. A paid event ticket (the
  // transaction carries `fundraisingEvent`) gets its own label so donation-rollups' membership
  // rule, which counts only its eligible Gift Types, never treats a ticket as a renewal.
  if (giftTypeColumn && entityType === 'transaction') {
    const isEventTicket = getPath(rawPayload, EVENT_FIELD) != null;
    columnValues[giftTypeColumn] = isEventTicket ? eventGiftTypeValue : giftTypeValue;
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

/**
 * The Recurring Gifts item for the installment's subscription, or null when the transaction is
 * a one-time gift. Ledger first; a never-seen subscription is fetched from Funraise and written
 * through the same upsert the poller uses, so a brand-new monthly donor's first installment links
 * immediately instead of waiting for the next poll. Anything that stops the link is logged and
 * the gift is still written — the link is worth having, never worth failing a donation for.
 */
async function resolveRecurringGiftItem(rawPayload: Record<string, unknown>, deps: ProcessBatchDeps): Promise<string | null> {
  const raw = getPath(rawPayload, SUBSCRIPTION_ID_FIELD);
  const subscriptionId = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' && raw !== '' ? raw : null;
  if (subscriptionId === null) return null;

  const { subscriptionStore, funraiseClient, mondayClient, config } = deps;
  if (!subscriptionStore || !funraiseClient) {
    console.warn(
      `funraise-sync consumer: recurringGiftLinkColumn is set but the subscriptions ledger or Funraise client is not wired; leaving the link unset`
    );
    return null;
  }

  try {
    const known = await subscriptionStore.getByFunraiseId(subscriptionId);
    if (known) return known.mondayItemId;

    const row = await funraiseClient.getSubscription(subscriptionId);
    if (row === null) {
      console.warn(`funraise-sync consumer: subscription "${subscriptionId}" not found in Funraise; leaving the Recurring Gift link unset`);
      return null;
    }
    const result = await upsertSubscription(row, { subscriptionStore, mondayClient, config });
    return result.mondayItemId;
  } catch (err) {
    // A Funraise outage, a Monday failure creating the Recurring Gifts item, or an unconfigured
    // board must not fail (and retry) the donation itself; the hourly poll will create or repair
    // the Recurring Gifts item, and the next edit of this gift picks the link up.
    console.warn(
      `funraise-sync consumer: could not resolve Recurring Gift for subscription "${subscriptionId}"; leaving the link unset: ${errorMessage(err)}`
    );
    return null;
  }
}

function describeItemName(entityType: EntityType, rawPayload: Record<string, unknown>, config: FunraiseSyncConfig): string {
  const value = getPath(rawPayload, config.funraiseSync.itemNameField);
  return typeof value === 'string' && value.length > 0 ? value : `Funraise ${entityType}`;
}
