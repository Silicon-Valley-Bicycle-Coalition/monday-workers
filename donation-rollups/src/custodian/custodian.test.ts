import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { D1GiftsStore } from '../db/gifts';
import { D1DonationLinksStore } from '../db/links';
import { D1PendingStore } from '../db/pending';
import { D1VolunteerActivityStore } from '../db/volunteerActivity';
import { D1OwnerRecomputesStore } from '../db/ownerRecomputes';
import { D1RollCallCreditsStore } from '../db/rollCallCredits';
import { dutiesForDate, runDuty, runScheduled, RECONCILE_AFFILIATIONS_PER_RUN, RECONCILE_PERSONS_PER_RUN,
  type CustodianDeps, type CustodianMondayClient, type BoardCapacity } from './custodian';
import type { DonationRollupsConfig, RecomputeQueueMessage, SponsorshipsConfig } from '../types';
import { DEFAULT_PII_KEYS, type WriteMode } from '../flags';
import type { BatchSkipContext } from '../writeSwitch';
import { WriteBudget } from './writeBudget';

const OWNER_COLS = {
  giftLedgerJson: 'col_glj', lifetimeGiving: 'col_lt', giftCount: 'col_gc', firstGift: 'col_fg',
  thisYearAmount: 'c', thisYearCount: 'c', lastYearAmount: 'c', lastYearCount: 'c',
  largestGift: 'c', smallestGift: 'c', averageGift: 'c', lastGiftDate: 'c', lastGiftAmount: 'c',
};

function testConfig(over: Partial<DonationRollupsConfig['custodian']> = {}): DonationRollupsConfig {
  return {
    monday: { apiUrl: 'https://x', accountUrl: 'https://acme.monday.com' },
    fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
    custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null,
      annualSummaryBoardId: null, annualSummaryColumns: null, ...over },
    affiliations: null,
    donationRollups: {
      donationBoards: [{ boardId: 100, columns: { donorLink: 'd', amount: 'a', date: 'dt', status: 's', fiscalYear: 'fy', actingForLink: null, classification: null } }],
      receivedStatusLabel: 'Received',
      ownerColumnsByBoard: { 'b1': OWNER_COLS },
      membership: null,
      donorLevel: null,
      volunteerBoards: [],
      historicalVolunteerBoards: [],
      recurringGifts: null, rollCall: null, sponsorships: null,
    },
  };
}

interface FakeClientState {
  archived: string[];
  archiveFailFor?: Set<string>;
  boards?: BoardCapacity[];
  // Raw column text per item id, the way getItemsColumnsText reads it back.
  // (undefined allowed so mixed-shape Map literals infer cleanly; the fake nulls it.)
  columnText?: Map<string, Record<string, string | null | undefined>>;
  updates: { itemId: number; body: string }[];
  createdItems?: { boardId: number; name: string; columnValues: Record<string, unknown> }[];
  changedColumns?: { boardId: number; itemId: string; columnValues: Record<string, unknown> }[];
  // Every getItemsColumnsText call this client saw, in order — lets tests assert which
  // columns (and so which legs) actually spent a Monday subrequest in a given run.
  calls?: { itemIds: string[]; columnIds: string[] }[];
}

function fakeClient(state: FakeClientState): CustodianMondayClient {
  return {
    async archiveItem(itemId) {
      if (state.archiveFailFor?.has(itemId)) throw new Error(`boom ${itemId}`);
      state.archived.push(itemId);
    },
    async listWorkspaceBoards() { return state.boards ?? []; },
    async getItemsColumnsText(itemIds, columnIds) {
      (state.calls ??= []).push({ itemIds: [...itemIds], columnIds: [...columnIds] });
      const out = new Map<string, Map<string, string | null>>();
      for (const id of itemIds) {
        const rec = state.columnText?.get(id);
        if (rec === undefined) continue; // like the real client, absent items just aren't in the map
        out.set(id, new Map(columnIds.map((c) => [c, rec[c] ?? null])));
      }
      return out;
    },
    async createUpdate(itemId, body) { state.updates.push({ itemId, body }); },
    async createItem(boardId, name, columnValues) {
      (state.createdItems ??= []).push({ boardId, name, columnValues });
      return `summary-${name}`;
    },
    async pageItemsColumnsText() { return { items: [], cursor: null }; },
    async changeColumnValues(boardId, itemId, columnValues) {
      (state.changedColumns ??= []).push({ boardId, itemId, columnValues });
    },
    async pageRegistrations() { return { items: [], cursor: null }; },
    async pageHistoricalShifts() { return { items: [], cursor: null }; },
    async getItemsBoardIds() { return new Map(); },
    async pageRecurringGifts() { return { items: [], cursor: null }; },
    async pageDonationCredits() { return { items: [], cursor: null }; },
    async getItemsState() { return new Map(); },
    async listGroups() { return []; },
    async createGroup() { return 'group'; },
    async updateGroupTitle() {},
    async createItemInGroup() { return 'item'; },
    async moveItemToGroup() {},
    async deleteItem() {},
  };
}

function deps(state: FakeClientState, sent: RecomputeQueueMessage[], config = testConfig()): CustodianDeps {
  return {
    gifts: new D1GiftsStore(env.DB),
    pending: new D1PendingStore(env.DB),
    volunteers: new D1VolunteerActivityStore(env.DB),
    recomputes: new D1OwnerRecomputesStore(env.DB), rollCallCredits: new D1RollCallCreditsStore(env.DB),
    mondayClient: fakeClient(state),
    queue: { sendBatch: async (msgs) => { sent.push(...msgs); } },
    config,
    now: new Date('2026-08-01T00:00:00Z'), // FY2027 → cutoff FY2026 with activeFiscalYears 2
  };
}

// Custodian duties aggregate over whole tables — every test here starts from a clean slate.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM gifts'),
    env.DB.prepare('DELETE FROM annual_summaries'),
    env.DB.prepare('DELETE FROM custodian_runs'),
    env.DB.prepare('DELETE FROM donation_links'),
    env.DB.prepare('DELETE FROM pending_recomputes'),
    env.DB.prepare('DELETE FROM affiliations'),
  ]);
});

const seedGift = (db: D1Database, id: string, over: Partial<{ owner: string; fy: number; cents: number; status: string; archivedAt: string | null; actingFor: string | null }> = {}) =>
  db.prepare(`INSERT INTO gifts (monday_item_id, owner_item_id, owner_board_id, amount_cents, gift_date,
    fiscal_year, status, archived_at, acting_for_item_id, source, updated_at)
    VALUES (?1, ?2, 'b1', ?3, '2020-01-01', ?4, ?5, ?6, ?7, 'import', 'now')`)
    .bind(id, over.owner ?? 'o1', over.cents ?? 1000, over.fy ?? 2020, over.status ?? 'Received', over.archivedAt ?? null, over.actingFor ?? null)
    .run();

