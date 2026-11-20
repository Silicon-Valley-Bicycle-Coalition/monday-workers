import { describe, it, expect, vi } from 'vitest';
import { consumeOutboundBatch, processOutboundBatch } from './outbound';
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
    apiBaseUrl: '', audienceId: '', interestCategoryIds: ['cat1'], journeyInterests: null, renewalDue: null, nearbyTagPrefix: 'Near: ',
    mergeFields: { memberSince: 'MS', memberUntil: 'MU', membershipTier: 'MT', membershipStatus: 'MST', address: 'AD', totalGiven: 'TG' },
    tags: { activeMember: 'active-member', lapsedMember: 'lapsed-member', lifetimeMember: 'lifetime-member', hasDonated: 'has-donated', doNotSolicit: 'do-not-solicit', recurringDonor: 'recurring-donor' },
  },
  lifetimeTierValue: 'Lifetime',
  activeStatusValue: 'Active',
  dnsConfirmedValue: 'Confirmed',
  consent: { enabled: false, maxChangesPerRun: 500, boards: [] },
  journeyLog: null,
  profileLinks: null,
  stewardship: null,
  employerAnswers: null,
};

function fakeDnsLog(alreadyLogged: string[] = []): DnsUnsubscribeLog {
  return { has: vi.fn(async (email: string) => alreadyLogged.includes(email)), record: vi.fn() };
}

function fakeMessage(donorItemId: string, attempts = 1): { body: OutboundSyncMessage; attempts: number; ack: () => void; retry: () => void } {
  return { body: { donorItemId }, attempts, ack: vi.fn(), retry: vi.fn() };
}

function fakePending(lastSyncStartedAt: string | null = null): PendingOutboundStore {
  return { upsertPending: vi.fn(), updateStatus: vi.fn(), lastSyncStartedAt: vi.fn().mockResolvedValue(lastSyncStartedAt), recordSyncStart: vi.fn() };
}

// Stands in for HttpMailchimpClient.updateMember's handling of lazily supplied managed tags: read
// only once the member is known to be in the audience.
function fakeUpdateMember(result: string = 'updated') {
  return vi.fn(async (_email: string, _fields: unknown, _tags: string[], managed: string[] | (() => Promise<string[]>)) => {
    if (result === 'updated' && typeof managed === 'function') await managed();
    return result as 'updated' | 'not-in-audience';
  });
}

// The managed tags an updateMember call was given, resolved if it was given a reader.
async function managedOf(updateMember: unknown, call = 0): Promise<string[]> {
  const managed = (updateMember as ReturnType<typeof vi.fn>).mock.calls[call]![3] as string[] | (() => Promise<string[]>);
  return typeof managed === 'function' ? managed() : managed;
}

function donor(overrides: Partial<DonorRecord> = {}): DonorRecord {
  return {
    id: '1', email: 'a@b.com', membershipStatus: 'Active', membershipTier: 'Standard',
    memberSince: '2026-01-01', memberUntil: '', addr1: '', city: '', state: '', zip: '', totalGiven: '0',
    doNotSolicit: false, dnsReasonStatus: '', nearby: [], hasActiveRecurringGift: false, lastGiftAmount: null, onHistorical: false,
    ...overrides,
  };
}

