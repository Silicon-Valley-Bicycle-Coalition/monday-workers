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
import { isTerminalError, TerminalError } from '../errors';
import { stripDenylistedFields } from '../util/stripFields';
import { linkedItemId } from '../util/itemId';
import { logDebug, messageDisposition, retryDelaySeconds, type WriteStamp } from '../flags';
import { dryRunConsumerDeps, type BatchSkipContext } from '../writeSwitch';
import { OutageBreaker } from '../monday/outage';
import { recordEmployerAnswer, type EmployerAnswerSink } from './employerAnswer';

export interface QueueMessageLike<T> {
  body: T;
  // Cloudflare's Message.attempts (1 on first delivery) and Message.timestamp (when it was
  // sent). Optional so tests and callers that don't care can omit them.
  attempts?: number;
  timestamp?: Date;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

// `writeStamp` (flags.ts): set by the route when the write switch was `off` at ingest. A body
// enqueued before the switch existed has no such key and is live.
export type FunraiseQueueMessage = { entityType: EntityType; entityId: string } & WriteStamp;

export interface ProcessBatchDeps {
  eventStore: EventStore;
  mondayClient: MondayClient;
  config: FunraiseSyncConfig;
  // Both needed to link an installment to its Recurring Gifts item (spec 2026-09-18 "Webhook
  // side"); optional so a fork without the subscriptions poller still runs, minus the link.
  subscriptionStore?: SubscriptionStore;
  funraiseClient?: FunraiseClient;
  // impact-attribution's EmployerAnswers RPC (GitHub #6); null or absent when the binding isn't
  // there, which switches the hand-over off like employerAnswers.enabled false.
  employerAnswers?: EmployerAnswerSink | null;
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
// The Donations board's Funraise ID column is a LINK column, which rejects a bare string — write
// the same { url, text } shape salesforce-import stamps on migrated gifts (transform/fields.ts
// funraiseTransactionLink), so a lookup by the bare id (matched against the link text) finds a
// gift whichever writer created it.
const FUNRAISE_TRANSACTION_URL = 'https://platform.funraise.io/transaction/';
// On the events row's error for a failure that was acked instead of retried (src/errors.ts), so
// it reads differently from one still being retried. The row stays 'failed', so
// scripts/redrive-failed.mjs picks it up like any other.
export const TERMINAL_PREFIX = 'not retried: ';

/**
 * The queue() entry point for the write queue: the write switch's per-message decision in front
 * of processFunraiseQueueBatch. `write` runs it with the real deps; `dry-run` runs the same code
 * against recording/read-only deps (src/writeSwitch.ts), which then acks; `retry` (`hold`, or a
 * KV read failure) leaves the message on the queue untouched, backing off like any retry.
 */
export async function consumeFunraiseBatch(
  messages: QueueMessageLike<FunraiseQueueMessage>[],
  deps: ProcessBatchDeps,
  gate: BatchSkipContext
): Promise<void> {
  // One breaker for the whole batch (GL#101): after a Monday outage the rest is deferred unrun.
  const breaker = new OutageBreaker();
  for (const message of messages) {
    const { entityType, entityId } = message.body;
    const ctx = { ...gate, deliveryId: `${entityType}:${entityId}` };
    const disposition = messageDisposition(gate.mode, message.body);
    logDebug(ctx, 'disposition', { disposition, writeStamp: message.body.writeStamp ?? null, attempts: message.attempts ?? null });
    if (disposition === 'retry') {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      continue;
    }
    await processFunraiseQueueBatch([message], disposition === 'write' ? deps : dryRunConsumerDeps(deps, ctx), breaker);
  }
}

export async function processFunraiseQueueBatch(
  messages: QueueMessageLike<FunraiseQueueMessage>[],
  deps: ProcessBatchDeps,
  breaker: OutageBreaker = new OutageBreaker()
): Promise<void> {
  for (const message of messages) {
    const { entityType, entityId } = message.body;
    // Monday is down or rate-limiting (GL#101): retry with backoff without calling it, rather than
    // spend the transport's in-process attempts again on every remaining message.
    if (breaker.open) {
      breaker.defer(message);
      continue;
    }
    try {
      await processOne(entityType, entityId, deps);
      message.ack();
    } catch (err) {
      const terminal = isTerminalError(err);
      const outage = !terminal && breaker.trip(err);
      const errMsg = terminal ? `${TERMINAL_PREFIX}${errorMessage(err)}` : errorMessage(err);
      console.error(
        `funraise-sync consumer: failed to process ${entityType} "${entityId}": ${errMsg}` +
          (terminal ? ' — fix the cause, then re-drive with scripts/redrive-failed.mjs' : '') +
          (outage ? ' — Monday unavailable, deferring the rest of the batch' : '')
      );
      // Recording the failure is bookkeeping; a D1 error here must not take the retry decision
      // down with it (the throw would fail the whole batch and retry every message immediately).
      let recorded = false;
      try {
        await deps.eventStore.updateStatusByEntity(entityType, entityId, 'failed', {
          error: errMsg,
        });
        recorded = true;
      } catch (recordErr) {
        console.error(
          `funraise-sync consumer: could not record failure for ${entityType} "${entityId}": ${errorMessage(recordErr)}`
        );
      }
      // A terminal failure (GL#75) is acked once it's on the row: retrying the same request can only
      // fail the same way. If it couldn't be recorded, retry so it isn't lost silently. Anything
      // else retries with the shared delay — 1 minute doubling to an hour, across wrangler.jsonc's
      // max_retries of 100 (about four days), raised to Monday's hint on an outage.
      if (terminal && recorded) message.ack();
      else if (outage) breaker.defer(message);
      else message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
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

  const rawPayload = await giftRecord(entityType, entityId, event.rawPayload, deps);

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

  // The matching-gift company on a one-time gift, as a proposed employer for staff to confirm.
  // Best effort and idempotent, so it runs once the donor is known, ahead of whichever write below.
  if (donorItemId) await recordEmployerAnswer(rawPayload, entityId, donorItemId, transactionDate, deps);
  const dateColumn = deps.config.funraiseSync.columnMap[TRANSACTION_DATE_FIELD];
  if (entityType === 'transaction' && dateColumn) {
    if (transactionDate !== null) columnValues[dateColumn] = { date: transactionDate };
    else delete columnValues[dateColumn];
  }

  if (donorItemId) {
    columnValues[donorLinkColumn] = {
      item_ids: [linkedItemId(donorItemId)],
    };
  }

  // An installment links to its Recurring Gifts item on every write, create and update alike —
  // it is a fact about the gift, not a first-write stamp.
  if (recurringGiftLinkColumn) {
    const recurringGiftItemId = await resolveRecurringGiftItem(rawPayload, deps);
    if (recurringGiftItemId !== null) {
      columnValues[recurringGiftLinkColumn] = { item_ids: [linkedItemId(recurringGiftItemId)] };
    }
  }
  if (entityIdColumn) {
    columnValues[entityIdColumn] = { url: `${FUNRAISE_TRANSACTION_URL}${entityId}`, text: entityId };
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

  // Before creating, adopt an existing item carrying this transaction's Funraise ID: a gift
  // salesforce-import migrated (the first Funraise update after cutover — an edit or refund — has
  // no D1 row yet), or this Worker's own earlier create whose D1 update was lost. Adopting writes
  // the Funraise-owned columns only — never the first-write stamps below, and never the Donor
  // link: a migrated gift's Gift Type, Thank You Sent, Fiscal Year and Donor (which can be an
  // Organization) came from Salesforce, and an orphan of our own already got all of them at
  // create. Items on archived fiscal years aren't visible to the lookup — see README.
  if (entityIdColumn) {
    const existing = await deps.mondayClient.findItemByColumnValue(boardId, entityIdColumn, entityId);
    if (existing) {
      const { [donorLinkColumn]: _donorLink, ...adoptValues } = columnValues;
      await deps.mondayClient.changeColumnValues(boardId, existing.id, adoptValues);
      await deps.eventStore.updateStatusByEntity(entityType, entityId, 'written', {
        mondayItemId: existing.id,
        writtenAt: new Date().toISOString(),
      });
      return;
    }
  }

  // Nothing carries this Funraise ID and the lookup above can't see archived items. A gift dated
  // before the oldest active fiscal year may well be an archived migrated gift, and creating
  // here would double it in donation-rollups, so flag it for staff instead. Terminal for this
  // delivery (acked, not retried); a later edit re-enters the queue and is judged afresh.
  const oldestActiveFiscalYear = deps.config.funraiseSync.oldestActiveFiscalYear;
  const giftFiscalYear = fiscalYearEnding(transactionDate);
  if (entityType === 'transaction' && oldestActiveFiscalYear !== null && giftFiscalYear !== null && Number(giftFiscalYear) < oldestActiveFiscalYear) {
    const reason =
      `needs review: transaction is in fiscal year ${giftFiscalYear}, before the oldest active year ` +
      `${oldestActiveFiscalYear}, and no active Donations item carries its Funraise ID. It may be an archived ` +
      `migrated gift (update it by hand) or a genuinely new back-dated gift (add it by hand). Nothing was created.`;
    console.error(`funraise-sync consumer: transaction "${entityId}" ${reason}`);
    await deps.eventStore.updateStatusByEntity(entityType, entityId, 'needs_review', { error: reason });
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
 * What the consumer maps. With `rereadFromFunraise` on, the delivery is only a pointer: the gift
 * is fetched from Funraise by its id and stripped of `doNotMigrateFields` exactly as the route
 * strips the body, so a delivery forged with the URL secret can't put its own amount, status or
 * donor on the board. A gift Funraise doesn't have is terminal (a forged or Test-button id); a
 * missing API key or a Funraise outage retries, since fixing either heals the backlog. Off, the
 * stored body is mapped as it arrived.
 */
async function giftRecord(entityType: EntityType, entityId: string, storedPayload: string, deps: ProcessBatchDeps): Promise<Record<string, unknown>> {
  const body = JSON.parse(storedPayload) as Record<string, unknown>;
  if (!deps.config.funraiseSync.rereadFromFunraise || entityType !== 'transaction') return body;
  if (!deps.funraiseClient) {
    throw new Error('funraiseSync.rereadFromFunraise is on but FUNRAISE_API_KEY is not set; not writing from the webhook body');
  }
  if (!/^\d+$/.test(entityId)) {
    throw new TerminalError(`transaction id "${entityId}" is not a Funraise donation id; nothing was written`);
  }
  const record = await deps.funraiseClient.getDonation(entityId);
  if (record === null) {
    throw new TerminalError(`Funraise has no donation ${entityId}; the delivery was not written`);
  }
  if (String(record.id) !== entityId) {
    throw new TerminalError(`Funraise returned donation ${String(record.id)} for ${entityId}; nothing was written`);
  }
  const stripped = stripDenylistedFields(record, deps.config.funraiseSync.doNotMigrateFields);
  // Paths only, never values: both sides are donor PII. A mismatch is a forged body or an edit
  // that landed after this delivery was sent; either way Funraise's record is what gets written.
  const differing = mappedPathsDiffering(body, stripped, deps.config);
  if (differing.length > 0) {
    console.warn(`funraise-sync consumer: transaction "${entityId}" webhook body differs from Funraise's record at ${differing.join(', ')}; writing Funraise's record`);
  }
  return stripped;
}

function mappedPathsDiffering(body: Record<string, unknown>, record: Record<string, unknown>, config: FunraiseSyncConfig): string[] {
  const s = config.funraiseSync;
  const paths = [
    ...Object.keys(s.columnMap),
    s.itemNameField,
    s.donorExternalIdField,
    ...s.emailFieldPrecedence,
    TRANSACTION_DATE_FIELD,
    SUBSCRIPTION_ID_FIELD,
  ];
  return [...new Set(paths)].filter((p) => JSON.stringify(getPath(body, p) ?? null) !== JSON.stringify(getPath(record, p) ?? null));
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
  // The id comes from the webhook payload and ends up in a Funraise API path, so accept only
  // what Funraise issues (digits); `..` would otherwise resolve to a different endpoint.
  if (!/^\d+$/.test(subscriptionId)) {
    console.warn('funraise-sync consumer: subscription id is not numeric; leaving the Recurring Gift link unset');
    return null;
  }

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