describe('dutiesForDate', () => {
  const FY = { startMonth: 7, timeZone: 'America/Los_Angeles' };

  it('takes its calendar from config: sweep on day 1 and archive on day 15 of the fiscal start month', () => {
    const april = { startMonth: 4, timeZone: 'America/Los_Angeles' };
    expect(dutiesForDate(new Date('2026-04-01T09:00:00Z'), april)).toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall', 'sweep']);
    expect(dutiesForDate(new Date('2026-04-15T09:00:00Z'), april)).toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall', 'archive']);
    expect(dutiesForDate(new Date('2026-07-01T09:00:00Z'), april)).toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall']);
  });

  it('reads "today" in the configured time zone, not UTC', () => {
    // 01:00 UTC July 1 is still June 30 in Pacific time; 01:00 UTC July 2 is July 1 there.
    expect(dutiesForDate(new Date('2026-07-01T01:00:00Z'), FY)).toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall']);
    expect(dutiesForDate(new Date('2026-07-02T01:00:00Z'), FY)).toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall', 'sweep']);
    // 01:00 UTC Tuesday 2026-08-04 is Monday evening in Pacific time.
    expect(dutiesForDate(new Date('2026-08-04T01:00:00Z'), FY)).toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall', 'capacity']);
  });

  it('membership runs nightly', () => {
    expect(dutiesForDate(new Date('2026-03-04T12:00:00Z'), { startMonth: 7, timeZone: 'America/Los_Angeles' })).toContain('membership');
  });

  it('reconciles daily, checks capacity Mondays, sweeps July 1, archives July 15', () => {
    // requeue (fix 5) rides every night with reconcile.
    expect(dutiesForDate(new Date('2026-08-05T09:00:00Z'), FY)).toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall']); // a Wednesday
    expect(dutiesForDate(new Date('2026-08-03T09:00:00Z'), FY)).toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall', 'capacity']); // a Monday
    expect(dutiesForDate(new Date('2026-07-01T09:00:00Z'), FY)).toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall', 'sweep']);
    expect(dutiesForDate(new Date('2026-07-15T09:00:00Z'), FY)).toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall', 'archive']);
  });

  const SPON = (yearBasis: 'calendar' | 'fiscal'): SponsorshipsConfig =>
    ({ organizationsBoardId: 5, giftTypes: ['Sponsorship'], inKindGiftTypes: [], yearBasis, windowYears: 3, pipelineBoards: {} });
  const NIGHTLY = ['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall'];

  it('dutiesForDate runs sponsorships nightly when configured', () => {
    expect(dutiesForDate(new Date('2026-08-05T09:00:00Z'), FY, [], SPON('fiscal'))).toEqual([...NIGHTLY, 'sponsorships']);
  });

  it('re-runs sponsorships while its last report has remaining > 0 (once)', () => {
    const lastRuns = [{ duty: 'sponsorships', report: { detail: { backfilled: 5000, remaining: 40 } } }];
    expect(dutiesForDate(new Date('2026-08-05T09:00:00Z'), FY, lastRuns, SPON('fiscal')).filter((d) => d === 'sponsorships')).toEqual(['sponsorships']);
  });

  it('adds sweep on January 1 when yearBasis is calendar', () => {
    expect(dutiesForDate(new Date('2027-01-01T09:00:00Z'), FY, [], SPON('calendar'))).toEqual([...NIGHTLY, 'sponsorships', 'sweep']);
    // 2027-01-01T06:00Z is still Dec 31 in Los Angeles
    expect(dutiesForDate(new Date('2027-01-01T06:00:00Z'), FY, [], SPON('calendar'))).toEqual([...NIGHTLY, 'sponsorships']);
  });

  it('does not double the sweep when January 1 is also the fiscal start', () => {
    const jan = { startMonth: 1, timeZone: 'America/Los_Angeles' };
    expect(dutiesForDate(new Date('2027-01-01T09:00:00Z'), jan, [], SPON('calendar')).filter((d) => d === 'sweep')).toEqual(['sweep']);
  });

  it('does not add a January sweep for fiscal basis or when sponsorships is null', () => {
    expect(dutiesForDate(new Date('2027-01-01T09:00:00Z'), FY, [], SPON('fiscal'))).toEqual([...NIGHTLY, 'sponsorships']);
    expect(dutiesForDate(new Date('2027-01-01T09:00:00Z'), FY)).toEqual(NIGHTLY);
  });

  it('continues an incomplete sweep on subsequent days while its last run reports remaining > 0', async () => {
    const gifts = new D1GiftsStore(env.DB);
    await gifts.recordRun({ duty: 'sweep', ranAt: '2026-07-01T09:00:00Z', ok: true,
      report: { ok: true, summary: 'sliced', detail: { enqueued: 3500, remaining: 900, cursor: 'o3500' } } });
    expect(dutiesForDate(new Date('2026-07-02T09:00:00Z'), FY, await gifts.lastRuns()))
      .toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall', 'sweep']);
  });

  it('does not re-run a sweep whose last run completed (remaining === 0)', async () => {
    const gifts = new D1GiftsStore(env.DB);
    await gifts.recordRun({ duty: 'sweep', ranAt: '2026-07-01T09:00:00Z', ok: true,
      report: { ok: true, summary: 'done', detail: { enqueued: 900, remaining: 0, cursor: 'o4400' } } });
    expect(dutiesForDate(new Date('2026-07-02T09:00:00Z'), FY, await gifts.lastRuns()))
      .toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall']);
  });

  it('only the MOST RECENT run of a duty counts — an old incomplete run superseded by a complete one stays finished', async () => {
    const gifts = new D1GiftsStore(env.DB);
    await gifts.recordRun({ duty: 'archive', ranAt: '2026-07-15T09:00:00Z', ok: true,
      report: { ok: true, summary: 'sliced', detail: { remaining: 5 } } });
    await gifts.recordRun({ duty: 'archive', ranAt: '2026-07-16T09:00:00Z', ok: true,
      report: { ok: true, summary: 'done', detail: { remaining: 0 } } });
    expect(dutiesForDate(new Date('2026-07-17T09:00:00Z'), FY, await gifts.lastRuns()))
      .toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall']);
  });

  it('never doubles a duty its start date already scheduled', async () => {
    const gifts = new D1GiftsStore(env.DB);
    await gifts.recordRun({ duty: 'sweep', ranAt: '2026-06-30T09:00:00Z', ok: true,
      report: { ok: true, summary: 'sliced', detail: { remaining: 10 } } });
    expect(dutiesForDate(new Date('2026-07-01T09:00:00Z'), FY, await gifts.lastRuns()))
      .toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall', 'sweep']);
  });

  it('keeps rollcall in the list, once, while its last run reports remaining > 0', async () => {
    const gifts = new D1GiftsStore(env.DB);
    await gifts.recordRun({ duty: 'rollcall', ranAt: '2026-08-04T09:00:00Z', ok: true,
      report: { ok: true, summary: 'capped', detail: { rows: 900, applied: 500, remaining: 400 } } });
    const duties = dutiesForDate(new Date('2026-08-05T09:00:00Z'), FY, await gifts.lastRuns());
    expect(duties.filter((d) => d === 'rollcall')).toEqual(['rollcall']);
  });

  it('archive continues daily until complete, and summaries materialize on the run that hits remaining 0', async () => {
    // 41 archivable gifts with ARCHIVE_PER_RUN = 40: the July 15 run leaves remaining 1
    // and no summaries; the daily cron must then keep scheduling archive until a run
    // reports remaining 0 — which is the run that materializes the annual summaries.
    for (let i = 0; i < 41; i++) await seedGift(env.DB, `c${String(i).padStart(2, '0')}`, { fy: 2015 });
    const state: FakeClientState = { archived: [], updates: [] };
    const d = deps(state, []);
    const gifts = d.gifts;

    const first = await runDuty('archive', d); // the July 15 start run
    expect((first.detail as { remaining: number }).remaining).toBe(1);
    expect(await gifts.getAnnualSummaries()).toEqual([]);

    // July 16: the daily cron sees the incomplete run and continues it.
    expect(dutiesForDate(new Date('2026-07-16T09:00:00Z'), FY, await gifts.lastRuns()))
      .toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall', 'archive']);
    d.now = new Date('2026-08-02T00:00:00Z'); // a later ran_at, so lastRuns sees THIS run as most recent
    const second = await runDuty('archive', d);
    expect((second.detail as { remaining: number }).remaining).toBe(0);
    expect((await gifts.getAnnualSummaries()).map((s) => s.fiscalYear)).toEqual([2015]);

    // July 17: complete — archive drops back out of the schedule.
    expect(dutiesForDate(new Date('2026-07-17T09:00:00Z'), FY, await gifts.lastRuns()))
      .toEqual(['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall']);
  });
});

describe('archive duty', () => {
  it('archives active gifts before the cutoff, marks them, and materializes summaries — idempotently', async () => {
    await seedGift(env.DB, 'a1', { fy: 2015, cents: 500 });
    await seedGift(env.DB, 'a2', { fy: 2026 }); // retained
    await seedGift(env.DB, 'a3', { fy: 2014, archivedAt: 'earlier' }); // already archived
    const state: FakeClientState = { archived: [], updates: [] };
    const d = deps(state, []);

    const report = await runDuty('archive', d);
    expect(report.ok).toBe(true);
    expect(state.archived).toEqual(['a1']);
    const summaries = await d.gifts.getAnnualSummaries();
    expect(summaries.map((s) => [s.fiscalYear, s.totalCents])).toEqual([[2014, 1000], [2015, 500]]);

    // Re-run: nothing to archive, no summary changes, still ok.
    state.archived = [];
    const again = await runDuty('archive', d);
    expect(again.ok).toBe(true);
    expect(state.archived).toEqual([]);
  });

  it('slices oversized backlogs, defers summaries, and finishes on the follow-up run', async () => {
    for (let i = 0; i < 41; i++) await seedGift(env.DB, `s${String(i).padStart(2, '0')}`, { fy: 2015 });
    const state: FakeClientState = { archived: [], updates: [] };
    const d = deps(state, []);

    const first = await runDuty('archive', d);
    expect(first.ok).toBe(true);
    expect((first.detail as { remaining: number }).remaining).toBe(1);
    expect(state.archived).toHaveLength(40);
    expect(await d.gifts.getAnnualSummaries()).toEqual([]); // not materialized mid-backlog

    const second = await runDuty('archive', d);
    expect((second.detail as { remaining: number }).remaining).toBe(0);
    expect((await d.gifts.getAnnualSummaries()).map((s) => s.fiscalYear)).toEqual([2015]);
  });

  it('stops at the run\'s shared write budget and continues on the next run (issue #90)', async () => {
    for (const id of ['a1', 'a2', 'a3']) await seedGift(env.DB, id, { fy: 2015 });
    const state: FakeClientState = { archived: [], updates: [] };
    const d = { ...deps(state, []), writeBudget: new WriteBudget(2) };
    const report = await runDuty('archive', d);
    expect(state.archived).toEqual(['a1', 'a2']);
    expect(report.detail).toMatchObject({ archived: 2, remaining: 1 });
    expect(await d.gifts.getArchivable(2026)).toEqual([{ mondayItemId: 'a3', fiscalYear: 2015 }]);
  });

  it('a failed archive keeps the gift active in the ledger and reports not-ok', async () => {
    await seedGift(env.DB, 'f1', { fy: 2015 });
    const state: FakeClientState = { archived: [], archiveFailFor: new Set(['f1']), updates: [] };
    const d = deps(state, []);
    const report = await runDuty('archive', d);
    expect(report.ok).toBe(false);
    expect(await d.gifts.getArchivable(2026)).toEqual([{ mondayItemId: 'f1', fiscalYear: 2015 }]);
  });
});

