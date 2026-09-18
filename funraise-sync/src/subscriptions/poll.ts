import type { FunraiseClient } from '../funraise/client';
import type { SubscriptionStore } from '../db/subscriptions';
import type { MondayClient } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';
import { upsertSubscription, type UpsertAction } from './upsert';

// Three named cursors describe where the poll is:
//   subscriptions       — the updtime the current query filters on (`updtime >= cursor`)
//   subscriptions:page  — the next page of that query to read
//   subscriptions:max   — the largest updtime seen so far in that query, which becomes the
//                         next query's cursor once a short page proves this one exhausted
export const SUBSCRIPTIONS_CURSOR = 'subscriptions';
export const SUBSCRIPTIONS_PAGE_CURSOR = 'subscriptions:page';
export const SUBSCRIPTIONS_MAX_CURSOR = 'subscriptions:max';

// Funraise returns fixed pages of 10 (verified 2026-09-18); a shorter page is the last one.
const FUNRAISE_PAGE_SIZE = 10;
// ~600 subscriptions today; 200 pages is 2,000 rows, far past a full walk, and bounds a run.
const DEFAULT_MAX_PAGES = 200;

export interface PollSubscriptionsDeps {
  funraiseClient: FunraiseClient;
  subscriptionStore: SubscriptionStore;
  mondayClient: MondayClient;
  config: FunraiseSyncConfig;
  pageSize?: number;
  maxPages?: number;
}

export interface PollSubscriptionsResult {
  pages: number;
  rows: number;
  actions: Record<UpsertAction, number>;
  // The timestamp cursor after this run (unchanged while a query is still being paged).
  cursor: number;
  // The page the next run resumes from: 0 once the current query is exhausted.
  nextPage: number;
}

/**
 * One poll run (spec 2026-09-18 "Architecture", amended 2026-09-18 for Workers Free): the query
 * `updtime >= cursor order by updtime asc` is walked page by page, and the page index is
 * persisted so a run bounded to a few pages resumes where the last one stopped. The timestamp
 * cursor moves only when a short page proves the query exhausted, to the largest updtime seen
 * in it — moving it earlier would be wrong, because a bulk import can give more rows the same
 * updtime than fit on one page, and a cursor equal to that updtime would re-read the same first
 * page forever. `>=` on the next query re-reads the boundary rows, which the ledger's per-row
 * updtime turns into no-ops. A write failure throws before any cursor is touched, so the page
 * is re-read next run; rows that did land skip as no-ops.
 */
export async function pollSubscriptions(deps: PollSubscriptionsDeps): Promise<PollSubscriptionsResult> {
  const { funraiseClient, subscriptionStore, mondayClient, config } = deps;
  const pageSize = deps.pageSize ?? FUNRAISE_PAGE_SIZE;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;

  let cursor = await subscriptionStore.getCursor(SUBSCRIPTIONS_CURSOR);
  let page = await subscriptionStore.getCursor(SUBSCRIPTIONS_PAGE_CURSOR);
  let queryMax = Math.max(cursor, await subscriptionStore.getCursor(SUBSCRIPTIONS_MAX_CURSOR));
  const actions: Record<UpsertAction, number> = { noop: 0, updated: 0, adopted: 0, created: 0 };
  let pages = 0;
  let rows = 0;

  for (let i = 0; i < maxPages; i++) {
    const batch = await funraiseClient.listSubscriptionsUpdatedSince(cursor, page);
    if (batch.length > 0) pages++;

    for (const row of batch) {
      const result = await upsertSubscription(row, { subscriptionStore, mondayClient, config });
      actions[result.action]++;
      rows++;
      if (typeof row.updtime === 'number' && Number.isFinite(row.updtime) && row.updtime > queryMax) {
        queryMax = row.updtime;
      }
    }

    if (batch.length < pageSize) {
      // Query exhausted: the next query starts at the largest updtime it contained.
      cursor = queryMax;
      page = 0;
      await subscriptionStore.setCursor(SUBSCRIPTIONS_CURSOR, cursor);
      await subscriptionStore.setCursor(SUBSCRIPTIONS_PAGE_CURSOR, 0);
      await subscriptionStore.setCursor(SUBSCRIPTIONS_MAX_CURSOR, cursor);
      break;
    }

    page++;
    await subscriptionStore.setCursor(SUBSCRIPTIONS_PAGE_CURSOR, page);
    await subscriptionStore.setCursor(SUBSCRIPTIONS_MAX_CURSOR, queryMax);
  }

  return { pages, rows, actions, cursor, nextPage: page };
}
