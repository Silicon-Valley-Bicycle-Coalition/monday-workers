import type { MailchimpClient } from '../mailchimp/client';
import type { MondayClient } from '../monday/client';
import type { CampaignItemsStore } from '../db/campaignItems';
import type { Config } from '../types';

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

  const interests = await mailchimpClient.listInterests();
  const trackedById = new Map((await campaignItemsStore.listActive()).map((row) => [row.interestId, row]));

  let created = 0;
  let renamed = 0;
  for (const interest of interests) {
    const existing = trackedById.get(interest.interestId);
    if (existing === undefined) {
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
