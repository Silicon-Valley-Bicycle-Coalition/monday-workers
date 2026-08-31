import type { MailchimpClient } from '../mailchimp/client';
import type { MondayClient } from '../monday/client';
import type { CampaignItemsStore } from '../db/campaignItems';
import type { Config } from '../types';
import { withRetry } from '../retry';

// This daily cron has no Queue safety net underneath it (unlike the outbound/inbound
// consumers), so a transient Mailchimp/Monday hiccup here would otherwise abort the whole
// day's reconciliation with nothing to retry it until tomorrow. Small, fixed values —
// this isn't latency-sensitive, it's a once-a-day batch job.
const RECONCILE_RETRY_OPTIONS = { attempts: 3, delayMs: 500 };

export interface ReconcileDeps {
  mailchimpClient: MailchimpClient;
  mondayClient: MondayClient;
  campaignItemsStore: CampaignItemsStore;
  config: Config;
}

export interface ReconcileResult {
  created: number;
  renamed: number;
  archived: number;
}

export async function reconcileCampaigns(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { mailchimpClient, mondayClient, campaignItemsStore, config } = deps;
  const boardId = config.monday.campaignsBoardId;
  if (boardId === null) {
    throw new Error('config: monday.campaignsBoardId must be set before reconciliation can run');
  }

  const interests = await withRetry(() => mailchimpClient.listInterests(), RECONCILE_RETRY_OPTIONS);
  const trackedById = new Map((await campaignItemsStore.listActive()).map((row) => [row.interestId, row]));

  let created = 0;
  let renamed = 0;
  for (const interest of interests) {
    const existing = trackedById.get(interest.interestId);
    if (existing === undefined) {
      // `trackedById` only holds active rows (listActive excludes archived_at IS NOT NULL),
      // so an archived interest_id that reappears in Mailchimp's list looks "new" here and
      // gets a second Monday item created for it. That does NOT violate the interest_id
      // primary key — campaignItemsStore.upsert below uses ON CONFLICT (interest_id) DO
      // UPDATE, so the D1 row is simply re-pointed at the new item id. The real outcome is a
      // duplicate Monday item (plus an orphaned, still-archived one left behind), not a PK
      // error. Still out of scope to fix here: Mailchimp doesn't reuse interest ids in
      // practice, so this is a theoretical edge case, not an observed one.
      const itemId = await withRetry(() => mondayClient.createCampaignItem(boardId, interest.name), RECONCILE_RETRY_OPTIONS);
      await campaignItemsStore.upsert({ interestId: interest.interestId, mondayItemId: itemId, name: interest.name, archivedAt: null });
      created++;
    } else if (existing.name !== interest.name) {
      await withRetry(() => mondayClient.renameItem(boardId, existing.mondayItemId, interest.name), RECONCILE_RETRY_OPTIONS);
      await campaignItemsStore.upsert({ interestId: interest.interestId, mondayItemId: existing.mondayItemId, name: interest.name, archivedAt: null });
      renamed++;
    }
    trackedById.delete(interest.interestId);
  }

  let archived = 0;
  for (const stale of trackedById.values()) {
    await withRetry(() => mondayClient.archiveItem(stale.mondayItemId), RECONCILE_RETRY_OPTIONS);
    await campaignItemsStore.markArchived(stale.interestId, new Date().toISOString());
    archived++;
  }

  return { created, renamed, archived };
}
