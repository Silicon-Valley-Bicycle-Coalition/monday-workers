import { describe, it, expect, vi } from 'vitest';
import { processOutboundBatch } from './outbound';
import { MailchimpAuthError, MailchimpPermanentError, MailchimpRateLimitError } from '../mailchimp/client';
import { MondayApiError } from '../monday/client';
import type { MondayClient } from '../monday/client';
import type { MailchimpClient } from '../mailchimp/client';
import type { PendingOutboundStore } from '../db/pendingOutbound';
import type { DnsUnsubscribeLog } from '../db/dnsUnsubscribes';
import type { Config, DonorRecord, OutboundSyncMessage } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: null, campaignsBoardId: null, historical: null, columns: {
    membershipStatus: 's', membershipTier: 't', memberSince: 'ms', memberUntil: 'mu',
    addr1: 'a1', city: 'c', state: 'st', zip: 'z', email: 'e', totalGiven: 'g', mailchimpCampaigns: 'mc',
    doNotSolicit: 'dns', dnsReasonStatus: 'dnsStatus', nearby: null,
  } },
  mailchimp: {
    apiBaseUrl: '', audienceId: '', interestCategoryIds: ['cat1'], nearbyTagPrefix: 'Near: ',
    mergeFields: { memberSince: 'MS', memberUntil: 'MU', membershipTier: 'MT', membershipStatus: 'MST', address: 'AD', totalGiven: 'TG' },
    tags: { activeMember: 'active-member', lapsedMember: 'lapsed-member', lifetimeMember: 'lifetime-member', hasDonated: 'has-donated', doNotSolicit: 'do-not-solicit' },
  },
  lifetimeTierValue: 'Lifetime',
  activeStatusValue: 'Active',
  dnsConfirmedValue: 'Confirmed',
};

function fakeDnsLog(alreadyLogged: string[] = []): DnsUnsubscribeLog {
  return { has: vi.fn(async (email: string) => alreadyLogged.includes(email)), record: vi.fn() };
}

function fakeMessage(donorItemId: string, attempts = 1): { body: OutboundSyncMessage; attempts: number; ack: () => void; retry: () => void } {
  return { body: { donorItemId }, attempts, ack: vi.fn(), retry: vi.fn() };
}