describe('annual summary board sync', () => {
  const SUMMARY_CFG = testConfig({
    annualSummaryBoardId: 777,
    annualSummaryColumns: { fiscalYear: 'c_fy', total: 'c_total', giftCount: 'c_n', byType: 'c_bt', restatedAt: 'c_re' },
  });

  it('creates one item per closed year, remembers ids, and only rewrites restated years', async () => {
    await seedGift(env.DB, 'sb1', { fy: 2015, cents: 500 });
    await seedGift(env.DB, 'sb2', { fy: 2016, cents: 700 });
    const state: FakeClientState = { archived: [], updates: [] };
    const d = deps(state, [], SUMMARY_CFG);

    const first = await runDuty('archive', d);
    expect((first.detail as { boardItemsWritten: number }).boardItemsWritten).toBe(2);
    expect(state.createdItems!.map((c) => [c.boardId, c.name])).toEqual([[777, 'FY2015'], [777, 'FY2016']]);
    expect(state.createdItems![0]!.columnValues).toMatchObject({ c_fy: '2015', c_total: '5.00', c_n: '1', c_re: null });
    const stored = await d.gifts.getAnnualSummaries();
    expect(stored.map((s) => s.mondayItemId)).toEqual(['summary-FY2015', 'summary-FY2016']);

    // Idempotent re-run: nothing new created, nothing rewritten.
    state.createdItems = [];
    const again = await runDuty('archive', d);
    expect((again.detail as { boardItemsWritten: number }).boardItemsWritten).toBe(0);

    // An audit restatement (ledger changed for a closed year) rewrites just that item.
    await env.DB.prepare(`UPDATE gifts SET amount_cents = 999 WHERE monday_item_id = 'sb1'`).run();
    const restated = await runDuty('archive', d);
    expect((restated.detail as { boardItemsWritten: number }).boardItemsWritten).toBe(1);
    expect(state.changedColumns).toHaveLength(1);
    expect(state.changedColumns![0]).toMatchObject({ boardId: 777, itemId: 'summary-FY2015' });
    expect(state.changedColumns![0]!.columnValues).toMatchObject({ c_total: '9.99', c_re: { date: expect.any(String) } });
  });
});

describe('capacity duty', () => {
  it('flags boards at or over the alert threshold and posts the alert update', async () => {
    const state: FakeClientState = {
      archived: [], updates: [],
      boards: [
        { id: '1', name: 'Fine', itemsCount: 100, itemsLimit: 10000 },
        { id: '2', name: 'Hot', itemsCount: 9000, itemsLimit: 10000 },
        { id: '3', name: 'No limit', itemsCount: 5, itemsLimit: null },
      ],
    };
    const d = deps(state, [], testConfig({ alertItemId: 42 }));
    const report = await runDuty('capacity', d);
    expect(report.ok).toBe(false);
    expect(report.summary).toContain('Hot at 90%');
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.itemId).toBe(42);
  });

  it('reports ATTENTION, not ok, when the workspace lists no boards (blind alarm)', async () => {
    const state: FakeClientState = { archived: [], updates: [], boards: [] };
    const d = deps(state, [], testConfig({ alertItemId: 42 }));
    const report = await runDuty('capacity', d);
    expect(report.ok).toBe(false);
    expect(report.summary).toContain('blind');
  });
});

describe('sweep duty', () => {
  it('enqueues one representative recompute per owner', async () => {
    const links = new D1DonationLinksStore(env.DB);
    await links.upsertLink({ donationItemId: 'd1', donationBoardId: '100', ownerItemId: 'oA', ownerBoardId: 'b1' }, 'now');
    await links.upsertLink({ donationItemId: 'd2', donationBoardId: '100', ownerItemId: 'oA', ownerBoardId: 'b1' }, 'now');
    await links.upsertLink({ donationItemId: 'd3', donationBoardId: '100', ownerItemId: 'oB', ownerBoardId: 'b1' }, 'now');
    const sent: RecomputeQueueMessage[] = [];
    const report = await runDuty('sweep', deps({ archived: [], updates: [] }, sent));
    expect(report.ok).toBe(true);
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((m) => m.donationItemId))).toEqual(new Set(['d1', 'd3']));
    expect(sent.every((m) => m.sweep === true)).toBe(true);
    // Issue GL#88: owner-keyed, so the consumer needn't resolve the owner from the gift.
    expect(sent.map((m) => [m.ownerItemId, m.ownerBoardId])).toEqual([['oA', 'b1'], ['oB', 'b1']]);
  });
});

// Issue GL#88: the fiscal-start sweep only moves This/Last Year, so it recomputes the owners whose
// totals the rollover changes, paced under the account's 10,000/day Monday call cap.
describe('sweep duty on the fiscal start (rollover scope and pacing)', () => {
  const insertGift = (id: string, owner: string, board: string, fy: number, type = 'Individual', removed: string | null = null) =>
    env.DB.prepare(`INSERT INTO gifts (monday_item_id, owner_item_id, owner_board_id, amount_cents, gift_date,
      fiscal_year, status, gift_type, removed_at, source, updated_at) VALUES (?1, ?2, ?3, 1000, '2026-03-01', ?4, 'Received', ?5, ?6, 'import', 'now')`)
      .bind(id, owner, board, fy, type, removed).run();
  const link = (d: string, o: string, b = 'b1') =>
    new D1DonationLinksStore(env.DB).upsertLink({ donationItemId: d, donationBoardId: '100', ownerItemId: o, ownerBoardId: b }, 'now');
  const JULY_1 = new Date('2026-07-01T18:00:00Z'); // FY2027 begins: This Year 2026 -> 2027, Last Year 2025 -> 2026

  it('on July 1 enqueues only owners with a live gift in the fiscal years the rollover moves', async () => {
    for (const [d, o, fy, removed] of [['d1', 'gaveLastYear', 2026, null], ['d2', 'gaveTwoYearsAgo', 2025, null],
      ['d3', 'lapsed', 2024, null], ['d4', 'removedOnly', 2026, 'gone']] as [string, string, number, string | null][]) {
      await link(d, o);
      await insertGift(d, o, 'b1', fy, 'Individual', removed);
    }
    const sent: RecomputeQueueMessage[] = [];
    const report = await runDuty('sweep', { ...deps({ archived: [], updates: [] }, sent), now: JULY_1 });
    expect(sent.map((m) => m.ownerItemId)).toEqual(['gaveLastYear', 'gaveTwoYearsAgo']);
    expect(report.detail).toMatchObject({ scope: 'rollover', fromFY: 2025, enqueued: 2, remaining: 0 });
  });

  it('includes sponsorship owners when sponsorships roll on the fiscal year', async () => {
    await link('d1', 'orgSpon', '5');
    await insertGift('d1', 'orgSpon', '5', 2020, 'Sponsorship');
    const c = testConfig();
    c.donationRollups.sponsorships = { organizationsBoardId: 5, giftTypes: ['Sponsorship'], inKindGiftTypes: [],
      yearBasis: 'fiscal', windowYears: 3, pipelineBoards: {} };
    const sent: RecomputeQueueMessage[] = [];
    await runDuty('sweep', { ...deps({ archived: [], updates: [] }, sent, c), now: JULY_1 });
    expect(sent.map((m) => m.ownerItemId)).toEqual(['orgSpon']);
  });

  it('?all=true sweeps every owner, on any day', async () => {
    await link('d3', 'lapsed');
    await insertGift('d3', 'lapsed', 'b1', 2010);
    const sent: RecomputeQueueMessage[] = [];
    const report = await runDuty('sweep', { ...deps({ archived: [], updates: [] }, sent), now: JULY_1 }, { all: true });
    expect(sent.map((m) => m.ownerItemId)).toEqual(['lapsed']);
    expect(report.detail).toMatchObject({ scope: 'all' });
  });

  it('slices at custodian.sweepOwnersPerRun and continues with the same scope the next day', async () => {
    for (let i = 0; i < 5; i++) { await link(`d${i}`, `o${i}`); await insertGift(`d${i}`, `o${i}`, 'b1', 2026); }
    await link('dL', 'oLapsed'); await insertGift('dL', 'oLapsed', 'b1', 2010);
    const config = testConfig({ sweepOwnersPerRun: 3 });
    const day1: RecomputeQueueMessage[] = [];
    const r1 = await runDuty('sweep', { ...deps({ archived: [], updates: [] }, day1, config), now: JULY_1 });
    expect(day1.map((m) => m.ownerItemId)).toEqual(['o0', 'o1', 'o2']);
    expect(r1.detail).toMatchObject({ scope: 'rollover', remaining: 1, cursor: 'o2' });

    const day2: RecomputeQueueMessage[] = [];
    const r2 = await runDuty('sweep', { ...deps({ archived: [], updates: [] }, day2, config), now: new Date('2026-07-02T18:00:00Z') });
    expect(day2.map((m) => m.ownerItemId)).toEqual(['o3', 'o4']);
    expect(r2.detail).toMatchObject({ scope: 'rollover', fromFY: 2025, remaining: 0 });
  });
});

