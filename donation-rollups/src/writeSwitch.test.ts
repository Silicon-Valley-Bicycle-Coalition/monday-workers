import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createApp } from './webhook/route';
import { consumeRecomputeBatch, type ProcessBatchDeps } from './consumer/processBatch';
import { runDuty, type CustodianDeps, type CustodianMondayClient } from './custodian/custodian';
import { D1PendingStore } from './db/pending';
import { D1DonationLinksStore } from './db/links';
import { D1GiftsStore } from './db/gifts';
import { D1VolunteerActivityStore } from './db/volunteerActivity';
import { D1OwnerRecomputesStore } from './db/ownerRecomputes';
import { D1RollCallCreditsStore } from './db/rollCallCredits';
import { D1AffiliationsStore } from './db/affiliations';
import { DEFAULT_PII_KEYS, type WriteMode } from './flags';
import type { BatchSkipContext } from './writeSwitch';
import type { DonationRollupsMondayClient } from './monday/client';
import type { DonationRollupsConfig, RecomputeQueueMessage } from './types';

// End to end on the real D1 (spec 2026-10-26 anti-goal: "a delivery received while `off` written
// later"): a delivery the write switch dry-ran — at ingest or at consume time — must never come
// back as a live recompute through the nightly requeue.

const config: DonationRollupsConfig = {
  monday: { apiUrl: 'https://x', accountUrl: 'https://acme.monday.com' },
  fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
  custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null,
    annualSummaryBoardId: null, annualSummaryColumns: null },
  affiliations: null,
  donationRollups: {
    donationBoards: [{ boardId: 100, columns: { donorLink: 'd', amount: 'a', date: 'dt', status: 's', fiscalYear: 'fy', actingForLink: null, classification: null } }],
    receivedStatusLabel: 'Received',
    ownerColumnsByBoard: {},
    membership: null,
    donorLevel: null,
    volunteerBoards: [],
    historicalVolunteerBoards: [],
    recurringGifts: null, rollCall: null,
  },
};

const gate = (mode: WriteMode): BatchSkipContext =>
  ({ worker: 'donation-rollups', environment: 'production', mode, logLevel: 'normal', piiKeys: DEFAULT_PII_KEYS });

const pending = () => new D1PendingStore(env.DB);
const statusOf = async (id: string) =>
  (await env.DB.prepare('SELECT status FROM pending_recomputes WHERE donation_item_id = ?1').bind(id).first<{ status: string }>())?.status;

function webhook(mode: WriteMode, sent: RecomputeQueueMessage[]) {
  return createApp({
    writeMode: async () => mode, pendingStore: pending(), queue: { send: async (m) => { sent.push(m); } },
    donationBoardIds: new Set(['100']), registrationBoards: new Map(), ignoredColumnIds: new Set(), webhookSecret: 'shh',
  });
}
const deliver = (app: ReturnType<typeof createApp>, pulseId: number) => app.request('/webhooks/monday/donations?secret=shh', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ event: { type: 'create_pulse', pulseId, boardId: 100 } }),
});

// A donation whose item was deleted on Monday: the consumer detaches it — no owner to recompute,
// so the only Monday traffic is the two reads, and a live run ends with the row 'written'.
function consumerDeps(pendingStore = pending()): ProcessBatchDeps {
  const mondayClient = {
    getDonorLinkForDonation: vi.fn(async () => null),
    getDonationState: vi.fn(async () => 'deleted' as const),
  } as unknown as DonationRollupsMondayClient;
  return {
    pendingStore, linksStore: new D1DonationLinksStore(env.DB), giftsStore: new D1GiftsStore(env.DB),
    volunteerStore: new D1VolunteerActivityStore(env.DB), recomputesStore: new D1OwnerRecomputesStore(env.DB),
    affiliationsStore: new D1AffiliationsStore(env.DB), mondayClient, config,
  };
}
const message = (body: RecomputeQueueMessage) => ({ body, ack: vi.fn(), retry: vi.fn() });

// The nightly requeue, live, two days after the deliveries above.
async function requeueLive(): Promise<RecomputeQueueMessage[]> {
  const sent: RecomputeQueueMessage[] = [];
  const deps: CustodianDeps = {
    gifts: new D1GiftsStore(env.DB), pending: pending(), volunteers: new D1VolunteerActivityStore(env.DB),
    recomputes: new D1OwnerRecomputesStore(env.DB), rollCallCredits: new D1RollCallCreditsStore(env.DB), mondayClient: {} as CustodianMondayClient,
    queue: { sendBatch: async (msgs) => { sent.push(...msgs); } }, config,
    now: new Date(Date.now() + 2 * 86_400_000),
  };
  await runDuty('requeue', deps);
  return sent;
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM pending_recomputes'), env.DB.prepare('DELETE FROM custodian_runs')]);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a dry-run delivery is never requeued as live work', () => {
  it('ingested under off: the row is dropped, and the requeue under on sends nothing', async () => {
    const sent: RecomputeQueueMessage[] = [];
    await deliver(webhook('off', sent), 701);
    expect(sent).toEqual([{ donationItemId: '701', donationBoardId: '100', writeStamp: 'dropped' }]);
    expect(await statusOf('701')).toBe('dropped');

    expect(await requeueLive()).toEqual([]);
  });

  it('ingested live but consumed under off: the row ends dropped with no other pending write, and the requeue under on sends nothing', async () => {
    const sent: RecomputeQueueMessage[] = [];
    await deliver(webhook('on', sent), 702);
    expect(await statusOf('702')).toBe('queued');

    const store = pending();
    const updateStatus = vi.spyOn(store, 'updateStatus');
    const upsertPending = vi.spyOn(store, 'upsertPending');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = message(sent[0]!);
    await consumeRecomputeBatch([m], consumerDeps(store), gate('off'));

    expect(m.ack).toHaveBeenCalled();
    expect(updateStatus.mock.calls).toEqual([['702', 'dropped', undefined]]);
    expect(upsertPending).not.toHaveBeenCalled();
    expect(await statusOf('702')).toBe('dropped');
    expect(await requeueLive()).toEqual([]);
  });

  it('a later delivery for the same item under on resets the row and is processed normally', async () => {
    await deliver(webhook('off', []), 703);
    expect(await statusOf('703')).toBe('dropped');

    const sent: RecomputeQueueMessage[] = [];
    await deliver(webhook('on', sent), 703);
    expect(sent).toEqual([{ donationItemId: '703', donationBoardId: '100' }]);
    expect(await statusOf('703')).toBe('queued');

    const deps = consumerDeps();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = message(sent[0]!);
    await consumeRecomputeBatch([m], deps, gate('on'));
    expect(m.ack).toHaveBeenCalled();
    expect(deps.mondayClient.getDonationState).toHaveBeenCalledWith('703');
    expect(await statusOf('703')).toBe('written');
  });
});
