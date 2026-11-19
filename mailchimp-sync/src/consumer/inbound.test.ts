import { describe, it, expect, vi } from 'vitest';
import md5 from 'md5';
import { consumeInboundBatch, processInboundBatch } from './inbound';
import type { MondayClient } from '../monday/client';
import { MondayApiError } from '../monday/client';
import { MailchimpAuthError, MailchimpPermanentError, MailchimpRateLimitError } from '../mailchimp/client';
import type { MailchimpClient } from '../mailchimp/client';
import type { CampaignItemsStore, CampaignItemRow } from '../db/campaignItems';
import type { PendingInboundStore } from '../db/pendingInbound';
import type { Config, InboundSyncMessage } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: 111, campaignsBoardId: 999, historical: null, columns: {
    membershipStatus: 's', membershipTier: 't', memberSince: 'ms', memberUntil: 'mu',
    addr1: 'a1', city: 'c', state: 'st', zip: 'z', email: 'e', totalGiven: 'g', mailchimpCampaigns: 'mc',
    doNotSolicit: 'dns', dnsReasonStatus: 'dnsStatus', nearby: null,
  } },
  mailchimp: { apiBaseUrl: '', audienceId: '', mergeFields: {} as never, tags: {} as never, interestCategoryIds: ['cat1'], journeyInterests: null, renewalDue: null, nearbyTagPrefix: 'Near: ' },
  lifetimeTierValue: 'Lifetime', activeStatusValue: 'Active', dnsConfirmedValue: 'Confirmed',
  consent: { enabled: false, maxChangesPerRun: 500, boards: [] },
  journeyLog: null,
  profileLinks: null,
};