describe('sweep duty on January 1 (calendar sponsorships)', () => {
  const insertGift = (id: string, owner: string, board: string, type: string) =>
    env.DB.prepare(`INSERT INTO gifts (monday_item_id, owner_item_id, owner_board_id, amount_cents, gift_date,
      fiscal_year, status, gift_type, source, updated_at) VALUES (?1, ?2, ?3, 1000, '2026-03-01', 2026, 'Received', ?4, 'import', 'now')`)
      .bind(id, owner, board, type).run();
  const cfg = () => {
    const c = testConfig();
    c.donationRollups.sponsorships = { organizationsBoardId: 5, giftTypes: ['Sponsorship'], inKindGiftTypes: ['In-Kind'],
      yearBasis: 'calendar', windowYears: 3, pipelineBoards: {} };
    return c;
  };

  it('enqueues only Organizations owners with sponsorship gifts; any other day sweeps everyone', async () => {
    const links = new D1DonationLinksStore(env.DB);
    for (const [d, o, b] of [['d1', 'orgSpon', '5'], ['d2', 'orgPlain', '5'], ['d3', 'person', 'b1'], ['d4', 'personSpon', 'b1']] as [string, string, string][]) {
      await links.upsertLink({ donationItemId: d, donationBoardId: '100', ownerItemId: o, ownerBoardId: b }, 'now');
    }
    await insertGift('d1', 'orgSpon', '5', 'In-Kind');
    await insertGift('d2', 'orgPlain', '5', 'Individual');
    await insertGift('d3', 'person', 'b1', 'Individual');
    await insertGift('d4', 'personSpon', 'b1', 'Sponsorship');

    const jan: RecomputeQueueMessage[] = [];
    const report = await runDuty('sweep', { ...deps({ archived: [], updates: [] }, jan, cfg()), now: new Date('2027-01-01T18:00:00Z') });
    expect(jan.map((m) => m.ownerItemId)).toEqual(['orgSpon']);
    expect(report.detail).toMatchObject({ scope: 'sponsorships', enqueued: 1 });

    const july: RecomputeQueueMessage[] = [];
    await runDuty('sweep', { ...deps({ archived: [], updates: [] }, july, cfg()), now: new Date('2027-07-01T18:00:00Z') });
    expect(july).toHaveLength(4);
  });
});

