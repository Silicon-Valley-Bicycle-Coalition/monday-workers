import { describe, it, expect, vi } from 'vitest';
import { reconcileCampaigns } from './reconcile';
import type { MailchimpClient } from '../mailchimp/client';
import type { MondayClient } from '../monday/client';
import type { CampaignItemsStore } from '../db/campaignItems';
import type { Config } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: null, campaignsBoardId: 999, columns: {} as never },
  mailchimp: { apiBaseUrl: '', audienceId: '', mergeFields: {} as never, tags: {} as never },
  lifetimeTierValue: 'Lifetime', activeStatusValue: 'Active',
};

function fakeCampaignItemsStore(rows: { interestId: string; mondayItemId: string; name: string; archivedAt: string | null }[] = [], claimWins = true): CampaignItemsStore {
  return {
    claim: vi.fn().mockResolvedValue(claimWins),
    listActive: vi.fn().mockResolvedValue(rows.filter((r) => r.archivedAt === null)),
    upsert: vi.fn().mockResolvedValue(undefined),
    markArchived: vi.fn().mockResolvedValue(undefined),
    getByInterestId: vi.fn().mockImplementation(async (id: string) => rows.find((r) => r.interestId === id) ?? null),
  };
}

describe('reconcileCampaigns', () => {
  it('creates a Monday item for a new Mailchimp interest', async () => {
    const mailchimpClient: MailchimpClient = {
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'Newsletter' }]),
      updateMember: vi.fn(), getMemberInterests: vi.fn(),
    };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn().mockResolvedValue('item1'),
      renameItem: vi.fn(), archiveItem: vi.fn(), getDonorById: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore();

    const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG });

    expect(mondayClient.createCampaignItem).toHaveBeenCalledWith(999, 'Newsletter');
    expect(campaignItemsStore.upsert).toHaveBeenCalledWith({ interestId: 'int1', mondayItemId: 'item1', name: 'Newsletter', archivedAt: null });
    expect(result).toEqual({ created: 1, renamed: 0, archived: 0 });
  });

  it('does not create an item when another concurrent run already claimed the interest', async () => {
    const mailchimpClient: MailchimpClient = {
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'Newsletter' }]),
      updateMember: vi.fn(), getMemberInterests: vi.fn(),
    };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn().mockResolvedValue('item1'),
      renameItem: vi.fn(), archiveItem: vi.fn(), getDonorById: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore([], false);

    const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG });

    expect(campaignItemsStore.claim).toHaveBeenCalledWith('int1', 'Newsletter', expect.any(String), expect.any(String));
    expect(mondayClient.createCampaignItem).not.toHaveBeenCalled();
    expect(campaignItemsStore.upsert).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, renamed: 0, archived: 0 });
  });

  it('renames the Monday item when a tracked interest is renamed in Mailchimp', async () => {
    const mailchimpClient: MailchimpClient = {
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'New Name' }]),
      updateMember: vi.fn(), getMemberInterests: vi.fn(),
    };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn(), renameItem: vi.fn().mockResolvedValue(undefined),
      archiveItem: vi.fn(), getDonorById: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore([{ interestId: 'int1', mondayItemId: 'item1', name: 'Old Name', archivedAt: null }]);

    const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG });

    expect(mondayClient.renameItem).toHaveBeenCalledWith(999, 'item1', 'New Name');
    expect(mondayClient.createCampaignItem).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, renamed: 1, archived: 0 });
  });

  it('archives a tracked Monday item whose interest no longer exists in Mailchimp', async () => {
    const mailchimpClient: MailchimpClient = { listInterests: vi.fn().mockResolvedValue([]), updateMember: vi.fn(), getMemberInterests: vi.fn() };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn().mockResolvedValue(undefined),
      getDonorById: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore([{ interestId: 'int1', mondayItemId: 'item1', name: 'Gone', archivedAt: null }]);

    const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG });

    expect(mondayClient.archiveItem).toHaveBeenCalledWith('item1');
    expect(campaignItemsStore.markArchived).toHaveBeenCalledWith('int1', expect.any(String));
    expect(result).toEqual({ created: 0, renamed: 0, archived: 1 });
  });

  it('leaves an unchanged, still-present interest alone', async () => {
    const mailchimpClient: MailchimpClient = {
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'Same' }]),
      updateMember: vi.fn(), getMemberInterests: vi.fn(),
    };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      getDonorById: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore([{ interestId: 'int1', mondayItemId: 'item1', name: 'Same', archivedAt: null }]);

    const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG });

    expect(mondayClient.createCampaignItem).not.toHaveBeenCalled();
    expect(mondayClient.renameItem).not.toHaveBeenCalled();
    expect(mondayClient.archiveItem).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, renamed: 0, archived: 0 });
  });

  it('retries a transient Monday failure and still creates the item on the next attempt', async () => {
    // withRetry uses a real setTimeout backoff (see retry.ts) — stub it to fire
    // immediately so this test doesn't actually wait, same approach as retry.test.ts.
    const originalSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((cb: () => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof originalSetTimeout>;
    }) as typeof setTimeout);

    const mailchimpClient: MailchimpClient = {
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'Newsletter' }]),
      updateMember: vi.fn(), getMemberInterests: vi.fn(),
    };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue('item1'),
      renameItem: vi.fn(), archiveItem: vi.fn(), getDonorById: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore();

    try {
      const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG });

      expect(mondayClient.createCampaignItem).toHaveBeenCalledTimes(2);
      expect(campaignItemsStore.upsert).toHaveBeenCalledWith({ interestId: 'int1', mondayItemId: 'item1', name: 'Newsletter', archivedAt: null });
      expect(result).toEqual({ created: 1, renamed: 0, archived: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws if campaignsBoardId is not configured', async () => {
    const config: Config = { ...CONFIG, monday: { ...CONFIG.monday, campaignsBoardId: null } };
    const mailchimpClient: MailchimpClient = { listInterests: vi.fn(), updateMember: vi.fn(), getMemberInterests: vi.fn() };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      getDonorById: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    await expect(reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore: fakeCampaignItemsStore(), config }))
      .rejects.toThrow('monday.campaignsBoardId must be set');
  });
});
