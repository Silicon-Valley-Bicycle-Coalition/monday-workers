import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PII_KEYS, type WriteMode } from './flags';
import { consumeOutboundBatch } from './consumer/outbound';
import { consumeInboundBatch } from './consumer/inbound';
import { runScheduledReconcile } from './campaigns/scheduled';
import { createOutboundApp } from './webhook/outboundRoute';
import { createInboundApp } from './webhook/inboundRoute';
import { MailchimpPermanentError, MailchimpRateLimitError } from './mailchimp/client';
import type { MailchimpClient } from './mailchimp/client';
import type { MondayClient } from './monday/client';
import type { CampaignItemRow, CampaignItemsStore } from './db/campaignItems';
import type { PendingOutboundStore } from './db/pendingOutbound';
import type { PendingInboundStore } from './db/pendingInbound';
import type { DnsUnsubscribeLog } from './db/dnsUnsubscribes';
import type { Config, DonorRecord, InboundSyncMessage, OutboundSyncMessage } from './types';
import type { WriteStamp } from './flags';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: 111, campaignsBoardId: 999, historical: null, columns: {
    membershipStatus: 's', membershipTier: 't', memberSince: 'ms', memberUntil: 'mu',
    addr1: 'a1', city: 'c', state: 'st', zip: 'z', email: 'e', totalGiven: 'g', mailchimpCampaigns: 'mc',
    doNotSolicit: 'dns', dnsReasonStatus: 'dnsStatus', nearby: null,
  } },
  mailchimp: {
    apiBaseUrl: '', audienceId: '', interestCategoryIds: ['cat1'], journeyInterests: null, renewalDue: null, nearbyTagPrefix: 'Near: ',
    mergeFields: { memberSince: 'MS', memberUntil: 'MU', membershipTier: 'MT', membershipStatus: 'MST', address: 'AD', totalGiven: 'TG' },
    tags: { activeMember: 'active-member', lapsedMember: 'lapsed-member', lifetimeMember: 'lifetime-member', hasDonated: 'has-donated', doNotSolicit: 'do-not-solicit', recurringDonor: 'recurring-donor' },
  },
  lifetimeTierValue: 'Lifetime', activeStatusValue: 'Active', dnsConfirmedValue: 'Confirmed',
  consent: { enabled: false, maxChangesPerRun: 500, boards: [] },
};

const EMAIL = 'someone@example.com';

function gate(mode: WriteMode) {
  return { worker: 'mailchimp-sync', environment: 'production' as const, mode, logLevel: 'normal' as const, piiKeys: DEFAULT_PII_KEYS };
}

function donor(overrides: Partial<DonorRecord> = {}): DonorRecord {
  return {
    id: '1', email: EMAIL, membershipStatus: 'Active', membershipTier: 'Standard',
    memberSince: '2026-01-01', memberUntil: '', addr1: '', city: '', state: '', zip: '', totalGiven: '0',
    doNotSolicit: true, dnsReasonStatus: 'Confirmed', nearby: [], hasActiveRecurringGift: false, onHistorical: false,
    ...overrides,
  };
}