describe('reconcile duty', () => {
  // The projection the recompute path would have written for one 2020-01-01 gift.
  const glj = (entries: [string, number, string?][]) =>
    JSON.stringify(entries.map(([id, cents, status]) => [id, '2020-01-01', cents, '', status ?? 'Received']));

  it('clean when Monday matches the ledger in rounded cents (float noise tolerated)', async () => {
    await seedGift(env.DB, 'r1', { owner: 'oA', cents: 71493 });
    const d = deps({ archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '714.9300000000001', col_glj: glj([['r1', 71493]]) }],
    ]) }, []);
    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(true);
  });

  it('reports owner mismatches and stale annual summaries, and alerts', async () => {
    await seedGift(env.DB, 'r2', { owner: 'oA', cents: 5000, fy: 2019 });
    const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '10', col_glj: glj([['r2', 5000]]) }],
    ]) };
    const d = deps(state, [], testConfig({ alertItemId: 7 }));
    await d.gifts.upsertAnnualSummaries([{ fiscalYear: 2019, totalCents: 1, giftCount: 1, byTypeJson: '{}' }], 'now');

    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(false);
    const detail = report.detail as { mismatchCount: number; staleFYs: number[]; projectionMismatchCount: number };
    expect(detail.mismatchCount).toBe(1);
    expect(detail.projectionMismatchCount).toBe(0); // the JSON leg itself was clean here
    expect(detail.staleFYs).toEqual([2019]);
    expect(state.updates).toHaveLength(1);
    const runs = await d.gifts.lastRuns();
    expect(runs.find((r) => r.duty === 'reconcile')!.ok).toBe(false);
  });

  it('catches a drifted Gift Ledger JSON projection even when Lifetime Giving matches', async () => {
    await seedGift(env.DB, 'p1', { owner: 'oA', cents: 5000 });
    await seedGift(env.DB, 'p2', { owner: 'oA', cents: 2500 });
    const d = deps({ archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '75', col_glj: glj([['p1', 5000]]) }], // projection lost p2
    ]) }, []);
    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(false);
    const detail = report.detail as { projectionMismatchCount: number; projectionMismatches: unknown[]; mismatchCount: number };
    expect(detail.mismatchCount).toBe(0);
    expect(detail.projectionMismatchCount).toBe(1);
    expect(detail.projectionMismatches[0]).toMatchObject({ ownerItemId: 'oA', ledgerCents: 7500, projectionCents: 5000 });
  });

  it('flags an owner whose projection column is empty or unparseable', async () => {
    await seedGift(env.DB, 'q1', { owner: 'oA', cents: 5000 });
    await seedGift(env.DB, 'q2', { owner: 'oB', cents: 5000 });
    const d = deps({ archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '50', col_glj: null }],
      ['oB', { col_lt: '50', col_glj: 'not json' }],
    ]) }, []);
    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(false);
    const detail = report.detail as { projectionMismatchCount: number; projectionMismatches: { ownerItemId: string; projectionCents: number | null }[] };
    expect(detail.projectionMismatchCount).toBe(2);
    expect(detail.projectionMismatches.every((m) => m.projectionCents === null)).toBe(true);
  });

  it('non-Received entries in the projection are excluded from the sum, like the ledger side', async () => {
    await seedGift(env.DB, 'n1', { owner: 'oA', cents: 5000 });
    await seedGift(env.DB, 'n2', { owner: 'oA', cents: 900, status: 'Pledged' }); // outside ownerTotals
    const d = deps({ archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '50', col_glj: glj([['n1', 5000], ['n2', 900, 'Pledged']]) }],
    ]) }, []);
    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(true);
  });

  it('tolerates a truncated projection: compares only the entries it contains, against D1', async () => {
    // Full ledger 6000; the projection only carries the newest gift (5000) plus the
    // Finding-1 marker. Comparing 5000 to 6000 would be a false positive — instead the
    // included entries are checked against D1's rows for those same gifts.
    await seedGift(env.DB, 't1', { owner: 'oT', cents: 5000 });
    await seedGift(env.DB, 't0', { owner: 'oT', cents: 1000 });
    const truncatedGlj = JSON.stringify([
      ['t1', '2020-01-01', 5000, '', 'Received'],
      ['~truncated', '', 0, '', '1 older of 2 gifts omitted — full history in the D1 gifts ledger'],
    ]);
    const d = deps({ archived: [], updates: [], columnText: new Map([
      ['oT', { col_lt: '60', col_glj: truncatedGlj }],
    ]) }, []);
    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(true);
    expect((report.detail as { truncatedProjections: number }).truncatedProjections).toBe(1);
  });

  it('still catches real drift inside a truncated projection', async () => {
    await seedGift(env.DB, 'u1', { owner: 'oT', cents: 5000 });
    await seedGift(env.DB, 'u0', { owner: 'oT', cents: 1000 });
    const truncatedGlj = JSON.stringify([
      ['u1', '2020-01-01', 4000, '', 'Received'], // D1 says 5000
      ['~truncated', '', 0, '', '1 older of 2 gifts omitted — full history in the D1 gifts ledger'],
    ]);
    const d = deps({ archived: [], updates: [], columnText: new Map([
      ['oT', { col_lt: '60', col_glj: truncatedGlj }],
    ]) }, []);
    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(false);
    const detail = report.detail as { projectionMismatches: unknown[] };
    expect(detail.projectionMismatches[0]).toMatchObject({ ownerItemId: 'oT', ledgerCents: 5000, projectionCents: 4000 });
  });

  const SUMMARY_CFG = testConfig({
    annualSummaryBoardId: 777,
    annualSummaryColumns: { fiscalYear: 'c_fy', total: 'c_total', giftCount: 'c_n', byType: 'c_bt', restatedAt: 'c_re' },
  });

  it('verifies the Annual Giving Summary board items against annual_summaries — clean case', async () => {
    await seedGift(env.DB, 'y1', { owner: 'oA', cents: 5000, fy: 2015 });
    const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '50', col_glj: glj([['y1', 5000]]) }],
      ['sum-2015', { c_total: '50', c_n: '1' }],
    ]) };
    const d = deps(state, [], SUMMARY_CFG);
    await d.gifts.upsertAnnualSummaries([{ fiscalYear: 2015, totalCents: 5000, giftCount: 1, byTypeJson: '{}' }], 'now');
    await d.gifts.setSummaryItemId(2015, 'sum-2015');

    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(true);
    expect((report.detail as { summaryItemsChecked: number }).summaryItemsChecked).toBe(1);
  });

  it('flags a summary-board item whose totals drifted from annual_summaries', async () => {
    await seedGift(env.DB, 'z1', { owner: 'oA', cents: 5000, fy: 2015 });
    const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '50', col_glj: glj([['z1', 5000]]) }],
      ['sum-2015', { c_total: '49.99', c_n: '1' }], // a staff edit drifted the board item
    ]) };
    const d = deps(state, [], SUMMARY_CFG);
    await d.gifts.upsertAnnualSummaries([{ fiscalYear: 2015, totalCents: 5000, giftCount: 1, byTypeJson: '{}' }], 'now');
    await d.gifts.setSummaryItemId(2015, 'sum-2015');

    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(false);
    const detail = report.detail as { summaryBoardMismatches: unknown[] };
    expect(detail.summaryBoardMismatches).toEqual([
      { fiscalYear: 2015, ledgerCents: 5000, boardCents: 4999 },
    ]);
  });

  it('flags a summary item that vanished from the board entirely', async () => {
    await seedGift(env.DB, 'v1', { owner: 'oA', cents: 5000, fy: 2015 });
    const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '50', col_glj: glj([['v1', 5000]]) }],
      // no 'sum-2015' entry — the item is gone
    ]) };
    const d = deps(state, [], SUMMARY_CFG);
    await d.gifts.upsertAnnualSummaries([{ fiscalYear: 2015, totalCents: 5000, giftCount: 1, byTypeJson: '{}' }], 'now');
    await d.gifts.setSummaryItemId(2015, 'sum-2015');

    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(false);
    const detail = report.detail as { summaryBoardMismatches: { boardCents: number | null }[] };
    expect(detail.summaryBoardMismatches).toEqual([
      { fiscalYear: 2015, ledgerCents: 5000, boardCents: null },
    ]);
  });

  describe('an owner who moved boards after D1 recorded their gifts', () => {
    const MOVED_CFG: DonationRollupsConfig = {
      ...testConfig(),
      donationRollups: {
        ...testConfig().donationRollups,
        ownerColumnsByBoard: {
          b1: OWNER_COLS,
          b2: { ...OWNER_COLS, lifetimeGiving: 'col_lt2', giftLedgerJson: 'col_glj2' },
        },
      },
    };

    it('reconciles against the columns of the board they are on now', async () => {
      await seedGift(env.DB, 'mv1', { owner: 'oA', cents: 5000 });
      const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
        ['oA', { col_lt2: '50', col_glj2: glj([['mv1', 5000]]) }],
      ]) };
      expect((await runDuty('reconcile', deps(state, [], MOVED_CFG))).ok).toBe(true);
    });

    it('still flags real drift on the new board', async () => {
      await seedGift(env.DB, 'mv2', { owner: 'oA', cents: 5000 });
      const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
        ['oA', { col_lt2: '49', col_glj2: glj([['mv2', 4900]]) }],
      ]) };
      const detail = (await runDuty('reconcile', deps(state, [], MOVED_CFG))).detail as {
        mismatches: unknown[]; projectionMismatches: unknown[];
      };
      expect(detail.mismatches).toEqual([{ ownerItemId: 'oA', ledgerCents: 5000, mondayCents: 4900 }]);
      expect(detail.projectionMismatches).toEqual([{ ownerItemId: 'oA', ledgerCents: 5000, projectionCents: 4900 }]);
    });

    it('still flags an owner whose columns are empty on every board', async () => {
      await seedGift(env.DB, 'mv3', { owner: 'oA', cents: 5000 });
      const state: FakeClientState = { archived: [], updates: [], columnText: new Map([['oA', {}]]) };
      const report = await runDuty('reconcile', deps(state, [], MOVED_CFG));
      expect(report.ok).toBe(false);
      expect((report.detail as { mismatches: unknown[] }).mismatches).toEqual([{ ownerItemId: 'oA', ledgerCents: 5000, mondayCents: null }]);
    });
  });

  const AFFIL_CFG: DonationRollupsConfig = {
    ...testConfig(),
    affiliations: { boardId: 500, columns: { personLink: 'pl', attributedGiving: 'n_ag', attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' } },
    donationRollups: {
      ...testConfig().donationRollups,
      ownerColumnsByBoard: { b1: { ...OWNER_COLS, organizationalGiving: 'col_og' } },
    },
  };

  it('reconciles attributed giving and Organizational Giving cleanly when Monday matches the ledger', async () => {
    await seedGift(env.DB, 'ag1', { owner: 'oA', cents: 52500, actingFor: 'af-1' });
    await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-1','p-1','b1','Ada @ Acme','now')`).run();
    const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '525', col_glj: glj([['ag1', 52500]]) }],
      ['af-1', { n_ag: '525' }],
      ['p-1', { col_og: '525' }],
    ]) };
    const d = deps(state, [], AFFIL_CFG);
    // Legs 5/6 only run in an invocation whose owner slice is empty — simulate the owner
    // walk having already completed (parked at the only owner, 'oA') on a prior run.
    await d.gifts.recordRun({ duty: 'reconcile', ranAt: '2026-07-31T00:00:00Z', ok: true,
      report: { ok: true, summary: 'parked', detail: { remaining: 1, cursor: 'oA' } } });

    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(true);
    const detail = report.detail as { affiliationMismatchCount: number; organizationalMismatchCount: number };
    expect(detail.affiliationMismatchCount).toBe(0);
    expect(detail.organizationalMismatchCount).toBe(0);
  });

  it('flags affiliation and Organizational Giving mismatches against the ledger', async () => {
    await seedGift(env.DB, 'ag2', { owner: 'oA', cents: 52500, actingFor: 'af-1' });
    await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-1','p-1','b1','Ada @ Acme','now')`).run();
    const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '525', col_glj: glj([['ag2', 52500]]) }],
      ['af-1', { n_ag: '524' }],
      ['p-1', { col_og: '524' }],
    ]) };
    const d = deps(state, [], AFFIL_CFG);
    // Legs 5/6 only run in an invocation whose owner slice is empty — simulate the owner
    // walk having already completed (parked at the only owner, 'oA') on a prior run.
    await d.gifts.recordRun({ duty: 'reconcile', ranAt: '2026-07-31T00:00:00Z', ok: true,
      report: { ok: true, summary: 'parked', detail: { remaining: 1, cursor: 'oA' } } });

    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(false);
    const detail = report.detail as {
      affiliationMismatches: { affiliationItemId: string; ledgerCents: number; mondayCents: number | null }[];
      organizationalMismatches: { personItemId: string; ledgerCents: number; mondayCents: number | null }[];
    };
    expect(detail.affiliationMismatches).toEqual([{ affiliationItemId: 'af-1', ledgerCents: 52500, mondayCents: 52400 }]);
    expect(detail.organizationalMismatches).toEqual([{ personItemId: 'p-1', ledgerCents: 52500, mondayCents: 52400 }]);
  });

  // Parks the owner walk at its only owner ('oA') so legs 5/6 run on the next duty call.
  const parkedOnOwner = (d: ReturnType<typeof deps>) => d.gifts.recordRun({ duty: 'reconcile',
    ranAt: '2026-07-31T00:00:00Z', ok: true, report: { ok: true, summary: 'parked', detail: { remaining: 1, cursor: 'oA' } } });

  it('reads an empty attributed or Organizational Giving column as $0 when the ledger is also $0', async () => {
    await seedGift(env.DB, 'ag-empty', { owner: 'oA', cents: 5000 });
    await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-1','p-1','b1','Ada @ Acme','now')`).run();
    const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '50', col_glj: glj([['ag-empty', 5000]]) }],
      ['af-1', { n_ag: null }],
      ['p-1', { col_og: null }],
    ]) };
    const d = deps(state, [], AFFIL_CFG);
    await parkedOnOwner(d);

    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(true);
    const detail = report.detail as { affiliationMismatchCount: number; organizationalMismatchCount: number };
    expect(detail.affiliationMismatchCount).toBe(0);
    expect(detail.organizationalMismatchCount).toBe(0);
  });

  it('still flags an empty column against a non-zero ledger, and a non-zero column against a $0 ledger', async () => {
    await seedGift(env.DB, 'ag-real', { owner: 'oA', cents: 5000, actingFor: 'af-1' });
    await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-1','p-1','b1','Ada @ Acme','now')`).run();
    await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-2','p-2','b1','Bo @ Acme','now')`).run();
    const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '50', col_glj: glj([['ag-real', 5000]]) }],
      ['af-1', { n_ag: null }],
      ['af-2', { n_ag: '7' }],
      ['p-1', { col_og: null }],
      ['p-2', { col_og: '7' }],
    ]) };
    const d = deps(state, [], AFFIL_CFG);
    await parkedOnOwner(d);

    const detail = (await runDuty('reconcile', d)).detail as {
      affiliationMismatches: unknown[]; organizationalMismatches: unknown[];
    };
    expect(detail.affiliationMismatches).toEqual([
      { affiliationItemId: 'af-1', ledgerCents: 5000, mondayCents: null },
      { affiliationItemId: 'af-2', ledgerCents: 0, mondayCents: 700 },
    ]);
    expect(detail.organizationalMismatches).toEqual([
      { personItemId: 'p-1', ledgerCents: 5000, mondayCents: null },
      { personItemId: 'p-2', ledgerCents: 0, mondayCents: 700 },
    ]);
  });

  describe('a person who moved boards after D1 recorded their affiliation', () => {
    const TWO_BOARDS: DonationRollupsConfig = {
      ...AFFIL_CFG,
      donationRollups: {
        ...AFFIL_CFG.donationRollups,
        ownerColumnsByBoard: {
          b1: { ...OWNER_COLS, organizationalGiving: 'col_og' },
          b2: { ...OWNER_COLS, organizationalGiving: 'col_og2' },
        },
      },
    };

    it('compares against whichever board column holds the value, not the one D1 names', async () => {
      await seedGift(env.DB, 'ag-moved', { owner: 'oA', cents: 5000, actingFor: 'af-1' });
      await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-1','p-1','b1','Ada @ Acme','now')`).run();
      const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
        ['oA', { col_lt: '50', col_glj: glj([['ag-moved', 5000]]) }],
        ['af-1', { n_ag: '50' }],
        ['p-1', { col_og2: '50' }], // really on b2, whose column is the only one the item has
      ]) };
      const d = deps(state, [], TWO_BOARDS);
      await parkedOnOwner(d);

      expect((await runDuty('reconcile', d)).ok).toBe(true);
    });

    it('catches a stale value in the other board\'s column for a moved person with a $0 ledger', async () => {
      await seedGift(env.DB, 'ag-none', { owner: 'oA', cents: 5000 });
      await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-1','p-1','b1','Ada @ Acme','now')`).run();
      const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
        ['oA', { col_lt: '50', col_glj: glj([['ag-none', 5000]]) }],
        ['af-1', { n_ag: null }],
        ['p-1', { col_og2: '12' }],
      ]) };
      const d = deps(state, [], TWO_BOARDS);
      await parkedOnOwner(d);

      const detail = (await runDuty('reconcile', d)).detail as { organizationalMismatches: unknown[] };
      expect(detail.organizationalMismatches).toEqual([{ personItemId: 'p-1', ledgerCents: 0, mondayCents: 1200 }]);
    });

    it('sums a person whose affiliations name two boards into one total', async () => {
      await seedGift(env.DB, 'ag-b1', { owner: 'oA', cents: 5000, actingFor: 'af-1' });
      await seedGift(env.DB, 'ag-b2', { owner: 'oA', cents: 2500, actingFor: 'af-2' });
      await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-1','p-1','b1','Ada @ Acme','now')`).run();
      await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-2','p-1','b2','Ada @ Beta','now')`).run();
      const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
        ['oA', { col_lt: '75', col_glj: glj([['ag-b1', 5000], ['ag-b2', 2500]]) }],
        ['af-1', { n_ag: '50' }],
        ['af-2', { n_ag: '25' }],
        ['p-1', { col_og2: '75' }],
      ]) };
      const d = deps(state, [], TWO_BOARDS);
      await parkedOnOwner(d);

      expect((await runDuty('reconcile', d)).ok).toBe(true);
    });
  });

  it('warns (review finding 13) when leg 6 skips a person whose board has no organizationalGiving column', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfgNoOgColumn: DonationRollupsConfig = {
      ...AFFIL_CFG,
      donationRollups: {
        ...AFFIL_CFG.donationRollups,
        // b2 is a configured owner board, but — like an Organizations board — carries no
        // organizationalGiving column at all.
        ownerColumnsByBoard: { ...AFFIL_CFG.donationRollups.ownerColumnsByBoard, b2: OWNER_COLS },
      },
    };
    await seedGift(env.DB, 'ag2b', { owner: 'oA', cents: 5000, actingFor: 'af-2' });
    await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-2','p-2','b2','Zed @ Co','now')`).run();
    const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '50', col_glj: glj([['ag2b', 5000]]) }],
      ['af-2', { n_ag: '50' }],
    ]) };
    const d = deps(state, [], cfgNoOgColumn);
    await d.gifts.recordRun({ duty: 'reconcile', ranAt: '2026-07-31T00:00:00Z', ok: true,
      report: { ok: true, summary: 'parked', detail: { remaining: 1, cursor: 'oA' } } });

    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(true); // a missing column is a skip, not a mismatch
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no organizationalGiving column for board "b2"'));
  });

  it('skips legs 5/6 entirely when config.affiliations is not configured', async () => {
    await seedGift(env.DB, 'ag3', { owner: 'oA', cents: 5000, actingFor: 'af-1' });
    await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-1','p-1','b1','Ada @ Acme','now')`).run();
    const state: FakeClientState = { archived: [], updates: [], columnText: new Map([
      ['oA', { col_lt: '50', col_glj: glj([['ag3', 5000]]) }],
    ]) };
    const d = deps(state, []); // default testConfig(): affiliations: null

    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(true);
    const detail = report.detail as { affiliationMismatchCount: number; organizationalMismatchCount: number };
    expect(detail.affiliationMismatchCount).toBe(0);
    expect(detail.organizationalMismatchCount).toBe(0);
  });

  // Seeds RECONCILE_AFFILIATIONS_PER_RUN + 1 affiliations (each with its own gift, all
  // acting for the same single person 'p-1' so leg 6 stays a one-item, one-call leg) via a
  // raw batch insert — seedGift's per-row helper would be far too slow at this volume.
  async function seedAffiliationOverflow(db: D1Database, count: number) {
    const affiliationStmts = [];
    const giftStmts = [];
    for (let i = 0; i < count; i++) {
      const afId = `af-${String(i).padStart(4, '0')}`;
      affiliationStmts.push(db.prepare(`INSERT INTO affiliations VALUES (?1, 'p-1', 'b1', ?2, 'now')`)
        .bind(afId, `Person ${i}`));
      giftStmts.push(db.prepare(`INSERT INTO gifts (monday_item_id, owner_item_id, owner_board_id,
          amount_cents, gift_date, fiscal_year, status, archived_at, acting_for_item_id, source, updated_at)
        VALUES (?1, 'o1', 'b1', 100, '2020-01-01', 2020, 'Received', NULL, ?2, 'import', 'now')`)
        .bind(`g-${afId}`, afId));
    }
    const all = [...affiliationStmts, ...giftStmts];
    for (let i = 0; i < all.length; i += 500) await db.batch(all.slice(i, i + 500));
  }

  it('slices legs 5/6 across runs under the subrequest cap, never sharing an invocation with an owner slice', async () => {
    const total = RECONCILE_AFFILIATIONS_PER_RUN + 1;
    await seedAffiliationOverflow(env.DB, total);
    const sortedIds = Array.from({ length: total }, (_, i) => `af-${String(i).padStart(4, '0')}`).sort();
    const columnText = new Map<string, Record<string, string | null>>();
    for (const id of sortedIds) columnText.set(id, { n_ag: '1' }); // 100 cents == $1.00
    columnText.set('p-1', { col_og: String(total) }); // total * 100 cents == $total.00
    const state: FakeClientState = { archived: [], updates: [], columnText, calls: [] };
    const d = deps(state, [], AFFIL_CFG);
    d.now = new Date('2026-08-01T00:00:00Z');

    // Run 0: the owner walk itself — a single owner ('o1'), consumed in one slice since
    // RECONCILE_OWNERS_PER_RUN comfortably covers it. Legs 5/6 must spend zero Monday
    // subrequests here, even though ownerRemaining reaches 0 in this same run.
    const before0 = state.calls!.length;
    await runDuty('reconcile', d);
    const run0Calls = state.calls!.slice(before0);
    expect(run0Calls.some((c) => c.columnIds.includes('n_ag') || c.columnIds.includes('col_og'))).toBe(false);

    // Run 1: the owner slice is now empty (parked on the just-completed owner walk) — leg 5
    // spends its RECONCILE_AFFILIATIONS_PER_RUN-per-run cap (20 getItemsColumnsText calls)
    // and leaves exactly 1 affiliation outstanding; leg 6 must not run yet.
    d.now = new Date('2026-08-02T00:00:00Z');
    const before1 = state.calls!.length;
    const run1 = await runDuty('reconcile', d);
    const run1Calls = state.calls!.slice(before1);
    const detail1 = run1.detail as { affiliationRemaining: number; affiliationCursor: string };
    expect(detail1.affiliationRemaining).toBe(1);
    expect(detail1.affiliationCursor).toBe(sortedIds[RECONCILE_AFFILIATIONS_PER_RUN - 1]);
    expect(run1Calls.some((c) => c.columnIds.includes('col_og'))).toBe(false);
    expect(run1Calls.length).toBeLessThanOrEqual(20);

    // Run 2: leg 5 finishes its last affiliation, which lets leg 6 run in the same
    // invocation — both fully catch up and the combined remaining drops to 0.
    d.now = new Date('2026-08-03T00:00:00Z');
    const run2 = await runDuty('reconcile', d);
    const detail2 = run2.detail as { affiliationRemaining: number; personRemaining: number; remaining: number };
    expect(detail2.affiliationRemaining).toBe(0);
    expect(detail2.personRemaining).toBe(0);
    expect(detail2.remaining).toBe(0);
  }, 30_000);

  it('does not restart leg 5 while leg 6 still has people outstanding', async () => {
    const total = RECONCILE_PERSONS_PER_RUN + 1;
    const db = env.DB;
    const stmts = [];
    const columnText = new Map<string, Record<string, string | null>>();
    for (let i = 0; i < total; i++) {
      const n = String(i).padStart(4, '0');
      stmts.push(db.prepare(`INSERT INTO affiliations VALUES (?1, ?2, 'b1', ?3, 'now')`).bind(`af-${n}`, `p-${n}`, `Person ${i}`));
      columnText.set(`af-${n}`, { n_ag: null });
      columnText.set(`p-${n}`, { col_og: null });
    }
    for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500));
    const state: FakeClientState = { archived: [], updates: [], columnText, calls: [] };
    const d = deps(state, [], AFFIL_CFG);
    const runAt = async (iso: string) => {
      d.now = new Date(iso);
      const before = state.calls!.length;
      const report = await runDuty('reconcile', d);
      return { detail: report.detail as { affiliationRemaining: number; personRemaining: number; remaining: number; personCursor: string },
        calls: state.calls!.slice(before) };
    };

    // No gifts, so no owner slice: this run finishes 2,000 affiliations and leaves one.
    const run1 = await runAt('2026-08-01T00:00:00Z');
    expect(run1.detail.affiliationRemaining).toBe(1);
    expect(run1.calls.some((c) => c.columnIds.includes('col_og'))).toBe(false);

    // Leg 5 finishes, so leg 6 starts in the same invocation and leaves one person.
    const run2 = await runAt('2026-08-02T00:00:00Z');
    expect(run2.detail.affiliationRemaining).toBe(0);
    expect(run2.detail.personRemaining).toBe(1);

    // Leg 5 is done for this pass: no re-read of affiliations while leg 6 finishes.
    const run3 = await runAt('2026-08-03T00:00:00Z');
    expect(run3.calls.some((c) => c.columnIds.includes('n_ag'))).toBe(false);
    expect(run3.calls.some((c) => c.columnIds.includes('col_og'))).toBe(true);
    expect(run3.detail.remaining).toBe(0);

    // The pass is over, so the next run starts a new one from the first affiliation.
    const run4 = await runAt('2026-08-04T00:00:00Z');
    expect(run4.calls[0]!.itemIds[0]).toBe('af-0000');
  }, 30_000);

  it('never runs leg 6 alongside an owner slice, even with leg 5 already finished', async () => {
    await seedGift(env.DB, 'ag-new', { owner: 'oB', cents: 5000 });
    await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-1','p-1','b1','Ada @ Acme','now')`).run();
    const state: FakeClientState = { archived: [], updates: [], calls: [], columnText: new Map([
      ['oB', { col_lt: '50', col_glj: glj([['ag-new', 5000]]) }],
      ['af-1', { n_ag: null }],
      ['p-1', { col_og: null }],
    ]) };
    const d = deps(state, [], AFFIL_CFG);
    // oB sorts after the parked cursor, as an owner created mid-pass would.
    await d.gifts.recordRun({ duty: 'reconcile', ranAt: '2026-07-31T00:00:00Z', ok: true, report: { ok: true, summary: 'parked',
      detail: { remaining: 1, cursor: 'oA', affiliationRemaining: 0, affiliationCursor: 'af-1', personRemaining: 1, personCursor: '' } } });

    const report = await runDuty('reconcile', d);
    expect(state.calls!.some((c) => c.columnIds.includes('col_lt'))).toBe(true);
    expect(state.calls!.some((c) => c.columnIds.includes('col_og'))).toBe(false);
    expect((report.detail as { personRemaining: number }).personRemaining).toBe(1);
  });
});

