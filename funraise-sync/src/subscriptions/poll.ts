import type { FunraiseClient } from '../funraise/client';
import type { SubscriptionStore } from '../db/subscriptions';
import type { MondayClient } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';
import { upsertSubscription, type UpsertAction } from './upsert';

export const SUBSCRIPTIONS_CURSOR = 'subscriptions';

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
  cursor: number;
}

/**
 * One poll run (spec 2026-09-18 "Architecture"): read the cursor, page through every
 * subscription with `updtime >= cursor` in updtime order, write each row, and advance the
 * cursor to the largest updtime seen — only after the whole page landed. A write failure
 * throws with the cursor untouched, so the next run re-reads the page; rows that did land are
 * in the ledger and skip as no-ops. `>=` deliberately re-reads the boundary row for the same
 * reason. The query's cursor is fixed for the run so page indexes stay stable.
 */
export async function pollSubscriptions(deps: PollSubscriptionsDeps): Promise<PollSubscriptionsResult> {
  const { funraiseClient, subscriptionStore, mondayClient, config } = deps;
  const pageSize = deps.pageSize ?? FUNRAISE_PAGE_SIZE;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;

  const startCursor = await subscriptionStore.getCursor(SUBSCRIPTIONS_CURSOR);
  let cursor = startCursor;
  const actions: Record<UpsertAction, number> = { noop: 0, updated: 0, adopted: 0, created: 0 };
  let pages = 0;
  let rows = 0;

  for (let page = 0; page < maxPages; page++) {
    const batch = await funraiseClient.listSubscriptionsUpdatedSince(startCursor, page);
    if (batch.length === 0) break;
    pages++;

    for (const row of batch) {
      const result = await upsertSubscription(row, { subscriptionStore, mondayClient, config });
      actions[result.action]++;
      rows++;
    }

    const pageMax = Math.max(...batch.map((r) => (typeof r.updtime === 'number' && Number.isFinite(r.updtime) ? r.updtime : 0)));
    if (pageMax > cursor) {
      cursor = pageMax;
      await subscriptionStore.setCursor(SUBSCRIPTIONS_CURSOR, cursor);
    }

    if (batch.length < pageSize) break;
  }

  return { pages, rows, actions, cursor };
}