function fakeMonday(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    getDonorById: vi.fn().mockResolvedValue(donor()),
    createCampaignItem: vi.fn().mockResolvedValue('real-1'), renameItem: vi.fn(), archiveItem: vi.fn(),
    findItemIdByEmail: vi.fn().mockResolvedValue('donor-1'),
    setConnectColumn: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeMailchimp(overrides: Partial<MailchimpClient> = {}): MailchimpClient {
  return {
    updateMember: vi.fn().mockResolvedValue('updated'),
    renameMember: vi.fn(), unsubscribeMember: vi.fn().mockResolvedValue('unsubscribed'),
    getMemberInterests: vi.fn().mockResolvedValue({ status: 'subscribed', interests: { int1: true } }),
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

function outboundDeps() {
  const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn(), lastSyncStartedAt: vi.fn().mockResolvedValue(null), recordSyncStart: vi.fn() };
  const dnsLog: DnsUnsubscribeLog = { has: vi.fn().mockResolvedValue(false), record: vi.fn() };
  return { pendingStore, dnsLog, mondayClient: fakeMonday(), mailchimpClient: fakeMailchimp(), config: CONFIG };
}

function inboundDeps(rows: CampaignItemRow[] = [{ interestId: 'int1', mondayItemId: 'campaign-1', name: 'N', archivedAt: null }]) {
  const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };
  return { pendingStore, mondayClient: fakeMonday(), mailchimpClient: fakeMailchimp(), campaignItemsStore: fakeCampaignItemsStore(rows), config: CONFIG };
}

function outMsg(body: OutboundSyncMessage & WriteStamp, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}
function inMsg(body: InboundSyncMessage & WriteStamp, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function logged(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c) => c.join(' ')).join('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('routes stamp the mode', () => {
  it('outbound: off stamps the message dropped and records the row dropped', async () => {
    const send = vi.fn();
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn(), lastSyncStartedAt: vi.fn().mockResolvedValue(null), recordSyncStart: vi.fn() };
    const app = createOutboundApp({ pendingStore, queue: { send }, webhookSecret: 's', config: CONFIG, writeMode: async () => 'off' });
    const res = await app.request('/webhooks/monday/donors?secret=s', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: { pulseId: 7 } }),
    });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ donorItemId: '7', writeStamp: 'dropped' });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('7', 'dropped');
  });

  it('outbound: on sends an unstamped message and records it queued', async () => {
    const send = vi.fn();
    const pendingStore: PendingOutboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn(), lastSyncStartedAt: vi.fn().mockResolvedValue(null), recordSyncStart: vi.fn() };
    const app = createOutboundApp({ pendingStore, queue: { send }, webhookSecret: 's', config: CONFIG, writeMode: async () => 'on' });
    await app.request('/webhooks/monday/donors?secret=s', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: { pulseId: 7 } }),
    });
    expect(send).toHaveBeenCalledWith({ donorItemId: '7' });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('7', 'queued');
  });

  it('inbound: off stamps the message dropped and records the row dropped', async () => {
    const send = vi.fn();
    const pendingStore: PendingInboundStore = { upsertPending: vi.fn(), updateStatus: vi.fn() };
    const app = createInboundApp({ pendingStore, queue: { send }, webhookSecret: 's', writeMode: async () => 'off' });
    const form = new URLSearchParams({ type: 'profile', 'data[email]': EMAIL, 'data[list_id]': 'L' });
    const res = await app.request('/webhooks/mailchimp/audience?secret=s', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ email: EMAIL, writeStamp: 'dropped' });
    expect(pendingStore.updateStatus).toHaveBeenCalledWith(EMAIL, 'dropped');
  });
});