// Fix 5: rows the queue never finished (messages expired unconsumed, or a batch that died
// before touching D1) are re-enqueued nightly. Their received_at is left alone on purpose —
// the consumer's coalescing (fix 3) then turns every message after the first per owner into a
// two-read skip, so a flood's worth of stuck rows costs ~one recompute per owner.
describe('requeue duty', () => {
  const seed = async (id: string, receivedAt: string, status?: 'queued' | 'written' | 'failed') => {
    const store = new D1PendingStore(env.DB);
    await store.upsertPending({ donationItemId: id, donationBoardId: '100', eventId: 'e', receivedAt });
    if (status) await store.updateStatus(id, status, status === 'failed' ? { error: 'x' } : {});
  };

  it('re-enqueues queued/received rows older than 24h in batches of 100, leaving fresh, written and failed rows alone, and reports attention', async () => {
    for (let i = 0; i < 250; i += 1) await seed(`stuck-${String(i).padStart(3, '0')}`, `2026-07-30T00:${String(i % 60).padStart(2, '0')}:00Z`, 'queued');
    await seed('never-enqueued', '2026-07-29T00:00:00Z'); // 'received'
    await seed('fresh', '2026-07-31T20:00:00Z', 'queued'); // within 24h of now (2026-08-01T00:00Z)
    await seed('done', '2026-07-01T00:00:00Z', 'written');
    await seed('dead', '2026-07-01T00:00:00Z', 'failed'); // a human's signal, not ours to retry

    const batches: number[] = [];
    const sent: RecomputeQueueMessage[] = [];
    const state = { archived: [], updates: [] as { itemId: number; body: string }[] };
    const d = deps(state, sent, testConfig({ alertItemId: 7 }));
    d.queue = { sendBatch: async (msgs) => { batches.push(msgs.length); sent.push(...msgs); } };

    const report = await runDuty('requeue', d);

    expect(sent).toHaveLength(251);
    expect(batches).toEqual([100, 100, 51]);
    const ids = new Set(sent.map((m) => m.donationItemId));
    expect(ids.has('never-enqueued')).toBe(true);
    expect(ids.has('fresh') || ids.has('done') || ids.has('dead')).toBe(false);
    expect(sent[0]).toEqual({ donationItemId: 'never-enqueued', donationBoardId: '100' });
    expect(sent[0]).not.toHaveProperty('kind');
    expect(report.ok).toBe(false); // stuck rows mean the consumer lost work earlier — say so
    expect(report.summary).toContain('251');
    expect(state.updates).toHaveLength(1); // one alert
  });

  it('re-sends a stuck affiliation with its kind', async () => {
    await new D1PendingStore(env.DB).upsertPending({ donationItemId: 'aff-stuck', donationBoardId: '555', eventId: 'e',
      receivedAt: '2026-07-29T00:00:00Z', kind: 'affiliation' });
    const sent: RecomputeQueueMessage[] = [];
    await runDuty('requeue', deps({ archived: [], updates: [] }, sent, testConfig({ alertItemId: null })));
    expect(sent).toEqual([{ kind: 'affiliation', donationItemId: 'aff-stuck', donationBoardId: '555' }]);
  });

  it('re-sends a stuck registration with kind: registration, and a donation with no kind key', async () => {
    await new D1PendingStore(env.DB).upsertPending({ donationItemId: 'reg-stuck', donationBoardId: '700', eventId: 'e',
      receivedAt: '2026-07-29T00:00:00Z', kind: 'registration' });
    await seed('dn-stuck', '2026-07-29T01:00:00Z', 'queued');
    const sent: RecomputeQueueMessage[] = [];
    await runDuty('requeue', deps({ archived: [], updates: [] }, sent, testConfig({ alertItemId: null })));
    const byId = new Map(sent.map((m) => [m.donationItemId, m]));
    expect(byId.get('reg-stuck')).toEqual({ kind: 'registration', donationItemId: 'reg-stuck', donationBoardId: '700' });
    expect(byId.get('dn-stuck')).toEqual({ donationItemId: 'dn-stuck', donationBoardId: '100' });
    expect(byId.get('dn-stuck')).not.toHaveProperty('kind');
  });

  // Issue GL#90: pending_recomputes and custodian_runs were never pruned.
  it('prunes finished rows past 30 days and custodian runs past 180, keeping each duty\'s latest run', async () => {
    await seed('done-old', '2026-06-01T00:00:00Z', 'written');   // 61 days before now
    await seed('done-recent', '2026-07-15T00:00:00Z', 'written');
    await seed('dead-old', '2026-06-01T00:00:00Z', 'failed');
    const gifts = new D1GiftsStore(env.DB);
    await gifts.recordRun({ duty: 'reconcile', ranAt: '2025-12-01T00:00:00Z', ok: true, report: {} });
    await gifts.recordRun({ duty: 'reconcile', ranAt: '2026-07-31T00:00:00Z', ok: true, report: {} });
    await gifts.recordRun({ duty: 'sweep', ranAt: '2025-07-01T00:00:00Z', ok: true, report: { detail: { remaining: 0 } } });

    const report = await runDuty('requeue', deps({ archived: [], updates: [] }, [], testConfig({ alertItemId: null })));

    const left = await env.DB.prepare('SELECT donation_item_id FROM pending_recomputes ORDER BY donation_item_id').all<{ donation_item_id: string }>();
    expect(left.results.map((r) => r.donation_item_id)).toEqual(['dead-old', 'done-recent']);
    const runs = await env.DB.prepare('SELECT duty, ran_at FROM custodian_runs ORDER BY ran_at').all<{ duty: string; ran_at: string }>();
    // The sweep's only run stays however old; this requeue run is recorded too.
    expect(runs.results.map((r) => `${r.duty}@${r.ran_at.slice(0, 10)}`)).toEqual(['sweep@2025-07-01', 'reconcile@2026-07-31', 'requeue@2026-08-01']);
    expect(report.detail).toMatchObject({ prunedPending: 1, prunedRuns: 1 });
  });

  it('is quiet when nothing is stuck', async () => {
    await seed('fresh', '2026-07-31T23:00:00Z', 'queued');
    const state = { archived: [], updates: [] as { itemId: number; body: string }[] };
    const sent: RecomputeQueueMessage[] = [];
    const report = await runDuty('requeue', deps(state, sent, testConfig({ alertItemId: 7 })));
    expect(sent).toHaveLength(0);
    expect(report.ok).toBe(true);
    expect(state.updates).toHaveLength(0);
  });
});