function fakeMessage(email: string, attempts = 1): { body: InboundSyncMessage; attempts: number; ack: () => void; retry: () => void } {
  return { body: { email }, attempts, ack: vi.fn(), retry: vi.fn() };
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
    updateMember: vi.fn(),
    renameMember: vi.fn(), unsubscribeMember: vi.fn(),
    getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: { int1: true, int2: false } }),
    getMemberTagNames: vi.fn().mockResolvedValue([]),
    listInterests: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function fakeCampaignItemsStore(rows: CampaignItemRow[] = []): CampaignItemsStore {
  return {
    listActive: vi.fn().mockResolvedValue(rows),
    upsert: vi.fn().mockResolvedValue(undefined),
    markArchived: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue(true),
    getByInterestIds: vi.fn().mockImplementation(async (ids: readonly string[]) => new Map(rows.filter((r) => ids.includes(r.interestId)).map((r) => [r.interestId, r]))),
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

  it('records skipped (not written) and acks when no Donor item matches the email', async () => {
    const message = fakeMessage('a@b.com');
    const mondayClient = fakeMonday({ findItemIdByEmail: vi.fn().mockResolvedValue(null) });
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], {
      mondayClient, mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: {} }) }),
      campaignItemsStore: fakeCampaignItemsStore(), pendingStore, config: CONFIG,
    });

    expect(mondayClient.setConnectColumn).not.toHaveBeenCalled();
    // A genuine miss must be distinguishable from a successful write — 'skipped',
    // never 'written'.
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('a@b.com', 'skipped', expect.stringContaining('a@b.com'));
    expect(pendingStore.updateStatus).not.toHaveBeenCalledWith('a@b.com', 'written', undefined, expect.any(String));
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
      claim: vi.fn().mockResolvedValue(true),
      getByInterestIds: vi.fn().mockImplementation(async (ids: readonly string[]) => new Map(rows.filter((r) => ids.includes(r.interestId)).map((r) => [r.interestId, r]))),
    };
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], { mondayClient, mailchimpClient, campaignItemsStore, pendingStore, config: CONFIG });

    expect(mondayClient.createCampaignItem).toHaveBeenCalledWith(999, 'Brand New');
    expect(mondayClient.setConnectColumn).toHaveBeenCalledWith(111, 'donor-1', 'mc', ['campaign-new']);
  });

  it('leaves off an interest outside the configured categories instead of failing the message', async () => {
    const message = fakeMessage('a@b.com');
    const mondayClient = fakeMonday();
    const campaignItemsStore = fakeCampaignItemsStore([
      { interestId: 'int1', mondayItemId: 'campaign-1', name: 'Newsletter', archivedAt: null },
    ]);
    const mailchimpClient = fakeMailchimp({
      // 'old-list' is in one of the audience's old categories, so listInterests never returns it.
      getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: { 'old-list': true, int1: true } }),
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'int1', name: 'Newsletter' }]),
    });
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], { mondayClient, mailchimpClient, campaignItemsStore, pendingStore, config: CONFIG });

    expect(mailchimpClient.listInterests).toHaveBeenCalledWith(['cat1']);
    expect(mondayClient.createCampaignItem).not.toHaveBeenCalled();
    expect(mondayClient.setConnectColumn).toHaveBeenCalledWith(111, 'donor-1', 'mc', ['campaign-1']);
    expect(message.ack).toHaveBeenCalled();
  });

  it('clears the connect column for an unsubscribed contact even though interests are still non-empty', async () => {
    const message = fakeMessage('unsub@b.com');
    const mondayClient = fakeMonday();
    const campaignItemsStore = fakeCampaignItemsStore([
      { interestId: 'int1', mondayItemId: 'campaign-1', name: 'Newsletter', archivedAt: null },
    ]);
    const mailchimpClient = fakeMailchimp({
      // Mailchimp preserves `interests` unchanged after unsubscribe — status is the signal.
      getMemberInterests: vi.fn().mockResolvedValue({ status: 'unsubscribed', interests: { int1: true } }),
    });
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], {
      mondayClient, mailchimpClient, campaignItemsStore, pendingStore, config: CONFIG,
    });

    expect(mondayClient.setConnectColumn).toHaveBeenCalledWith(111, 'donor-1', 'mc', []);
    expect(message.ack).toHaveBeenCalled();
  });

  it('retries (does not ack) when an interest is still unresolvable after the one-shot reconcile', async () => {
    const message = fakeMessage('a@b.com');
    const mondayClient = fakeMonday();
    // A synced interest whose item another run has claimed but not yet recorded, so the
    // reconcile can't track it either. (One outside the configured categories is left off.)
    const mailchimpClient = fakeMailchimp({
      getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: { 'ghost-int': true } }),
      listInterests: vi.fn().mockResolvedValue([{ categoryId: 'cat1', interestId: 'ghost-int', name: 'Ghost' }]),
    });
    const campaignItemsStore = { ...fakeCampaignItemsStore([]), claim: vi.fn().mockResolvedValue(false) };
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };

    await processInboundBatch([message], {
      mondayClient, mailchimpClient, campaignItemsStore, pendingStore, config: CONFIG,
    });

    expect(mondayClient.setConnectColumn).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith(
      'a@b.com',
      'failed',
      expect.stringContaining('ghost-int'),
    );
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
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('acks (does not retry) a permanent Mailchimp error, like the outbound consumer (#37)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = fakeMessage('a@b.com');
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };
    await processInboundBatch([message], {
      mondayClient: fakeMonday(),
      mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockRejectedValue(new MailchimpPermanentError('mailchimp getMemberInterests: HTTP 400')) }),
      campaignItemsStore: fakeCampaignItemsStore(), pendingStore, config: CONFIG,
    });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('a@b.com', 'failed', 'mailchimp getMemberInterests: HTTP 400');
    errorSpy.mockRestore();
  });

  // GL#97: catalog work is batch-scoped. One D1 query resolves every message's interests, one
  // reconcile (run after every member in the batch was read) covers every unknown interest, and a
  // member with no Donor item never gets that far.
  describe('batch scope (#97)', () => {
    const KNOWN: CampaignItemRow[] = [
      { interestId: 'int1', mondayItemId: 'campaign-1', name: 'Newsletter', archivedAt: null },
    ];

    function trackingStore(): { store: CampaignItemsStore; rows: CampaignItemRow[] } {
      const rows: CampaignItemRow[] = [...KNOWN];
      const store: CampaignItemsStore = {
        listActive: vi.fn().mockImplementation(async () => rows),
        upsert: vi.fn().mockImplementation(async (row: CampaignItemRow) => { rows.push(row); }),
        markArchived: vi.fn(),
        claim: vi.fn().mockResolvedValue(true),
        getByInterestIds: vi.fn().mockImplementation(async (ids: readonly string[]) => new Map(rows.filter((r) => ids.includes(r.interestId)).map((r) => [r.interestId, r]))),
      };
      return { store, rows };
    }

    const interestsByEmail = (map: Record<string, Record<string, boolean>>) =>
      vi.fn(async (email: string) => ({ status: 'subscribed', interests: map[email] ?? {} }));

    it('resolves every message\'s interests with one catalog query', async () => {
      const { store } = trackingStore();
      const mondayClient = fakeMonday();
      const messages = [fakeMessage('a@b.com'), fakeMessage('c@d.com')];
      await processInboundBatch(messages, {
        mondayClient, campaignItemsStore: store, pendingStore: { upsertPending: vi.fn(), updateStatus: vi.fn() }, config: CONFIG,
        mailchimpClient: fakeMailchimp({ getMemberInterests: interestsByEmail({ 'a@b.com': { int1: true }, 'c@d.com': { int1: true } }) }),
      });
      expect(store.getByInterestIds).toHaveBeenCalledOnce();
      expect(mondayClient.setConnectColumn).toHaveBeenCalledTimes(2);
      for (const m of messages) expect(m.ack).toHaveBeenCalled();
    });

    it('reconciles once for a batch whose messages hold unknown interests, after reading every member', async () => {
      const { store } = trackingStore();
      const mondayClient = fakeMonday({ createCampaignItem: vi.fn().mockImplementation(async (_b: number, name: string) => `item-${name}`) });
      const mailchimpClient = fakeMailchimp({
        getMemberInterests: interestsByEmail({ 'a@b.com': { new1: true }, 'c@d.com': { new2: true, 'old-list': true } }),
        listInterests: vi.fn().mockResolvedValue([
          { categoryId: 'cat1', interestId: 'int1', name: 'Newsletter' },
          { categoryId: 'cat1', interestId: 'new1', name: 'N1' },
          { categoryId: 'cat1', interestId: 'new2', name: 'N2' },
        ]),
      });
      await processInboundBatch([fakeMessage('a@b.com'), fakeMessage('c@d.com')], {
        mondayClient, mailchimpClient, campaignItemsStore: store, pendingStore: { upsertPending: vi.fn(), updateStatus: vi.fn() }, config: CONFIG,
      });
      expect(mailchimpClient.listInterests).toHaveBeenCalledOnce();
      expect(vi.mocked(mailchimpClient.getMemberInterests).mock.invocationCallOrder[1]!)
        .toBeLessThan(vi.mocked(mailchimpClient.listInterests).mock.invocationCallOrder[0]!);
      expect(mondayClient.setConnectColumn).toHaveBeenCalledWith(111, 'donor-1', 'mc', ['item-N1']);
      expect(mondayClient.setConnectColumn).toHaveBeenCalledWith(111, 'donor-1', 'mc', ['item-N2']);
    });

    it('never reconciles or resolves interests for a member with no Donor item', async () => {
      const { store } = trackingStore();
      const mailchimpClient = fakeMailchimp({ getMemberInterests: interestsByEmail({ 'a@b.com': { 'brand-new': true } }) });
      const message = fakeMessage('a@b.com');
      const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await processInboundBatch([message], {
        mondayClient: fakeMonday({ findItemIdByEmail: vi.fn().mockResolvedValue(null) }), mailchimpClient, campaignItemsStore: store, pendingStore, config: CONFIG,
      });
      expect(mailchimpClient.listInterests).not.toHaveBeenCalled();
      expect(store.getByInterestIds).not.toHaveBeenCalled();
      expect(pendingStore.updateStatus).toHaveBeenCalledWith('a@b.com', 'skipped', expect.any(String));
      expect(message.ack).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('when the reconcile fails, retries only the messages that needed it and writes the rest', async () => {
      const { store } = trackingStore();
      const mondayClient = fakeMonday();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const needsIt = fakeMessage('a@b.com');
      const known = fakeMessage('c@d.com');
      await processInboundBatch([needsIt, known], {
        mondayClient, campaignItemsStore: store, pendingStore: { upsertPending: vi.fn(), updateStatus: vi.fn() }, config: CONFIG,
        mailchimpClient: fakeMailchimp({
          getMemberInterests: interestsByEmail({ 'a@b.com': { 'brand-new': true }, 'c@d.com': { int1: true } }),
          listInterests: vi.fn().mockRejectedValue(new Error('mailchimp listInterests: HTTP 503')),
        }),
      });
      expect(needsIt.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
      expect(needsIt.ack).not.toHaveBeenCalled();
      expect(known.ack).toHaveBeenCalled();
      expect(mondayClient.setConnectColumn).toHaveBeenCalledOnce();
      expect(mondayClient.setConnectColumn).toHaveBeenCalledWith(111, 'donor-1', 'mc', ['campaign-1']);
      errorSpy.mockRestore();
    });

    it('a failed member read retries that message alone', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failing = fakeMessage('a@b.com');
      const fine = fakeMessage('c@d.com');
      const getMemberInterests = vi.fn(async (email: string) => {
        if (email === 'a@b.com') throw new Error('mailchimp getMemberInterests: HTTP 503');
        return { status: 'subscribed', interests: { int1: true } };
      });
      await processInboundBatch([failing, fine], {
        mondayClient: fakeMonday(), mailchimpClient: fakeMailchimp({ getMemberInterests }), campaignItemsStore: trackingStore().store,
        pendingStore: { upsertPending: vi.fn(), updateStatus: vi.fn() }, config: CONFIG,
      });
      expect(failing.retry).toHaveBeenCalled();
      expect(fine.ack).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe('logs never carry an email address', () => {
    function logged(...spies: ReturnType<typeof vi.spyOn>[]): string {
      return spies.flatMap((spy) => spy.mock.calls.flat()).join('\n');
    }

    it('names the member id, and scrubs an address Mailchimp quoted in its error', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn().mockRejectedValue(new Error('D1 write failed for donor@example.org')) };
      await processInboundBatch([fakeMessage('donor@example.org')], {
        mondayClient: fakeMonday(),
        mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockRejectedValue(new MailchimpPermanentError('mailchimp getMemberInterests: HTTP 400: donor@example.org is invalid')) }),
        campaignItemsStore: fakeCampaignItemsStore(), pendingStore, config: CONFIG,
      });
      const text = logged(errorSpy);
      expect(text).toContain(`member ${md5('donor@example.org')}`);
      expect(text).not.toContain('@');
      errorSpy.mockRestore();
    });

    it('names the member id when no Donor item matches', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await processInboundBatch([fakeMessage('donor@example.org')], {
        mondayClient: fakeMonday({ findItemIdByEmail: vi.fn().mockResolvedValue(null) }),
        mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: {} }) }),
        campaignItemsStore: fakeCampaignItemsStore(), pendingStore: { upsertPending: vi.fn(), updateStatus: vi.fn() }, config: CONFIG,
      });
      const text = logged(warnSpy);
      expect(text).toContain(`member ${md5('donor@example.org')}`);
      expect(text).not.toContain('@');
      warnSpy.mockRestore();
    });
  });

  describe('retry backoff (#35)', () => {
    async function retryFor(err: Error, attempts: number, pendingStore?: PendingInboundStore) {
      const message = fakeMessage('a@b.com', attempts);
      await processInboundBatch([message], {
        mondayClient: fakeMonday({ findItemIdByEmail: vi.fn().mockRejectedValue(err) }),
        mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: {} }) }),
        campaignItemsStore: fakeCampaignItemsStore(),
        pendingStore: pendingStore ?? { upsertPending: vi.fn(), updateStatus: vi.fn() },
        config: CONFIG,
      });
      expect(message.ack).not.toHaveBeenCalled();
      return message.retry;
    }

    it('backs off exponentially by delivery attempt', async () => {
      expect(await retryFor(new Error('x'), 2)).toHaveBeenCalledWith({ delaySeconds: 120 });
      expect(await retryFor(new Error('x'), 3)).toHaveBeenCalledWith({ delaySeconds: 240 });
    });

    it("waits at least Monday's retry_in_seconds", async () => {
      const err = new MondayApiError('monday: HTTP 429', { httpStatus: 429, code: 'COMPLEXITY_BUDGET_EXHAUSTED', retryAfterSeconds: 300 });
      expect(await retryFor(err, 1)).toHaveBeenCalledWith({ delaySeconds: 300 });
    });

    it('waits at least a Mailchimp Retry-After on a 429', async () => {
      const message = fakeMessage('a@b.com', 1);
      await processInboundBatch([message], {
        mondayClient: fakeMonday(),
        mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockRejectedValue(new MailchimpRateLimitError('429', 120)) }),
        campaignItemsStore: fakeCampaignItemsStore(),
        pendingStore: { upsertPending: vi.fn(), updateStatus: vi.fn() },
        config: CONFIG,
      });
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    });

    it('retries (never acks) when Mailchimp rejects the API key on the read, and says so in the log', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const message = fakeMessage('a@b.com', 1);
      await processInboundBatch([message], {
        mondayClient: fakeMonday(),
        mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockRejectedValue(new MailchimpAuthError('mailchimp getMemberInterests: HTTP 401')) }),
        campaignItemsStore: fakeCampaignItemsStore(),
        pendingStore: { upsertPending: vi.fn(), updateStatus: vi.fn() },
        config: CONFIG,
      });
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MAILCHIMP CREDENTIALS REJECTED'));
      errorSpy.mockRestore();
    });

    it('still retries with backoff when recording the failure in D1 throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn().mockRejectedValue(new Error('D1 unavailable')) };
      expect(await retryFor(new Error('monday down'), 2, pendingStore)).toHaveBeenCalledWith({ delaySeconds: 120 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('could not record failure'));
      errorSpy.mockRestore();
    });
  });
});

