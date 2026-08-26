import { describe, it, expect, vi } from 'vitest';
import { processInboundBatch } from './inbound';
import type { MondayClient } from '../monday/client';
import type { MailchimpClient } from '../mailchimp/client';
import type { CampaignItemsStore, CampaignItemRow } from '../db/campaignItems';
import type { PendingInboundStore } from '../db/pendingInbound';
import type { Config, InboundSyncMessage } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: 111, campaignsBoardId: 999, columns: {
    membershipStatus: 's', membershipTier: 't', memberSince: 'ms', memberUntil: 'mu',
    addr1: 'a1', city: 'c', state: 'st', zip: 'z', email: 'e', totalGiven: 'g', mailchimpCampaigns: 'mc',
  } },
  mailchimp: { apiBaseUrl: '', audienceId: '', mergeFields: {} as never, tags: {} as never },
  lifetimeTierValue: 'Lifetime', activeStatusValue: 'Active',
};

function fakeMessage(email: string): { body: InboundSyncMessage; ack: () => void; retry: () => void } {
  return { body: { email }, ack: vi.fn(), retry: vi.fn() };
}

function fakeMonday(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    getDonorById: vi.fn(), createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
    findItemIdByEmail: vi.fn().mockResolvedValue('donor-1'),
    setConnectColumn: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeMailchimp(overrides: Partial<MailchimpClient> = {}): MailchimpClient {
  return {
    upsertMember: vi.fn(),
    getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: { int1: true, int2: false } }),
    listInterests: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function fakeCampaignItemsStore(rows: CampaignItemRow[] = []): CampaignItemsStore {
  return {
    listActive: vi.fn().mockResolvedValue(rows),
    upsert: vi.fn().mockResolvedValue(undefined),
    markArchived: vi.fn().mockResolvedValue(undefined),
    getByInterestId: vi.fn().mockImplementation(async (id: string) => rows.find((r) => r.interestId === id) ?? null),
  };
}

describe('processInboundBatch', () => {
  it('writes only the subscribed interests\' Monday item ids to the connect column', async () => {
    const message = fakeMessage('a@b.com');
    const mondayClient = fakeMonday();
    const campaignItemsStore = fakeCampaignItemsStore([
      { interestId: 'int1', mondayItemId: 'campaign-1', name: 'Newsletter', archivedAt: null },
      { interestId: 'int2', mondayItemId: 'campaign-2', name: 'Welcome Drip', archivedAt: null },
    ]);
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], {
      mondayClient, mailchimpClient: fakeMailchimp(), campaignItemsStore, pendingStore, config: CONFIG,
    });

    // int1 is subscribed (true), int2 is not (false) — only campaign-1 gets written.
    expect(mondayClient.setConnectColumn).toHaveBeenCalledWith(111, 'donor-1', 'mc', ['campaign-1']);
    expect(message.ack).toHaveBeenCalled();
  });

  it('skips and acks when the contact no longer exists in Mailchimp', async () => {
    const message = fakeMessage('gone@b.com');
    const mondayClient = fakeMonday();
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], {
      mondayClient, mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockResolvedValue(null) }),
      campaignItemsStore: fakeCampaignItemsStore(), pendingStore, config: CONFIG,
    });

    expect(mondayClient.setConnectColumn).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it('skips and acks when no Donor item matches the email', async () => {
    const message = fakeMessage('a@b.com');
    const mondayClient = fakeMonday({ findItemIdByEmail: vi.fn().mockResolvedValue(null) });
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], {
      mondayClient, mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: {} }) }),
      campaignItemsStore: fakeCampaignItemsStore(), pendingStore, config: CONFIG,
    });

    expect(mondayClient.setConnectColumn).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it('triggers a one-time reconciliation refresh on an unresolvable interest id, then retries the lookup', async () => {
    const message = fakeMessage('a@b.com');
    const mondayClient = fakeMonday({ createCampaignItem: vi.fn().mockResolvedValue('campaign-new') });
    const mailchimpClient = fakeMailchimp({
      getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: { 'brand-new-int': true } }),
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'brand-new-int', name: 'Brand New' }]),
    });
    // Starts untracked; reconcileCampaigns (invoked internally) should create+track it.
    const rows: CampaignItemRow[] = [];
    const campaignItemsStore: CampaignItemsStore = {
      listActive: vi.fn().mockImplementation(async () => rows),
      upsert: vi.fn().mockImplementation(async (row: CampaignItemRow) => { rows.push(row); }),
      markArchived: vi.fn(),
      getByInterestId: vi.fn().mockImplementation(async (id: string) => rows.find((r) => r.interestId === id) ?? null),
    };
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], { mondayClient, mailchimpClient, campaignItemsStore, pendingStore, config: CONFIG });

    expect(mondayClient.createCampaignItem).toHaveBeenCalledWith(999, 'Brand New');
    expect(mondayClient.setConnectColumn).toHaveBeenCalledWith(111, 'donor-1', 'mc', ['campaign-new']);
  });

  it('retries (does not ack) when Monday lookup throws', async () => {
    const message = fakeMessage('a@b.com');
    const mondayClient = fakeMonday({ findItemIdByEmail: vi.fn().mockRejectedValue(new Error('monday down')) });
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], {
      mondayClient, mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: {} }) }),
      campaignItemsStore: fakeCampaignItemsStore(), pendingStore, config: CONFIG,
    });

    expect(pendingStore.updateStatus).toHaveBeenCalledWith('a@b.com', 'failed', 'monday down');
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });
});