function donor(overrides: Partial<DonorRecord> = {}): DonorRecord {
  return {
    id: '1', email: 'a@b.com', membershipStatus: 'Active', membershipTier: 'Standard',
    memberSince: '2026-01-01', memberUntil: '', addr1: '', city: '', state: '', zip: '', totalGiven: '0',
    doNotSolicit: false, dnsReasonStatus: '', nearby: [], onHistorical: false,
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
      getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG, dnsLog: fakeDnsLog() });

    expect(mailchimpClient.updateMember).toHaveBeenCalledWith(
      'a@b.com',
      expect.any(Object),
      ['active-member'],
      // The full worker-managed set, so the client can deactivate the ones no longer desired.
      ['active-member', 'lapsed-member', 'lifetime-member', 'has-donated', 'do-not-solicit'],
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
      getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG, dnsLog: fakeDnsLog() });

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
    const mailchimpClient: MailchimpClient = { updateMember: vi.fn(), getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn() };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG, dnsLog: fakeDnsLog() });

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
    const mailchimpClient: MailchimpClient = { updateMember: vi.fn(), getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn() };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG, dnsLog: fakeDnsLog() });

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
      getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG, dnsLog: fakeDnsLog() });

    expect(pendingStore.updateStatus).toHaveBeenCalledWith('4', 'failed', 'rate limited');
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
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
      getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG, dnsLog: fakeDnsLog() });

    expect(pendingStore.updateStatus).toHaveBeenCalledWith('5', 'failed', 'invalid email');
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  describe('Nearby tags', () => {
    const NEARBY_CONFIG: Config = { ...CONFIG, monday: { ...CONFIG.monday, columns: { ...CONFIG.monday.columns, nearby: 'nearby' } } };

    function nearbyDeps(d: DonorRecord | null, memberTags: string[], config: Config = NEARBY_CONFIG, updateResult = 'updated') {
      const mondayClient: MondayClient = {
        getDonorById: vi.fn().mockResolvedValue(d),
        createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
        findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
      };
      const mailchimpClient: MailchimpClient = {
        updateMember: vi.fn().mockResolvedValue(updateResult),
        renameMember: vi.fn(), unsubscribeMember: vi.fn(),
        getMemberInterests: vi.fn(), getMemberTagNames: vi.fn().mockResolvedValue(memberTags), listInterests: vi.fn(),
      };
      const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };
      return { mondayClient, mailchimpClient, pendingStore, dnsLog: fakeDnsLog(), config };
    }

    it('deactivates a Near: tag the Monday column no longer holds, and activates the current ones', async () => {
      const d = nearbyDeps(donor({ nearby: ['New'] }), ['Near: Old', 'Near: New', 'VIP']);
      await processOutboundBatch([fakeMessage('1')], d);

      const [, , desired, managed] = (d.mailchimpClient.updateMember as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(desired).toEqual(['active-member', 'Near: New']);
      expect(managed).toContain('Near: Old');
      expect(managed).not.toContain('VIP');
      expect(d.mailchimpClient.getMemberTagNames).toHaveBeenCalledWith('a@b.com');
    });

    it('never reads the member\'s tags when the nearby column is null', async () => {
      const d = nearbyDeps(donor(), ['Near: Old'], CONFIG);
      await processOutboundBatch([fakeMessage('1')], d);

      expect(d.mailchimpClient.getMemberTagNames).not.toHaveBeenCalled();
      expect(d.mailchimpClient.updateMember).toHaveBeenCalled();
    });

    it('does not read tags when the donor has no email', async () => {
      const d = nearbyDeps(donor({ email: '' }), []);
      await processOutboundBatch([fakeMessage('1')], d);
      expect(d.mailchimpClient.getMemberTagNames).not.toHaveBeenCalled();
    });

    it('retries (not acks) when reading the member\'s tags fails transiently', async () => {
      const d = nearbyDeps(donor(), []);
      (d.mailchimpClient.getMemberTagNames as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('mailchimp getMemberTagNames: HTTP 503'));
      const message = fakeMessage('1');
      await processOutboundBatch([message], d);

      expect(d.mailchimpClient.updateMember).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalled();
      expect(message.ack).not.toHaveBeenCalled();
    });
  });

  describe('Do Not Solicit', () => {
    function deps(d: DonorRecord, opts: { updateResult?: string; unsubscribeResult?: string; alreadyLogged?: string[] } = {}) {
      const mondayClient: MondayClient = {
        getDonorById: vi.fn().mockResolvedValue(d),
        createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
        findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
      };
      const mailchimpClient: MailchimpClient = {
        updateMember: vi.fn().mockResolvedValue(opts.updateResult ?? 'updated'),
        renameMember: vi.fn(), unsubscribeMember: vi.fn().mockResolvedValue(opts.unsubscribeResult ?? 'unsubscribed'),
        getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(),
      };
      const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };
      const dnsLog = fakeDnsLog(opts.alreadyLogged);
      return { mondayClient, mailchimpClient, pendingStore, dnsLog, config: CONFIG };
    }

    it('tags but does not unsubscribe while the reason is not yet Confirmed', async () => {
      for (const status of ['', 'Missing', 'OK']) {
        const d = deps(donor({ doNotSolicit: true, dnsReasonStatus: status }));
        await processOutboundBatch([fakeMessage('1')], d);

        expect(d.mailchimpClient.updateMember).toHaveBeenCalledWith('a@b.com', expect.any(Object), expect.arrayContaining(['do-not-solicit']), expect.any(Array));
        expect(d.mailchimpClient.unsubscribeMember).not.toHaveBeenCalled();
      }
    });

    it('unsubscribes the personal email once Do Not Solicit is Confirmed, and logs it', async () => {
      const d = deps(donor({ doNotSolicit: true, dnsReasonStatus: 'Confirmed' }));
      const message = fakeMessage('1');
      await processOutboundBatch([message], d);

      expect(d.mailchimpClient.unsubscribeMember).toHaveBeenCalledWith('a@b.com');
      expect(d.dnsLog.record).toHaveBeenCalledWith('a@b.com', '1', 'unsubscribed', expect.any(String));
      expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('1', 'written', undefined, expect.any(String));
      expect(message.ack).toHaveBeenCalled();
    });

    it('logs an already-unsubscribed or cleaned contact without treating it as an error', async () => {
      const d = deps(donor({ doNotSolicit: true, dnsReasonStatus: 'Confirmed' }), { unsubscribeResult: 'already-unsubscribed' });
      await processOutboundBatch([fakeMessage('1')], d);

      expect(d.dnsLog.record).toHaveBeenCalledWith('a@b.com', '1', 'already-unsubscribed', expect.any(String));
    });

    it('does not call Mailchimp again for an address already in the log', async () => {
      // Every later column change on this person re-runs the consumer; one unsubscribe is enough.
      const d = deps(donor({ doNotSolicit: true, dnsReasonStatus: 'Confirmed' }), { alreadyLogged: ['a@b.com'] });
      await processOutboundBatch([fakeMessage('1')], d);

      expect(d.mailchimpClient.unsubscribeMember).not.toHaveBeenCalled();
      expect(d.dnsLog.record).not.toHaveBeenCalled();
    });

    it('never unsubscribes when the box is unchecked, even if the status still reads Confirmed', async () => {
      const d = deps(donor({ doNotSolicit: false, dnsReasonStatus: 'Confirmed' }));
      await processOutboundBatch([fakeMessage('1')], d);

      expect(d.mailchimpClient.unsubscribeMember).not.toHaveBeenCalled();
      expect(d.mailchimpClient.updateMember).toHaveBeenCalledWith('a@b.com', expect.any(Object), expect.not.arrayContaining(['do-not-solicit']), expect.arrayContaining(['do-not-solicit']));
    });

    it('does nothing more for a confirmed contact who is not in the audience, and leaves the log open for a later join', async () => {
      const d = deps(donor({ doNotSolicit: true, dnsReasonStatus: 'Confirmed' }), { updateResult: 'not-in-audience', unsubscribeResult: 'not-in-audience' });
      await processOutboundBatch([fakeMessage('1')], d);

      expect(d.dnsLog.record).not.toHaveBeenCalled();
      expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('1', 'skipped', expect.any(String));
    });

    it('still unsubscribes a confirmed contact when the merge-field update fails permanently', async () => {
      const d = deps(donor({ doNotSolicit: true, dnsReasonStatus: 'Confirmed' }));
      (d.mailchimpClient.updateMember as ReturnType<typeof vi.fn>).mockRejectedValue(new MailchimpPermanentError('invalid merge field'));
      const message = fakeMessage('1');
      await processOutboundBatch([message], d);

      expect(d.mailchimpClient.unsubscribeMember).toHaveBeenCalledWith('a@b.com');
      expect(d.dnsLog.record).toHaveBeenCalledWith('a@b.com', '1', 'unsubscribed', expect.any(String));
      expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('1', 'failed', expect.any(String));
      expect(message.ack).toHaveBeenCalled();
    });

    it('retries without logging when the unsubscribe fails transiently', async () => {
      const d = deps(donor({ doNotSolicit: true, dnsReasonStatus: 'Confirmed' }));
      (d.mailchimpClient.unsubscribeMember as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('503'));
      const message = fakeMessage('1');
      await processOutboundBatch([message], d);

      expect(d.dnsLog.record).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    });
  });

  describe('Email column changed on Monday', () => {
    function deps(d: DonorRecord, opts: { renameResult?: string | Error; updateResult?: string } = {}) {
      const mondayClient: MondayClient = {
        getDonorById: vi.fn().mockResolvedValue(d),
        createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
        findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
      };
      const rename = opts.renameResult instanceof Error
        ? vi.fn().mockRejectedValue(opts.renameResult)
        : vi.fn().mockResolvedValue(opts.renameResult ?? 'renamed');
      const mailchimpClient: MailchimpClient = {
        updateMember: vi.fn().mockResolvedValue(opts.updateResult ?? 'updated'),
        renameMember: rename,
        unsubscribeMember: vi.fn().mockResolvedValue('unsubscribed'),
        getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(),
      };
      const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };
      return { mondayClient, mailchimpClient, pendingStore, dnsLog: fakeDnsLog(), config: CONFIG };
    }
    const changed = (previousEmail: string) => ({ body: { donorItemId: '1', previousEmail }, attempts: 1, ack: vi.fn(), retry: vi.fn() });

    it('renames the old member to the new address, then updates it', async () => {
      const d = deps(donor({ email: 'new@b.com' }));
      const message = changed('old@b.com');
      await processOutboundBatch([message], d);

      expect(d.mailchimpClient.renameMember).toHaveBeenCalledWith('old@b.com', 'new@b.com');
      expect(d.mailchimpClient.updateMember).toHaveBeenCalledWith('new@b.com', expect.any(Object), expect.any(Array), expect.any(Array));
      expect(vi.mocked(d.mailchimpClient.renameMember).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(d.mailchimpClient.updateMember).mock.invocationCallOrder[0]!);
      expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('1', 'written', undefined, expect.any(String));
      expect(message.ack).toHaveBeenCalled();
    });

    it('renames before a confirmed Do Not Solicit, so the unsubscribe lands on the renamed member', async () => {
      const d = deps(donor({ email: 'new@b.com', doNotSolicit: true, dnsReasonStatus: 'Confirmed' }));
      await processOutboundBatch([changed('old@b.com')], d);

      expect(vi.mocked(d.mailchimpClient.renameMember).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(d.mailchimpClient.unsubscribeMember).mock.invocationCallOrder[0]!);
      expect(d.mailchimpClient.unsubscribeMember).toHaveBeenCalledWith('new@b.com');
    });

    it('does not rename without a previous address (any other column change)', async () => {
      const d = deps(donor({ email: 'new@b.com' }));
      await processOutboundBatch([fakeMessage('1')], d);
      expect(d.mailchimpClient.renameMember).not.toHaveBeenCalled();
    });

    it('does not rename when only the case or spacing changed', async () => {
      const d = deps(donor({ email: 'a@b.com' }));
      await processOutboundBatch([changed(' A@B.com')], d);
      expect(d.mailchimpClient.renameMember).not.toHaveBeenCalled();
    });

    it('does not rename when the address was cleared, and calls Mailchimp for nothing', async () => {
      const d = deps(donor({ email: '' }));
      await processOutboundBatch([changed('old@b.com')], d);
      expect(d.mailchimpClient.renameMember).not.toHaveBeenCalled();
      expect(d.mailchimpClient.updateMember).not.toHaveBeenCalled();
    });

    it('still updates the new address when Mailchimp refuses the rename permanently', async () => {
      const d = deps(donor({ email: 'new@b.com' }), { renameResult: new MailchimpPermanentError('mailchimp renameMember: HTTP 400') });
      const message = changed('old@b.com');
      await processOutboundBatch([message], d);

      expect(d.mailchimpClient.updateMember).toHaveBeenCalledWith('new@b.com', expect.any(Object), expect.any(Array), expect.any(Array));
      expect(message.ack).toHaveBeenCalled();
    });

    it('retries the whole message when the rename fails transiently', async () => {
      const d = deps(donor({ email: 'new@b.com' }), { renameResult: new Error('network') });
      const message = changed('old@b.com');
      await processOutboundBatch([message], d);

      expect(d.mailchimpClient.updateMember).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalled();
      expect(message.ack).not.toHaveBeenCalled();
    });
  });

  describe('retry backoff (#35)', () => {
    function depsFailingWith(err: Error, pendingStore?: PendingOutboundStore) {
      const mondayClient: MondayClient = {
        getDonorById: vi.fn().mockResolvedValue(donor()),
        createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
        findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
      };
      const mailchimpClient: MailchimpClient = {
        updateMember: vi.fn().mockRejectedValue(err),
        getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(),
      };
      return {
        mondayClient, mailchimpClient, config: CONFIG, dnsLog: fakeDnsLog(),
        pendingStore: pendingStore ?? { upsertPending: vi.fn(), updateStatus: vi.fn() },
      };
    }

    it('backs off exponentially by delivery attempt', async () => {
      for (const [attempts, delaySeconds] of [[1, 60], [2, 120], [3, 240]] as const) {
        const message = fakeMessage('6', attempts);
        await processOutboundBatch([message], depsFailingWith(new Error('503')));
        expect(message.retry).toHaveBeenCalledWith({ delaySeconds });
      }
    });

    it('waits at least a Mailchimp Retry-After on a 429', async () => {
      const message = fakeMessage('6', 1);
      await processOutboundBatch([message], depsFailingWith(new MailchimpRateLimitError('429', 600)));
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 600 });
    });

    it("waits at least Monday's retry_in_seconds", async () => {
      const message = fakeMessage('6', 1);
      const d = depsFailingWith(new Error('unused'));
      (d.mondayClient.getDonorById as ReturnType<typeof vi.fn>).mockRejectedValue(
        new MondayApiError('monday: HTTP 429', { httpStatus: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: 75 }),
      );
      await processOutboundBatch([message], d);
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 75 });
    });

    it('still retries with backoff when recording the failure in D1 throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn().mockRejectedValue(new Error('D1 unavailable')) };
      const message = fakeMessage('6', 2);
      await processOutboundBatch([message], depsFailingWith(new Error('503'), pendingStore));
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
      expect(message.ack).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('could not record failure'));
      errorSpy.mockRestore();
    });

    it('retries (never acks) when Mailchimp rejects the API key, and says so in the log', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (const status of [401, 403]) {
        const message = fakeMessage('6', 2);
        await processOutboundBatch([message], depsFailingWith(new MailchimpAuthError(`mailchimp updateMember: HTTP ${status}`)));
        expect(message.ack).not.toHaveBeenCalled();
        expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
      }
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MAILCHIMP CREDENTIALS REJECTED'));
      errorSpy.mockRestore();
    });

    it('still acks a permanent failure when recording it in D1 throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn().mockRejectedValue(new Error('D1 unavailable')) };
      const message = fakeMessage('6', 1);
      await processOutboundBatch([message], depsFailingWith(new MailchimpPermanentError('invalid email'), pendingStore));
      expect(message.ack).toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});

