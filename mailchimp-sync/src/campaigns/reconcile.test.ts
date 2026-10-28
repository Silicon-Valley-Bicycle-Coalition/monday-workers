import { describe, it, expect, vi } from 'vitest';
import { reconcileCampaigns } from './reconcile';
import type { MailchimpClient } from '../mailchimp/client';
import { AmbiguousWriteError, type MondayClient } from '../monday/client';
import type { CampaignItemsStore } from '../db/campaignItems';
import type { Config } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: null, campaignsBoardId: 999, columns: {} as never },
  mailchimp: { apiBaseUrl: '', audienceId: '', mergeFields: {} as never, tags: {} as never, interestCategoryIds: ['cat1'] },
  lifetimeTierValue: 'Lifetime', activeStatusValue: 'Active', dnsConfirmedValue: 'Confirmed',
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
      updateMember: vi.fn(), getMemberInterests: vi.fn(), unsubscribeMember: vi.fn(),
    };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn().mockResolvedValue('item1'),
      renameItem: vi.fn(), archiveItem: vi.fn(), getDonorById: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore();

    const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG });

    expect(mailchimpClient.listInterests).toHaveBeenCalledWith(['cat1']);
    expect(mondayClient.createCampaignItem).toHaveBeenCalledWith(999, 'Newsletter');
    expect(campaignItemsStore.upsert).toHaveBeenCalledWith({ interestId: 'int1', mondayItemId: 'item1', name: 'Newsletter', archivedAt: null });
    expect(result).toEqual({ created: 1, renamed: 0, archived: 0, interestIds: ['int1'] });
  });

  it('does not create an item when another concurrent run already claimed the interest', async () => {
    const mailchimpClient: MailchimpClient = {
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'Newsletter' }]),
      updateMember: vi.fn(), getMemberInterests: vi.fn(), unsubscribeMember: vi.fn(),
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
    expect(result).toEqual({ created: 0, renamed: 0, archived: 0, interestIds: ['int1'] });
  });

  it('renames the Monday item when a tracked interest is renamed in Mailchimp', async () => {
    const mailchimpClient: MailchimpClient = {
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'New Name' }]),
      updateMember: vi.fn(), getMemberInterests: vi.fn(), unsubscribeMember: vi.fn(),
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
    expect(result).toEqual({ created: 0, renamed: 1, archived: 0, interestIds: ['int1'] });
  });

  it('archives a tracked Monday item whose interest no longer exists in Mailchimp', async () => {
    const mailchimpClient: MailchimpClient = { listInterests: vi.fn().mockResolvedValue([]), updateMember: vi.fn(), getMemberInterests: vi.fn(), unsubscribeMember: vi.fn() };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn().mockResolvedValue(undefined),
      getDonorById: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore([{ interestId: 'int1', mondayItemId: 'item1', name: 'Gone', archivedAt: null }]);

    const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG });

    expect(mondayClient.archiveItem).toHaveBeenCalledWith('item1');
    expect(campaignItemsStore.markArchived).toHaveBeenCalledWith('int1', expect.any(String));
    expect(result).toEqual({ created: 0, renamed: 0, archived: 1, interestIds: [] });
  });

  it('leaves an unchanged, still-present interest alone', async () => {
    const mailchimpClient: MailchimpClient = {
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'Same' }]),
      updateMember: vi.fn(), getMemberInterests: vi.fn(), unsubscribeMember: vi.fn(),
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
    expect(result).toEqual({ created: 0, renamed: 0, archived: 0, interestIds: ['int1'] });
  });

  it('never re-runs a Monday create that may have committed — the transport owns Monday retries (#35)', async () => {
    const mailchimpClient: MailchimpClient = {
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'Newsletter' }]),
      updateMember: vi.fn(), getMemberInterests: vi.fn(), unsubscribeMember: vi.fn(),
    };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn().mockRejectedValueOnce(new AmbiguousWriteError('monday API: HTTP 502 (the write may have committed)')).mockResolvedValue('dup'),
      renameItem: vi.fn(), archiveItem: vi.fn(), getDonorById: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const campaignItemsStore = fakeCampaignItemsStore();

    await expect(reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config: CONFIG })).rejects.toBeInstanceOf(AmbiguousWriteError);
    expect(mondayClient.createCampaignItem).toHaveBeenCalledTimes(1);
    expect(campaignItemsStore.upsert).not.toHaveBeenCalled();
  });

  it('throws if campaignsBoardId is not configured', async () => {
    const config: Config = { ...CONFIG, monday: { ...CONFIG.monday, campaignsBoardId: null } };
    const mailchimpClient: MailchimpClient = { listInterests: vi.fn(), updateMember: vi.fn(), getMemberInterests: vi.fn(), unsubscribeMember: vi.fn() };
    const mondayClient: MondayClient = {
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      getDonorById: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    await expect(reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore: fakeCampaignItemsStore(), config }))
      .rejects.toThrow('monday.campaignsBoardId must be set');
  });
});
