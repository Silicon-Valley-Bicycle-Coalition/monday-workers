import type { FunraiseClient, FunraiseSubscription } from '../funraise/client';
import type { SubscriptionStore } from '../db/subscriptions';
import type { MondayClient } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';
import { upsertSubscription, type UpsertAction } from './upsert';

// Keyset pagination on (updtime, id) (#25). Two named cursors describe where the poll is:
//   subscriptions     — T, the updtime every row at or before which has been read (except, while
//                       a tie walk is in progress, the rows tied at T with an id above I)
//   subscriptions:id  — I, the last id read in the tie group at T, or NO_TIE when that group is
//                       complete and the next request is the forward query `updtime > T`
//
// This replaced offset paging over `updtime >= cursor` (`page=N`, with `subscriptions:page` and
// `subscriptions:max` — both now unused). Offset paging over a column that changes during the
// walk skips rows: an edited row jumps to the end and every later row shifts up one slot, so the
// row that slides onto an already-read page is never read, and once the cursor passes its updtime
// it never will be — along with any cancellation on it. A keyset query asks for rows by value, so
// rows moving elsewhere can't push an unread one behind the cursor.
export const SUBSCRIPTIONS_CURSOR = 'subscriptions';
export const SUBSCRIPTIONS_ID_CURSOR = 'subscriptions:id';
export const NO_TIE = -1;

// Funraise returns fixed pages of 10 (verified 2026-09-18); a shorter page is the last one.
const FUNRAISE_PAGE_SIZE = 10;
// Bounds a run. ~1,200 subscriptions today is ~120 forward requests plus tie re-reads.
const DEFAULT_MAX_PAGES = 200;

export interface PollSubscriptionsDeps {
  funraiseClient: FunraiseClient;
  subscriptionStore: SubscriptionStore;
  mondayClient: MondayClient;
  config: FunraiseSyncConfig;
  pageSize?: number;
  // Funraise requests one run may make (each returns at most one page).
  maxPages?: number;
}

export interface PollSubscriptionsResult {
  pages: number;
  rows: number;
  actions: Record<UpsertAction, number>;
  // T after this run.
  cursor: number;
  // I after this run: the tie walk's last id, or null when no tie walk is pending.
  tieId: number | null;
  // True when the run ended on a short forward page: nothing left to read until Funraise changes.
  caughtUp: boolean;
}

const numericId = (row: FunraiseSubscription): number | null => {
  const n = Number(row.id);
  return Number.isFinite(n) ? n : null;
};

/**
 * One poll run. Each request is one of two keyset queries:
 *
 * - **Tie walk** (I ≠ NO_TIE): `updtime = T and id > I order by id asc`. Rows tied at T can only
 *   leave the group (an edit gives them a later updtime, where the forward query finds them),
 *   never join it, so walking it by id misses nothing. I advances to the page's last id; a short
 *   page completes the group (I = NO_TIE).
 * - **Forward** (I = NO_TIE): `updtime > T order by updtime asc`. A short page holds every row
 *   after T, so T moves to its max updtime and the poll is caught up. A full page holds every row
 *   below its max updtime M but maybe not all rows AT M (Funraise promises no tie order), so T = M
 *   and a tie walk of M from id 0 follows — re-reading this page's rows at M, which the ledger's
 *   per-row updtime makes no-ops.
 *
 * Cursors are persisted after each page's rows have all landed; a write failure throws first, so
 * the page is re-read next run and rows that did land skip as no-ops. Idle cost: one request.
 */
export async function pollSubscriptions(deps: PollSubscriptionsDeps): Promise<PollSubscriptionsResult> {
  const { funraiseClient, subscriptionStore, mondayClient, config } = deps;
  const pageSize = deps.pageSize ?? FUNRAISE_PAGE_SIZE;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;

  let cursor = await subscriptionStore.getCursor(SUBSCRIPTIONS_CURSOR);
  // A missing `subscriptions:id` reads as 0: a tie walk of T from the start. That is the safe
  // upgrade from the offset-paged cursors (whose `>=` re-read T's rows anyway) — except at T = 0,
  // a fresh install, where nothing can be tied.
  let tieId = cursor <= 0 ? NO_TIE : await subscriptionStore.getCursor(SUBSCRIPTIONS_ID_CURSOR);
  const actions: Record<UpsertAction, number> = { noop: 0, updated: 0, adopted: 0, created: 0 };
  let pages = 0;
  let rows = 0;
  let caughtUp = false;

  const writeAll = async (batch: FunraiseSubscription[]): Promise<void> => {
    if (batch.length > 0) pages++;
    for (const row of batch) {
      const result = await upsertSubscription(row, { subscriptionStore, mondayClient, config });
      actions[result.action]++;
      rows++;
    }
  };

  for (let i = 0; i < maxPages; i++) {
    if (tieId !== NO_TIE) {
      const batch = await funraiseClient.listSubscriptionsAtUpdtime(cursor, tieId);
      await writeAll(batch);
      if (batch.length < pageSize) {
        tieId = NO_TIE;
      } else {
        const ids = batch.map(numericId).filter((n): n is number => n !== null);
        if (ids.length === 0) {
          throw new Error(`funraise-sync subscriptions poll: a full page tied at updtime ${cursor} carries no numeric id; cannot continue the walk`);
        }
        tieId = Math.max(...ids);
      }
      await subscriptionStore.setCursor(SUBSCRIPTIONS_ID_CURSOR, tieId);
      continue;
    }

    const batch = await funraiseClient.listSubscriptionsUpdatedAfter(cursor);
    await writeAll(batch);
    const updtimes = batch.map((r) => r.updtime).filter((u): u is number => typeof u === 'number' && Number.isFinite(u));
    const pageMax = updtimes.length > 0 ? Math.max(...updtimes) : cursor;

    if (batch.length < pageSize) {
      // Everything after T was on this page: caught up.
      if (pageMax > cursor) {
        cursor = pageMax;
        await subscriptionStore.setCursor(SUBSCRIPTIONS_CURSOR, cursor);
      }
      await subscriptionStore.setCursor(SUBSCRIPTIONS_ID_CURSOR, NO_TIE);
      caughtUp = true;
      break;
    }
    if (pageMax <= cursor) {
      // A full page matching `updtime > T` must carry an updtime above T; if not, the API has
      // changed shape — stop rather than loop.
      throw new Error(`funraise-sync subscriptions poll: a full page after updtime ${cursor} carries no later updtime`);
    }
    cursor = pageMax;
    tieId = 0;
    // Tie cursor first: interrupted between the two writes, the next run walks the OLD T's tie
    // group again (harmless no-ops) rather than jumping past unread rows at the new T.
    await subscriptionStore.setCursor(SUBSCRIPTIONS_ID_CURSOR, tieId);
    await subscriptionStore.setCursor(SUBSCRIPTIONS_CURSOR, cursor);
  }

  return { pages, rows, actions, cursor, tieId: tieId === NO_TIE ? null : tieId, caughtUp };
}