// GL#101: once one message hits a Monday outage, the rest of the batch is retried with backoff
// without calling Monday or Mailchimp, instead of each repeating the transport's in-process attempts.
describe('outage breaker (#101)', () => {
  function outageDeps(err: Error) {
    return {
      mondayClient: fakeMonday({ findItemIdByEmail: vi.fn().mockRejectedValue(err) }),
      mailchimpClient: fakeMailchimp({ getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: {} }) }),
      campaignItemsStore: fakeCampaignItemsStore(),
      pendingStore: { upsertPending: vi.fn(), updateStatus: vi.fn() },
      config: CONFIG,
    };
  }

  it('stops calling upstream after a Monday outage and retries the rest of the batch with backoff', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = outageDeps(new MondayApiError('monday API: HTTP 502', { httpStatus: 502 }));
    const messages = [fakeMessage('a@b.com', 2), fakeMessage('c@d.com', 1), fakeMessage('e@f.com', 4)];
    await consumeInboundBatch(messages, deps, { worker: 'mailchimp-sync', environment: 'production', mode: 'on', logLevel: 'normal', piiKeys: ['email'] });
    expect(deps.mondayClient.findItemIdByEmail).toHaveBeenCalledTimes(1);
    expect(deps.mailchimpClient.getMemberInterests).toHaveBeenCalledTimes(1);
    expect(messages.map((m) => (m.retry as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toEqual([{ delaySeconds: 120 }, { delaySeconds: 60 }, { delaySeconds: 480 }]);
    errors.mockRestore();
  });

  it('an ordinary failure stays per-message', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = outageDeps(new Error('x'));
    const messages = [fakeMessage('a@b.com', 1), fakeMessage('c@d.com', 1)];
    await processInboundBatch(messages, deps);
    expect(deps.mondayClient.findItemIdByEmail).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });
});
