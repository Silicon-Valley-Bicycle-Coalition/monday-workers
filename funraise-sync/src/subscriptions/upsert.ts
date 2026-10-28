import type { FunraiseSubscription } from '../funraise/client';
import type { SubscriptionRow, SubscriptionStore } from '../db/subscriptions';
import type { MondayClient } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';
import { matchDonor } from '../matching/donors';
import { mapSubscriptionToColumns, subscriptionItemName } from './map';
import { linkedItemId } from '../util/itemId';

export interface UpsertSubscriptionDeps {
  subscriptionStore: SubscriptionStore;
  mondayClient: MondayClient;
  config: FunraiseSyncConfig;
}

export type UpsertAction = 'noop' | 'updated' | 'adopted' | 'created';

export interface UpsertSubscriptionResult {
  mondayItemId: string;
  action: UpsertAction;
}

// Longer than any one upsert can take (a few Monday calls), short enough that a writer which died
// holding a claim blocks that subscription for at most one poll cycle.
const CREATE_CLAIM_TTL_MS = 10 * 60 * 1000;

const isStale = (stored: SubscriptionRow, updtime: number | null): boolean =>
  stored.updtime !== null && updtime !== null && updtime <= stored.updtime;

/**
 * Write one Funraise subscription to the Recurring Gifts board, whichever side saw it first
 * (the hourly poll or the webhook consumer meeting an installment for a never-seen
 * subscription). Spec 2026-09-18 "Architecture":
 *
 * 1. Ledger hit with the same updtime → no-op. Older row than the ledger → no-op too, so a
 *    stale page re-read never regresses the board. Newer, or an adopted item with no stored
 *    updtime → update the stored item in place.
 * 2. Ledger miss → claim, then adopt before create: search the board's Funraise ID link column by
 *    the bare id (verified live: the bare id matches the link text). Found → update it and record
 *    it. Not found → create. This is what lets the first poll reconcile the items
 *    salesforce-import already made instead of duplicating them.
 *
 * The claim (#25): the poll and the queue consumer can both miss the ledger for one subscription
 * at once, and without coordination both found nothing on the board and both created an item
 * (seen 2026-09-19, subscription 197170). A ledger miss now first takes a D1 claim
 * (subscription_claims, an atomic INSERT … ON CONFLICT), before any Monday call — donor matching
 * included, since it can create a People item too. The loser throws having written nothing: the
 * poll re-reads the page next run, and the consumer leaves the Donations item's Recurring Gift
 * link for a later write (resolveRecurringGiftItem catches it). The winner re-reads the ledger in
 * case the other writer finished just before the claim. The claim is released once the ledger
 * records the item; a writer that fails midway leaves it to expire after CREATE_CLAIM_TTL_MS, so
 * nobody re-searches the board before Monday's index can see an item that writer may already
 * have created.
 *
 * The donor is matched or created with the same matchDonor the webhook path uses; a row with
 * no usable supporter is still written, with the Donor column left empty and recorded as null
 * so a later change retries the match.
 */
export async function upsertSubscription(
  row: FunraiseSubscription,
  deps: UpsertSubscriptionDeps
): Promise<UpsertSubscriptionResult> {
  const { subscriptionStore, mondayClient, config } = deps;
  const boardId = config.monday.boards['recurring-gifts'];
  if (boardId === null) {
    throw new Error('config: monday.boards["recurring-gifts"] is not configured');
  }
  const poll = config.subscriptionsPoll;
  const funraiseId = String(row.id);
  const updtime = typeof row.updtime === 'number' && Number.isFinite(row.updtime) ? row.updtime : null;
  const status = typeof row.status === 'string' ? row.status : '';

  let existing = await subscriptionStore.getByFunraiseId(funraiseId);
  if (existing && isStale(existing, updtime)) {
    return { mondayItemId: existing.mondayItemId, action: 'noop' };
  }

  let claimToken: string | null = null;
  if (!existing) {
    claimToken = crypto.randomUUID();
    if (!(await subscriptionStore.claimCreate(funraiseId, claimToken, CREATE_CLAIM_TTL_MS))) {
      throw new Error(`subscription "${funraiseId}" is being created by another writer; retry later`);
    }
    existing = await subscriptionStore.getByFunraiseId(funraiseId);
    if (existing && isStale(existing, updtime)) {
      await subscriptionStore.releaseCreate(funraiseId, claimToken);
      return { mondayItemId: existing.mondayItemId, action: 'noop' };
    }
  }

  const { columnValues, warnings } = mapSubscriptionToColumns(row, poll);
  for (const warning of warnings) {
    console.warn(`funraise-sync subscriptions: subscription "${funraiseId}": ${warning}`);
  }

  let donorItemId: string | null = null;
  if (row.supporter && typeof row.supporter === 'object') {
    const match = await matchDonor(mondayClient, config, { supporter: row.supporter });
    donorItemId = match.donorItemId;
  }
  if (poll.columns.donor && donorItemId !== null) {
    columnValues[poll.columns.donor] = { item_ids: [linkedItemId(donorItemId)] };
  }

  const record = async (mondayItemId: string, action: UpsertAction): Promise<UpsertSubscriptionResult> => {
    await subscriptionStore.upsert({ funraiseId, mondayItemId, donorItemId, status, updtime });
    if (claimToken !== null) await subscriptionStore.releaseCreate(funraiseId, claimToken);
    return { mondayItemId, action };
  };

  if (existing) {
    await mondayClient.changeColumnValues(boardId, existing.mondayItemId, columnValues);
    return record(existing.mondayItemId, 'updated');
  }

  if (poll.columns.funraiseId) {
    const adopted = await mondayClient.findItemByColumnValue(boardId, poll.columns.funraiseId, funraiseId);
    if (adopted) {
      await mondayClient.changeColumnValues(boardId, adopted.id, columnValues);
      return record(adopted.id, 'adopted');
    }
  }

  const created = await mondayClient.createItem(boardId, subscriptionItemName(row), columnValues);
  return record(created.id, 'created');
}