// The write switch (spec 2026-10-26) on the daily cron: the mode is read once per run (index.ts).
describe('scheduled custodian run (write switch)', () => {
  // Every console spy below is restored here, even when an assertion fails first.
  afterEach(() => { vi.restoreAllMocks(); });
  const gate = (mode: WriteMode): BatchSkipContext =>
    ({ worker: 'donation-rollups', environment: 'production', mode, logLevel: 'normal', piiKeys: DEFAULT_PII_KEYS });
  // July 15 in Pacific time: the nightly duties plus the year-end archive run.
  const JULY_15 = new Date('2026-07-15T16:00:00Z');

  async function seed() {
    await seedGift(env.DB, 'old1', { fy: 2015 }); // archivable
    // A pending row stuck for two days — the requeue duty's work, and an ATTENTION report.
    await env.DB.prepare(`INSERT INTO pending_recomputes (donation_item_id, donation_board_id, event_id, received_at, status, kind)
      VALUES ('stuck1', '100', 'e1', '2026-07-13T00:00:00Z', 'queued', 'donation')`).run();
  }

  it.each([['hold'], ['unknown']] as const)('%s: runs no duty, reads nothing and records no run', async (mode) => {
    await seed();
    const state: FakeClientState = { archived: [], updates: [] };
    const sent: RecomputeQueueMessage[] = [];
    const d = { ...deps(state, sent, testConfig({ alertItemId: 7 })), now: JULY_15 };
    const lastRuns = vi.spyOn(d.gifts, 'lastRuns');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runScheduled(d, gate(mode));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`write mode is "${mode}"`));
    expect(lastRuns).not.toHaveBeenCalled();
    expect(state.archived).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(sent).toEqual([]);
    expect(await d.gifts.lastRuns()).toEqual([]);
  });

  it('off: runs the duties against recording sinks — no archive, alert or enqueue, and no run recorded', async () => {
    await seed();
    const state: FakeClientState = { archived: [], updates: [] };
    const sent: RecomputeQueueMessage[] = [];
    const d = { ...deps(state, sent, testConfig({ alertItemId: 7 })), now: JULY_15 };
    const recordRun = vi.spyOn(d.gifts, 'recordRun');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runScheduled(d, gate('off'));
    const lines = log.mock.calls.map(([line]) => String(line));

    expect(recordRun).not.toHaveBeenCalled();
    expect(await d.gifts.lastRuns()).toEqual([]);
    expect(state.archived).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(sent).toEqual([]);
    // Nothing in D1 moved: the gift is still active, no summaries materialized.
    expect(await d.gifts.getArchivable(2026)).toEqual([{ mondayItemId: 'old1', fiscalYear: 2015 }]);
    expect(await d.gifts.getAnnualSummaries()).toEqual([]);
    // Each would-be write is a skip line; each duty still logs its report.
    const skipped = lines.filter((l) => l.includes('"writeSwitch":"skipped"')).map((l) => JSON.parse(l) as { sink: string; operation: string });
    expect(skipped.map((l) => `${l.sink}.${l.operation}`)).toEqual(expect.arrayContaining([
      'Monday.archiveItem', 'RECOMPUTE_QUEUE.sendBatch', 'Monday.createUpdate',
    ]));
    expect(lines.some((l) => l.startsWith('custodian archive (dry run): ok'))).toBe(true);
  });

  it('on: runs and records every duty today owes', async () => {
    await seed();
    const state: FakeClientState = { archived: [], updates: [] };
    const sent: RecomputeQueueMessage[] = [];
    const d = { ...deps(state, sent, testConfig({ alertItemId: 7 })), now: JULY_15 };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runScheduled(d, gate('on'));
    expect(state.archived).toEqual(['old1']);
    expect(sent.map((m) => m.donationItemId)).toEqual(['stuck1']);
    expect((await d.gifts.lastRuns()).map((r) => r.duty).sort()).toEqual(
      ['archive', 'classify', 'membership', 'reconcile', 'recurring', 'requeue', 'rollcall']);
  });

  // Issue GL#90: one write budget for the whole run (custodian.writesPerRun), not one per duty.
  it('shares one write budget across the run\'s duties', async () => {
    for (const id of ['a1', 'a2', 'a3']) await seedGift(env.DB, id, { fy: 2015 });
    const config = testConfig({ alertItemId: null, writesPerRun: 2 });
    config.donationRollups.ownerColumnsByBoard = { '10': { ...OWNER_COLS, hasActiveRecurringGift: 'rg' } };
    config.donationRollups.recurringGifts = { boardId: 50, columns: { donorLink: 'dl', status: 'st' }, activeStatusLabel: 'Active' };
    const state: FakeClientState = { archived: [], updates: [] };
    const d = { ...deps(state, [], config), now: JULY_15 };
    d.mondayClient.pageItemsColumnsText = async () =>
      ({ cursor: null, items: [{ id: 'p1', text: new Map([['rg', 'v']]), values: new Map() }] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runScheduled(d, gate('on'));
    // Recurring (nightly, before archive) has one write; archive gets the one left.
    expect(state.changedColumns).toEqual([{ boardId: 10, itemId: 'p1', columnValues: { rg: null } }]);
    expect(state.archived).toEqual(['a1']);
    const archive = (await d.gifts.lastRuns()).find((r) => r.duty === 'archive');
    expect(archive?.report).toMatchObject({ detail: { archived: 1, remaining: 2 } });
  });

  // Issue GL#90: membership and recurring each paged People in full; one read now serves both.
  it('pages a board that several duties read once per run', async () => {
    const config = testConfig({ alertItemId: null });
    const membershipCols = { status: 'ms', tier: 'mt', since: 'msi', until: 'mu', currentTermStart: 'ts', memberType: 'mty',
      lapseCount: 'lc', lastLapsed: 'll' };
    config.donationRollups.ownerColumnsByBoard = { '10': { ...OWNER_COLS, hasActiveRecurringGift: 'rg', membership: membershipCols } };
    config.donationRollups.membership = { fromISO: '2020-01-01', eligibleGiftTypes: [], minAmountCents: 0, termMonths: 13,
      lifetimeThresholdCents: 0, statusLabels: { active: 'A', lapsed: 'L' }, tierLabels: { member: 'M', lifetime: 'LT' },
      typeLabels: { new: 'N', continuing: 'C', lapsedRenewal: 'R', lifetime: 'LT' } };
    config.donationRollups.recurringGifts = { boardId: 50, columns: { donorLink: 'dl', status: 'st' }, activeStatusLabel: 'Active' };
    const state: FakeClientState = { archived: [], updates: [] };
    const d = { ...deps(state, [], config), now: new Date('2026-08-05T16:00:00Z') };
    const reads: { boardId: number; columnIds: string[] }[] = [];
    d.mondayClient.pageItemsColumnsText = async (boardId, columnIds) => {
      reads.push({ boardId, columnIds });
      return { cursor: null, items: [{ id: 'p1', text: new Map([['ts', '2025-07-01'], ['rg', 'v']]), values: new Map() }] };
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runScheduled(d, gate('on'));
    expect(reads.filter((r) => r.boardId === 10)).toEqual([{ boardId: 10, columnIds: expect.arrayContaining(['ts', 'rg']) }]);
    // Recurring still saw the flag through the shared read: p1 has no active gift, so it's cleared.
    expect(state.changedColumns).toEqual([{ boardId: 10, itemId: 'p1', columnValues: { rg: null } }]);
  });
});