describe('outbound consumer', () => {
  it('off: no Mailchimp call, no dnsLog.record, ack, and a skip line per write', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = outboundDeps();
    const message = outMsg({ donorItemId: '1' });
    await consumeOutboundBatch([message], deps, gate('off'));
    expect(deps.mailchimpClient.updateMember).not.toHaveBeenCalled();
    expect(deps.mailchimpClient.unsubscribeMember).not.toHaveBeenCalled();
    expect(deps.dnsLog.record).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    const out = logged(log);
    expect(out).toContain('"operation":"updateMember"');
    expect(out).toContain('"operation":"unsubscribeMember"');
    expect(out).not.toContain('@');
  });

  // The live consumer passes Nearby managed tags as a reader (GL#97); the skip line must still name
  // the tags the write would have deactivated, not a function.
  it('off: the updateMember skip line carries the managed tags read from the member', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = outboundDeps();
    deps.config = { ...CONFIG, monday: { ...CONFIG.monday, columns: { ...CONFIG.monday.columns, nearby: 'nearby' } } };
    deps.mailchimpClient = fakeMailchimp({ getMemberTagNames: vi.fn().mockResolvedValue(['Near: Old']) });
    await consumeOutboundBatch([outMsg({ donorItemId: '1' })], deps, { ...gate('off'), logLevel: 'debug' });
    expect(deps.mailchimpClient.updateMember).not.toHaveBeenCalled();
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"operation":"updateMember"'));
    expect(line).toContain('Near: Old');
  });

  it('a dropped-stamped message is a dry run even when writes are on', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = outboundDeps();
    const message = outMsg({ donorItemId: '1', writeStamp: 'dropped' });
    await consumeOutboundBatch([message], deps, gate('on'));
    expect(deps.mailchimpClient.updateMember).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    // The one pending write a dry run makes: close the row out so nothing revives it.
    expect(deps.pendingStore.updateStatus).toHaveBeenCalledWith('1', 'dropped');
  });

  it('hold: retries at 60 s without touching any sink', async () => {
    const deps = outboundDeps();
    const message = outMsg({ donorItemId: '1' });
    await consumeOutboundBatch([message], deps, gate('hold'));
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(deps.mondayClient.getDonorById).not.toHaveBeenCalled();
    expect(deps.mailchimpClient.updateMember).not.toHaveBeenCalled();
  });

  it('unknown behaves like hold', async () => {
    const deps = outboundDeps();
    const message = outMsg({ donorItemId: '1' }, 3);
    await consumeOutboundBatch([message], deps, gate('unknown'));
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
  });

  it('on: an unstamped legacy message writes', async () => {
    const deps = outboundDeps();
    const message = outMsg({ donorItemId: '1' });
    await consumeOutboundBatch([message], deps, gate('on'));
    expect(deps.mailchimpClient.updateMember).toHaveBeenCalledOnce();
    expect(deps.mailchimpClient.unsubscribeMember).toHaveBeenCalledOnce();
    expect(deps.dnsLog.record).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('on: a MailchimpPermanentError still acks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = outboundDeps();
    deps.mailchimpClient = fakeMailchimp({ updateMember: vi.fn().mockRejectedValue(new MailchimpPermanentError('bad address')) });
    const message = outMsg({ donorItemId: '1' });
    await consumeOutboundBatch([message], deps, gate('on'));
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('on: a 429 with Retry-After 7200 retries at 7200', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = outboundDeps();
    deps.mailchimpClient = fakeMailchimp({ updateMember: vi.fn().mockRejectedValue(new MailchimpRateLimitError('429', 7200)) });
    const message = outMsg({ donorItemId: '1' });
    await consumeOutboundBatch([message], deps, gate('on'));
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 7200 });
  });
});

describe('inbound consumer', () => {
  it('off: no Monday write, ack, and the skip lines name the member by hash, never the address', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = inboundDeps();
    const message = inMsg({ email: EMAIL });
    await consumeInboundBatch([message], deps, gate('off'));
    expect(deps.mondayClient.setConnectColumn).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    const out = logged(log);
    expect(out).toContain('"operation":"setConnectColumn"');
    expect(out).toContain('<member ');
    expect(out).not.toContain('@');
    expect(deps.pendingStore.updateStatus).toHaveBeenCalledTimes(1);
    expect(deps.pendingStore.updateStatus).toHaveBeenCalledWith(EMAIL, 'dropped');
  });

  it('off: an unknown interest reconciles against proxies and still reaches the connect-column skip line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = inboundDeps([]);
    deps.mailchimpClient = fakeMailchimp({ listInterests: vi.fn().mockResolvedValue([{ categoryId: 'c', interestId: 'int1', name: 'Newsletter' }]) });
    const message = inMsg({ email: EMAIL });
    await consumeInboundBatch([message], deps, gate('off'));
    expect(deps.mondayClient.createCampaignItem).not.toHaveBeenCalled();
    expect(deps.campaignItemsStore.upsert).not.toHaveBeenCalled();
    expect(deps.mondayClient.setConnectColumn).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    const out = logged(log);
    expect(out).toContain('"operation":"createCampaignItem"');
    expect(out).toContain('"operation":"setConnectColumn"');
    expect(out).not.toContain('@');
  });

  it('hold: retries at 60 s without any call', async () => {
    const deps = inboundDeps();
    const message = inMsg({ email: EMAIL });
    await consumeInboundBatch([message], deps, gate('hold'));
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(deps.mailchimpClient.getMemberInterests).not.toHaveBeenCalled();
  });

  it('on: an unstamped legacy message writes', async () => {
    const deps = inboundDeps();
    const message = inMsg({ email: EMAIL });
    await consumeInboundBatch([message], deps, gate('on'));
    expect(deps.mondayClient.setConnectColumn).toHaveBeenCalledWith(111, 'donor-1', 'mc', ['campaign-1']);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('on: a MailchimpPermanentError still acks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = inboundDeps();
    deps.mailchimpClient = fakeMailchimp({ getMemberInterests: vi.fn().mockRejectedValue(new MailchimpPermanentError('bad')) });
    const message = inMsg({ email: EMAIL });
    await consumeInboundBatch([message], deps, gate('on'));
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('on: a 429 with Retry-After 7200 retries at 7200', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = inboundDeps();
    deps.mailchimpClient = fakeMailchimp({ getMemberInterests: vi.fn().mockRejectedValue(new MailchimpRateLimitError('429', 7200)) });
    const message = inMsg({ email: EMAIL });
    await consumeInboundBatch([message], deps, gate('on'));
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 7200 });
  });
});