describe('processOutboundBatch coalescing (#97)', () => {
  function setup(lastSync: string | null, body: OutboundSyncMessage = { donorItemId: '1' }) {
    const message = { ...fakeMessage('1'), body, timestamp: new Date('2026-11-11T10:00:00.000Z') };
    const mondayClient: MondayClient = {
      getDonorById: vi.fn().mockResolvedValue(donor()),
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const mailchimpClient: MailchimpClient = {
      updateMember: vi.fn().mockResolvedValue('updated'),
      getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn().mockResolvedValue('renamed'), unsubscribeMember: vi.fn(), requestResubscribe: vi.fn(),
    };
    const pendingStore = fakePending(lastSync);
    const run = () => processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG, dnsLog: fakeDnsLog() });
    return { message, mondayClient, mailchimpClient, pendingStore, run };
  }

  it('acks without work when a sync began after the message was enqueued', async () => {
    const t = setup('2026-11-11T10:00:05.000Z');
    await t.run();
    expect(t.mondayClient.getDonorById).not.toHaveBeenCalled();
    expect(t.mailchimpClient.updateMember).not.toHaveBeenCalled();
    expect(t.message.ack).toHaveBeenCalled();
  });

  it('syncs when the last sync began before the message was enqueued, and records its start', async () => {
    const t = setup('2026-11-11T09:59:00.000Z');
    await t.run();
    expect(t.mailchimpClient.updateMember).toHaveBeenCalled();
    expect(t.pendingStore.recordSyncStart).toHaveBeenCalledWith('1', expect.any(String));
    expect(t.message.ack).toHaveBeenCalled();
  });

  it('syncs when no sync has completed yet', async () => {
    const t = setup(null);
    await t.run();
    expect(t.mailchimpClient.updateMember).toHaveBeenCalled();
  });

  it('never coalesces a message carrying previousEmail', async () => {
    const t = setup('2026-11-11T10:00:05.000Z', { donorItemId: '1', previousEmail: 'old@b.com' });
    await t.run();
    expect(t.mailchimpClient.renameMember).toHaveBeenCalledWith('old@b.com', 'a@b.com');
    expect(t.pendingStore.lastSyncStartedAt).not.toHaveBeenCalled();
  });

  it('syncs anyway when the last-sync lookup fails', async () => {
    const t = setup(null);
    vi.mocked(t.pendingStore.lastSyncStartedAt).mockRejectedValue(new Error('d1 down'));
    await t.run();
    expect(t.mailchimpClient.updateMember).toHaveBeenCalled();
    expect(t.message.ack).toHaveBeenCalled();
  });

  it('does not retry a finished sync when recording its start fails', async () => {
    const t = setup(null);
    vi.mocked(t.pendingStore.recordSyncStart).mockRejectedValue(new Error('d1 down'));
    await t.run();
    expect(t.message.ack).toHaveBeenCalled();
    expect(t.message.retry).not.toHaveBeenCalled();
  });
});

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
      getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(), requestResubscribe: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = fakePending();

    await processOutboundBatch([message], { mondayClient, mailchimpClient, pendingStore, config: CONFIG, dnsLog: fakeDnsLog() });

    expect(mailchimpClient.updateMember).toHaveBeenCalledWith(
      'a@b.com',
      expect.any(Object),
      ['active-member'],
      // The full worker-managed set, so the client can deactivate the ones no longer desired.
      ['active-member', 'lapsed-member', 'lifetime-member', 'has-donated', 'do-not-solicit', 'recurring-donor'],
    );
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('1', 'written', undefined, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
  });

  it('opts a newly active member into the Journey interests, reading the member tags once', async () => {
    const config: Config = { ...CONFIG, mailchimp: { ...CONFIG.mailchimp, journeyInterests: { welcomeDrip: 'w', renewalReminders: 'r', renewalOptOutTag: 'renewal-opt-out' } } };
    const mondayClient: MondayClient = {
      getDonorById: vi.fn().mockResolvedValue(donor()),
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    let interestsSet: Record<string, boolean> | undefined;
    const mailchimpClient: MailchimpClient = {
      updateMember: vi.fn(async (_e, _f, _t, _m, interests) => {
        interestsSet = interests ? await interests() : undefined;
        return 'updated' as const;
      }),
      getMemberInterests: vi.fn(), getMemberTagNames: vi.fn().mockResolvedValue(['has-donated']), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(), requestResubscribe: vi.fn(),
    };

    await processOutboundBatch([fakeMessage('1')], { mondayClient, mailchimpClient, pendingStore: fakePending(), config, dnsLog: fakeDnsLog() });

    expect(interestsSet).toEqual({ w: true, r: true });
    expect(mailchimpClient.getMemberTagNames).toHaveBeenCalledOnce();
  });

  it('passes no interests reader (and reads no tags) for a donor who is not becoming a member', async () => {
    const config: Config = { ...CONFIG, mailchimp: { ...CONFIG.mailchimp, journeyInterests: { welcomeDrip: 'w', renewalReminders: 'r', renewalOptOutTag: 'renewal-opt-out' } } };
    const mondayClient: MondayClient = {
      getDonorById: vi.fn().mockResolvedValue(donor({ membershipStatus: 'Lapsed' })),
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const mailchimpClient: MailchimpClient = {
      updateMember: vi.fn().mockResolvedValue('updated'),
      getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(), requestResubscribe: vi.fn(),
    };

    await processOutboundBatch([fakeMessage('1')], { mondayClient, mailchimpClient, pendingStore: fakePending(), config, dnsLog: fakeDnsLog() });

    expect((mailchimpClient.updateMember as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(4);
    expect(mailchimpClient.getMemberTagNames).not.toHaveBeenCalled();
  });

  it('records skipped (not written) and acks when the donor is not in the Mailchimp audience', async () => {
    // No consent recorded in Mailchimp → the donor is never added (issue GL#28). A column
    // change on such a donor (e.g. donation-rollups bumping Total Given) is a no-op.
    const message = fakeMessage('4');
    const mondayClient: MondayClient = {
      getDonorById: vi.fn().mockResolvedValue(donor({ email: 'noconsent@example.com' })),
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const mailchimpClient: MailchimpClient = {
      updateMember: vi.fn().mockResolvedValue('not-in-audience'),
      getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(), requestResubscribe: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = fakePending();

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
    const mailchimpClient: MailchimpClient = { updateMember: vi.fn(), getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(), requestResubscribe: vi.fn() };
    const pendingStore: PendingOutboundStore = fakePending();

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
    const mailchimpClient: MailchimpClient = { updateMember: vi.fn(), getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(), requestResubscribe: vi.fn() };
    const pendingStore: PendingOutboundStore = fakePending();

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
      getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(), requestResubscribe: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = fakePending();

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
      getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(), requestResubscribe: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = fakePending();

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
        updateMember: fakeUpdateMember(updateResult),
        renameMember: vi.fn(), unsubscribeMember: vi.fn(), requestResubscribe: vi.fn(),
        getMemberInterests: vi.fn(), getMemberTagNames: vi.fn().mockResolvedValue(memberTags), listInterests: vi.fn(),
      };
      const pendingStore: PendingOutboundStore = fakePending();
      return { mondayClient, mailchimpClient, pendingStore, dnsLog: fakeDnsLog(), config };
    }

    it('deactivates a Near: tag the Monday column no longer holds, and activates the current ones', async () => {
      const d = nearbyDeps(donor({ nearby: ['New'] }), ['Near: Old', 'Near: New', 'VIP']);
      await processOutboundBatch([fakeMessage('1')], d);

      const [, , desired] = (d.mailchimpClient.updateMember as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const managed = await managedOf(d.mailchimpClient.updateMember);
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

      expect(message.retry).toHaveBeenCalled();
      expect(message.ack).not.toHaveBeenCalled();
      expect(d.pendingStore.recordSyncStart).not.toHaveBeenCalled();
    });

    // GL#97: PATCH first. Reading tags first spent a call on every donor who isn't a member.
    it('does not read tags for a donor the PATCH finds is not in the audience', async () => {
      const d = nearbyDeps(donor(), ['Near: Old'], NEARBY_CONFIG, 'not-in-audience');
      await processOutboundBatch([fakeMessage('1')], d);
      expect(d.mailchimpClient.getMemberTagNames).not.toHaveBeenCalled();
      expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('1', 'skipped', expect.stringContaining('not in the Mailchimp audience'));
    });

    it('reads tags only after the PATCH', async () => {
      const d = nearbyDeps(donor(), ['Near: Old']);
      await processOutboundBatch([fakeMessage('1')], d);
      expect(vi.mocked(d.mailchimpClient.updateMember).mock.invocationCallOrder[0]!)
        .toBeLessThan(vi.mocked(d.mailchimpClient.getMemberTagNames).mock.invocationCallOrder[0]!);
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
        renameMember: vi.fn(), unsubscribeMember: vi.fn().mockResolvedValue(opts.unsubscribeResult ?? 'unsubscribed'), requestResubscribe: vi.fn(),
        getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(),
      };
      const pendingStore: PendingOutboundStore = fakePending();
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
        unsubscribeMember: vi.fn().mockResolvedValue('unsubscribed'), requestResubscribe: vi.fn(),
        getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(),
      };
      const pendingStore: PendingOutboundStore = fakePending();
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
        getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(), requestResubscribe: vi.fn(),
      };
      return {
        mondayClient, mailchimpClient, config: CONFIG, dnsLog: fakeDnsLog(),
        pendingStore: pendingStore ?? fakePending(),
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
      const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn().mockRejectedValue(new Error('D1 unavailable')), lastSyncStartedAt: vi.fn().mockResolvedValue(null), recordSyncStart: vi.fn() };
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
      const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn().mockRejectedValue(new Error('D1 unavailable')), lastSyncStartedAt: vi.fn().mockResolvedValue(null), recordSyncStart: vi.fn() };
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
      updateMember: fakeUpdateMember(),
      renameMember: vi.fn().mockResolvedValue('renamed'),
      unsubscribeMember: vi.fn().mockResolvedValue('unsubscribed'), requestResubscribe: vi.fn(),
      getMemberTagNames: vi.fn().mockResolvedValue(['Near: Old project']),
      getMemberInterests: vi.fn(), listInterests: vi.fn(),
    };
    const pendingStore: PendingOutboundStore = fakePending();
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

  // previousEmail comes from the webhook payload, so whoever holds the webhook secret chooses it.
  // A forged event naming someone else's address must not carry that person's contact off.
  describe('an old address another item still holds', () => {
    const changedFrom = (previousEmail: string) => ({ ...fakeMessage('1'), body: { donorItemId: '1', previousEmail } });

    function holdsOn(deps: ReturnType<typeof setup>, holders: Record<number, string>) {
      vi.mocked(deps.mondayClient.findItemIdByEmail).mockImplementation(async (board) => holders[board] ?? null);
    }

    it('does not move a contact another People item holds when a People item changes address', async () => {
      const deps = setup(donor({ onHistorical: false }), ['victim@b.com']);
      const message = changedFrom('victim@b.com');
      await processOutboundBatch([message], deps);
      expect(deps.mailchimpClient.renameMember).not.toHaveBeenCalled();
      expect(deps.mailchimpClient.updateMember).toHaveBeenCalledTimes(1);
      expect(message.ack).toHaveBeenCalled();
    });

    it('does not move a contact a Historical item holds', async () => {
      const deps = setup(donor({ onHistorical: false }));
      holdsOn(deps, { 222: '901' });
      await processOutboundBatch([changedFrom('victim@b.com')], deps);
      expect(deps.mondayClient.findItemIdByEmail).toHaveBeenCalledWith(222, 'h-e', 'victim@b.com');
      expect(deps.mailchimpClient.renameMember).not.toHaveBeenCalled();
    });

    it('moves the contact when no item holds the old address any more', async () => {
      const deps = setup(donor({ onHistorical: false }));
      await processOutboundBatch([changedFrom('old@b.com')], deps);
      expect(deps.mailchimpClient.renameMember).toHaveBeenCalledWith('old@b.com', 'a@b.com');
    });

    it('moves the contact when the only holder is this item, from a lagging search', async () => {
      const deps = setup(donor({ onHistorical: false }));
      holdsOn(deps, { 111: '1' });
      await processOutboundBatch([changedFrom('old@b.com')], deps);
      expect(deps.mailchimpClient.renameMember).toHaveBeenCalledWith('old@b.com', 'a@b.com');
    });

    it('retries rather than moving the contact when the lookup fails', async () => {
      const deps = setup(donor({ onHistorical: false }));
      vi.mocked(deps.mondayClient.findItemIdByEmail).mockRejectedValue(new Error('network'));
      const message = changedFrom('old@b.com');
      await processOutboundBatch([message], deps);
      expect(deps.mailchimpClient.renameMember).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalled();
    });
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
    const managed = await managedOf(deps.mailchimpClient.updateMember);
    expect(managed).not.toContain('Near: Old project');
  });

  it('reads Near: tags when the Historical board has its own Nearby column', async () => {
    const withBothNearby: Config = { ...config, monday: { ...config.monday, historical: { boardId: 222, columns: { ...HISTORICAL_COLUMNS, nearby: 'h-n' } } } };
    const deps = { ...setup(donor({ onHistorical: true })), config: withBothNearby };
    await processOutboundBatch([fakeMessage('1')], deps);
    const managed = await managedOf(deps.mailchimpClient.updateMember);
    expect(managed).toContain('Near: Old project');
  });
});

// GL#101: once one message hits a Monday outage, the rest of the batch is retried with backoff
// without calling Monday or Mailchimp, instead of each repeating the transport's in-process attempts.
describe('outage breaker (#101)', () => {
  function outageDeps(err: Error) {
    const mondayClient: MondayClient = {
      getDonorById: vi.fn().mockRejectedValue(err),
      createCampaignItem: vi.fn(), renameItem: vi.fn(), archiveItem: vi.fn(),
      findItemIdByEmail: vi.fn(), setConnectColumn: vi.fn(),
    };
    const mailchimpClient: MailchimpClient = {
      updateMember: vi.fn(), getMemberInterests: vi.fn(), getMemberTagNames: vi.fn(), listInterests: vi.fn(), renameMember: vi.fn(), unsubscribeMember: vi.fn(), requestResubscribe: vi.fn(),
    };
    return { mondayClient, mailchimpClient, config: CONFIG, dnsLog: fakeDnsLog(), pendingStore: fakePending() };
  }
  const gate = (mode: 'on' | 'hold') => ({ worker: 'mailchimp-sync', environment: 'production', mode, logLevel: 'normal' as const, piiKeys: ['email'] });

  it('stops calling Monday after an outage and retries the rest of the batch with backoff', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = outageDeps(new MondayApiError('monday API: HTTP 503', { httpStatus: 503 }));
    const messages = [fakeMessage('1', 2), fakeMessage('2', 1), fakeMessage('3', 4)];
    await consumeOutboundBatch(messages, deps, gate('on'));
    expect(deps.mondayClient.getDonorById).toHaveBeenCalledTimes(1);
    expect(messages.map((m) => (m.retry as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toEqual([{ delaySeconds: 120 }, { delaySeconds: 60 }, { delaySeconds: 480 }]);
    expect(deps.pendingStore.updateStatus).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("raises the deferral to Monday's Retry-After hint", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = outageDeps(new MondayApiError('monday API: HTTP 429', { httpStatus: 429, retryAfterSeconds: 500 }));
    const messages = [fakeMessage('1', 1), fakeMessage('2', 1)];
    await processOutboundBatch(messages, deps);
    expect(messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 500 });
    expect(messages[1]!.retry).toHaveBeenCalledWith({ delaySeconds: 500 });
    expect(deps.mondayClient.getDonorById).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it('a Mailchimp failure stays per-message: the next donor still syncs', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = outageDeps(new Error('unused'));
    (deps.mondayClient.getDonorById as ReturnType<typeof vi.fn>).mockResolvedValue(donor());
    (deps.mailchimpClient.updateMember as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('mailchimp: HTTP 503')).mockResolvedValue(undefined);
    const messages = [fakeMessage('1', 1), fakeMessage('2', 1)];
    await processOutboundBatch(messages, deps);
    expect(messages[0]!.retry).toHaveBeenCalled();
    expect(messages[1]!.ack).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('hold is unchanged: every message backs off and nothing is called', async () => {
    const deps = outageDeps(new Error('unused'));
    const messages = [fakeMessage('1', 3), fakeMessage('2', 1)];
    await consumeOutboundBatch(messages, deps, gate('hold'));
    expect(messages.map((m) => (m.retry as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toEqual([{ delaySeconds: 240 }, { delaySeconds: 60 }]);
    expect(deps.mondayClient.getDonorById).not.toHaveBeenCalled();
  });
});
