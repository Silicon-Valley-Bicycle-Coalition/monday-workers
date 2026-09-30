import type { MailchimpClient } from '../mailchimp/client';
import type { MondayClient } from '../monday/client';
import type { CampaignItemsStore } from '../db/campaignItems';
import type { Config } from '../types';
import { withRetry } from '../retry';

// This daily cron has no Queue safety net underneath it (unlike the outbound/inbound
// consumers), so a transient Mailchimp hiccup here would otherwise abort the whole day's
// reconciliation with nothing to retry it until tomorrow. Small, fixed values — this isn't
// latency-sensitive, it's a once-a-day batch job. Monday calls are not wrapped: the Monday
// transport retries them itself (#35), and wrapping its create would retry a create that may
// already have committed (AmbiguousWriteError) into a duplicate campaign item.
const RECONCILE_RETRY_OPTIONS = { attempts: 3, delayMs: 500 };

// How long a create claim holds before another run may assume its claimant died between
// claiming and recording the new item id. Far longer than one create's retries take.
const CLAIM_STALE_MS = 10 * 60 * 1000;

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
      // Untracked (or archived and back again). The cron and every inbound consumer that
      // meets an unknown interest run this concurrently, so claim it in D1 first — only
      // the winner creates the Monday item; losers leave it to them (issue #28).
      const now = new Date();
      const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
      if (!(await campaignItemsStore.claim(interest.interestId, interest.name, now.toISOString(), staleBefore))) continue;
      const itemId = await mondayClient.createCampaignItem(boardId, interest.name);
      await campaignItemsStore.upsert({ interestId: interest.interestId, mondayItemId: itemId, name: interest.name, archivedAt: null });
      created++;
    } else if (existing.name !== interest.name) {
      await mondayClient.renameItem(boardId, existing.mondayItemId, interest.name);
      await campaignItemsStore.upsert({ interestId: interest.interestId, mondayItemId: existing.mondayItemId, name: interest.name, archivedAt: null });
      renamed++;
    }
    trackedById.delete(interest.interestId);
  }

  let archived = 0;
  for (const stale of trackedById.values()) {
    await mondayClient.archiveItem(stale.mondayItemId);
    await campaignItemsStore.markArchived(stale.interestId, new Date().toISOString());
    archived++;
  }

  return { created, renamed, archived };
}
