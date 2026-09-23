import { describe, it, expect, vi } from 'vitest';
import { processOutboundBatch } from './outbound';
import { MailchimpPermanentError } from '../mailchimp/client';
import type { MondayClient } from '../monday/client';
import type { MailchimpClient } from '../mailchimp/client';
import type { PendingOutboundStore } from '../db/pendingOutbound';
import type { Config, DonorRecord, OutboundSyncMessage } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: null, campaignsBoardId: null, columns: {
    membershipStatus: 's', membershipTier: 't', memberSince: 'ms', memberUntil: 'mu',
    addr1: 'a1', city: 'c', state: 'st', zip: 'z', email: 'e', totalGiven: 'g', mailchimpCampaigns: 'mc',
  } },
  mailchimp: {
    apiBaseUrl: '', audienceId: '',
    mergeFields: { memberSince: 'MS', memberUntil: 'MU', membershipTier: 'MT', membershipStatus: 'MST', address: 'AD', totalGiven: 'TG' },
    tags: { activeMember: 'active-member', lapsedMember: 'lapsed-member', lifetimeMember: 'lifetime-member', hasDonated: 'has-donated' },
  },
  lifetimeTierValue: 'Lifetime',
  activeStatusValue: 'Active',
};

function fakeMessage(donorItemId: string): { body: OutboundSyncMessage; ack: () => void; retry: () => void } {
  return { body: { donorItemId }, ack: vi.fn(), retry: vi.fn() };
}

function donor(overrides: Partial<DonorRecord> = {}): DonorRecord {
  return {
    id: '1', email: 'a@b.com', membershipStatus: 'Active', membershipTier: 'Standard',
    memberSince: '2026-01-01', memberUntil: '', addr1: '', city: '', state: '', zip: '', totalGiven: '0',
    ...overrides,
  };
}

describe('processOutboundBatch', () => {
  it('updates the donor in Mailchimp and acks on success', async () => {
    const message = fakeMessage('1');
    const mondayClient: MondayClient = {
      getDonorById: vi.fn().mockResolvedValue(donor()),
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const mailchimpClient: MailchimpClient = {
      updateMember: vi.fn().mockResolvedValue('updated'),
      getMemberInterests: vi.fn(), listInterests: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG });

    expect(mailchimpClient.updateMember).toHaveBeenCalledWith(
      'a@b.com',
      expect.any(Object),
      ['active-member'],
      // The full worker-managed set, so the client can deactivate the ones no longer desired.
      ['active-member', 'lapsed-member', 'lifetime-member', 'has-donated'],
    );
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('1', 'written', undefined, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
  });

  it('records skipped (not written) and acks when the donor is not in the Mailchimp audience', async () => {
    // No consent recorded in Mailchimp → the donor is never added (issue #28). A column
    // change on such a donor (e.g. donation-rollups bumping Total Given) is a no-op.
    const message = fakeMessage('4');
    const mondayClient: MondayClient = {
      getDonorById: vi.fn().mockResolvedValue(donor({ email: 'noconsent@example.com' })),
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const mailchimpClient: MailchimpClient = {
      updateMember: vi.fn().mockResolvedValue('not-in-audience'),
      getMemberInterests: vi.fn(), listInterests: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG });

    expect(pendingStore.updateStatus).toHaveBeenCalledWith('4', 'skipped', expect.stringContaining('not in the Mailchimp audience'));
    expect(pendingStore.updateStatus).not.toHaveBeenCalledWith('4', 'written', expect.anything(), expect.anything());
    expect(message.ack).toHaveBeenCalled();
  });

  it('skips and acks (does not call Mailchimp) when the donor has no email', async () => {
    const message = fakeMessage('2');
    const mondayClient: MondayClient = {
      getDonorById: vi.fn().mockResolvedValue(donor({ email: '' })),
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const mailchimpClient: MailchimpClient = { updateMember: vi.fn(), getMemberInterests: vi.fn(), listInterests: vi.fn() };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG });

    expect(mailchimpClient.updateMember).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('2', 'written', undefined, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
  });

  it('skips and acks when the donor item no longer exists', async () => {
    const message = fakeMessage('3');
    const mondayClient: MondayClient = {
      getDonorById: vi.fn().mockResolvedValue(null),
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const mailchimpClient: MailchimpClient = { updateMember: vi.fn(), getMemberInterests: vi.fn(), listInterests: vi.fn() };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG });

    expect(message.ack).toHaveBeenCalled();
  });

  it('retries (does not ack) on a transient Mailchimp failure', async () => {
    const message = fakeMessage('4');
    const mondayClient: MondayClient = {
      getDonorById: vi.fn().mockResolvedValue(donor()),
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const mailchimpClient: MailchimpClient = {
      updateMember: vi.fn().mockRejectedValue(new Error('rate limited')),
      getMemberInterests: vi.fn(), listInterests: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG });

    expect(pendingStore.updateStatus).toHaveBeenCalledWith('4', 'failed', 'rate limited');
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('acks (does not retry) on a permanent Mailchimp failure', async () => {
    const message = fakeMessage('5');
    const mondayClient: MondayClient = {
      getDonorById: vi.fn().mockResolvedValue(donor()),
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const mailchimpClient: MailchimpClient = {
      updateMember: vi.fn().mockRejectedValue(new MailchimpPermanentError('invalid email')),
      getMemberInterests: vi.fn(), listInterests: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG });

    expect(pendingStore.updateStatus).toHaveBeenCalledWith('5', 'failed', 'invalid email');
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