describe('scheduled reconcile', () => {
  function reconcileDeps() {
    return {
      mailchimpClient: fakeMailchimp({ listInterests: vi.fn().mockResolvedValue([{ categoryId: 'c', interestId: 'int9', name: 'New' }]) }),
      mondayClient: fakeMonday(),
      campaignItemsStore: fakeCampaignItemsStore([]),
      config: CONFIG,
    };
  }

  it('hold: skips, with one line, calling nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reconcile = vi.fn();
    await runScheduledReconcile(gate('hold'), reconcileDeps(), reconcile);
    expect(reconcile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('unknown: skips', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reconcile = vi.fn();
    await runScheduledReconcile(gate('unknown'), reconcileDeps(), reconcile);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('off: runs against recording proxies — no Monday create, no store write', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = reconcileDeps();
    const { reconcileCampaigns } = await import('./campaigns/reconcile');
    await runScheduledReconcile(gate('off'), deps, reconcileCampaigns);
    expect(deps.mondayClient.createCampaignItem).not.toHaveBeenCalled();
    expect(deps.campaignItemsStore.upsert).not.toHaveBeenCalled();
    expect(logged(log)).toContain('"operation":"createCampaignItem"');
  });

  it('on: runs with the real deps', async () => {
    const reconcile = vi.fn().mockResolvedValue({ created: 0, renamed: 0, archived: 0 });
    const deps = reconcileDeps();
    await runScheduledReconcile(gate('on'), deps, reconcile);
    expect(reconcile).toHaveBeenCalledWith(deps);
  });

  it('no Campaigns board configured: skips with one line instead of failing every night', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reconcile = vi.fn();
    const deps = { ...reconcileDeps(), config: { ...CONFIG, monday: { ...CONFIG.monday, campaignsBoardId: null } } };
    await runScheduledReconcile(gate('on'), deps, reconcile);
    expect(reconcile).not.toHaveBeenCalled();
    expect(logged(log)).toContain('no Campaigns board');
  });
});

describe('a failing dropped-status write', () => {
  it('outbound: retries that message at the backoff, runs no dry-run body, and still handles the next one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = outboundDeps();
    deps.pendingStore = {
      upsertPending: vi.fn(),
      updateStatus: vi.fn().mockRejectedValueOnce(new Error('D1 unavailable')).mockResolvedValue(undefined),
      lastSyncStartedAt: vi.fn().mockResolvedValue(null),
      recordSyncStart: vi.fn(),
    };
    const first = outMsg({ donorItemId: '1' }, 2);
    const second = outMsg({ donorItemId: '2' });
    await consumeOutboundBatch([first, second], deps, gate('off'));
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(first.ack).not.toHaveBeenCalled();
    expect(deps.mondayClient.getDonorById).toHaveBeenCalledTimes(1);
    expect(second.ack).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('could not record dropped status'));
  });

  it('inbound: retries that message at the backoff, runs no dry-run body, and still handles the next one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = inboundDeps();
    deps.pendingStore = {
      upsertPending: vi.fn(),
      updateStatus: vi.fn().mockRejectedValueOnce(new Error('D1 unavailable')).mockResolvedValue(undefined),
    };
    const first = inMsg({ email: EMAIL }, 3);
    const second = inMsg({ email: 'other@example.com' });
    await consumeInboundBatch([first, second], deps, gate('off'));
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
    expect(first.ack).not.toHaveBeenCalled();
    expect(deps.mailchimpClient.getMemberInterests).toHaveBeenCalledTimes(1);
    expect(second.ack).toHaveBeenCalledOnce();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('@');
  });
});