describe('processOutboundBatch: People (Historical) items', () => {
  const HISTORICAL_COLUMNS = {
    membershipStatus: 'h-s', membershipTier: 'h-t', memberSince: 'h-ms', memberUntil: 'h-mu', addr1: 'h-a1', city: 'h-c',
    state: null, zip: 'h-z', email: 'h-e', totalGiven: 'h-g', doNotSolicit: 'h-dns', dnsReasonStatus: 'h-dnsStatus', nearby: null,
  };
  const config: Config = { ...CONFIG, monday: { ...CONFIG.monday, donorsBoardId: 111, historical: { boardId: 222, columns: HISTORICAL_COLUMNS } } };

  function setup(record: DonorRecord, peopleHolds: string[] = []) {
    const mondayClient: MondayClient = {
      getDonorById: vi.fn().mockResolvedValue(record),
      findItemIdByEmail: vi.fn(async (_board: number, _column: string, email: string) => (peopleHolds.includes(email) ? '900' : null)),
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(), setConnectColumn: vi.fn(),
    };
    const mailchimpClient: MailchimpClient = {
      updateMember: vi.fn().mockResolvedValue('updated'),
      renameMember: vi.fn().mockResolvedValue('renamed'),
      unsubscribeMember: vi.fn().mockResolvedValue('unsubscribed'),
      getMemberTagNames: vi.fn().mockResolvedValue(['Near: Old project']),
      getMemberInterests: vi.fn(), listInterests: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };
    return { mondayClient, mailchimpClient, pendingStore, config, dnsLog: fakeDnsLog() };
  }

  it('updates the contact of a Historical item no People item shares', async () => {
    const message = fakeMessage('1');
    const deps = setup(donor({ onHistorical: true }));
    await processOutboundBatch([message], deps);
    expect(deps.mondayClient.getDonorById).toHaveBeenCalledWith('1', config.monday.columns, config.monday.historical);
    expect(deps.mondayClient.findItemIdByEmail).toHaveBeenCalledWith(111, 'e', 'a@b.com');
    expect(deps.mailchimpClient.updateMember).toHaveBeenCalledTimes(1);
    expect(deps.pendingStore.updateStatus).toHaveBeenCalledWith('1', 'written', undefined, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
  });

  it('leaves the contact alone when a People item holds the same address, so a lapsed record cannot overwrite a live one', async () => {
    const message = fakeMessage('1');
    const deps = setup(donor({ onHistorical: true, membershipStatus: 'Lapsed' }), ['a@b.com']);
    await processOutboundBatch([message], deps);
    expect(deps.mailchimpClient.updateMember).not.toHaveBeenCalled();
    expect(deps.pendingStore.updateStatus).toHaveBeenCalledWith('1', 'skipped', expect.stringContaining('People'));
    expect(message.ack).toHaveBeenCalled();
  });

  it('still honors a reviewed Do Not Solicit when People holds the same address', async () => {
    const deps = setup(donor({ onHistorical: true, doNotSolicit: true, dnsReasonStatus: 'Confirmed' }), ['a@b.com']);
    await processOutboundBatch([fakeMessage('1')], deps);
    expect(deps.mailchimpClient.unsubscribeMember).toHaveBeenCalledWith('a@b.com');
    expect(deps.mailchimpClient.updateMember).not.toHaveBeenCalled();
  });

  it('does not move a contact a People item still holds when a Historical item changes address', async () => {
    const message = { ...fakeMessage('1'), body: { donorItemId: '1', previousEmail: 'old@b.com' } };
    const deps = setup(donor({ onHistorical: true }), ['old@b.com']);
    await processOutboundBatch([message], deps);
    expect(deps.mailchimpClient.renameMember).not.toHaveBeenCalled();
    expect(deps.mailchimpClient.updateMember).toHaveBeenCalledTimes(1);
  });

  it('moves the contact when a Historical item changes an address only it held', async () => {
    const message = { ...fakeMessage('1'), body: { donorItemId: '1', previousEmail: 'old@b.com' } };
    const deps = setup(donor({ onHistorical: true }));
    await processOutboundBatch([message], deps);
    expect(deps.mailchimpClient.renameMember).toHaveBeenCalledWith('old@b.com', 'a@b.com');
  });

  it('never looks a People item up on People, whatever it holds', async () => {
    const deps = setup(donor({ onHistorical: false }), ['a@b.com']);
    await processOutboundBatch([fakeMessage('1')], deps);
    expect(deps.mondayClient.findItemIdByEmail).not.toHaveBeenCalled();
    expect(deps.mailchimpClient.updateMember).toHaveBeenCalledTimes(1);
  });

  it('keeps Near: tags when the item\'s own board has no Nearby column yet, though People does', async () => {
    const withPeopleNearby: Config = { ...config, monday: { ...config.monday, columns: { ...config.monday.columns, nearby: 'n' } } };
    const deps = { ...setup(donor({ onHistorical: true })), config: withPeopleNearby };
    await processOutboundBatch([fakeMessage('1')], deps);
    expect(deps.mailchimpClient.getMemberTagNames).not.toHaveBeenCalled();
    const managed = (deps.mailchimpClient.updateMember as ReturnType<typeof vi.fn>).mock.calls[0]![3] as string[];
    expect(managed).not.toContain('Near: Old project');
  });

  it('reads Near: tags when the Historical board has its own Nearby column', async () => {
    const withBothNearby: Config = { ...config, monday: { ...config.monday, historical: { boardId: 222, columns: { ...HISTORICAL_COLUMNS, nearby: 'h-n' } } } };
    const deps = { ...setup(donor({ onHistorical: true })), config: withBothNearby };
    await processOutboundBatch([fakeMessage('1')], deps);
    const managed = (deps.mailchimpClient.updateMember as ReturnType<typeof vi.fn>).mock.calls[0]![3] as string[];
    expect(managed).toContain('Near: Old project');
  });
});
