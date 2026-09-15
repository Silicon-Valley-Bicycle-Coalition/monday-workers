import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1GiftsStore } from '../db/gifts';
import { D1DonationLinksStore } from '../db/links';
import { D1PendingStore } from '../db/pending';
import { dutiesForDate, runDuty, type CustodianDeps, type CustodianMondayClient, type BoardCapacity } from './custodian';
import type { DonationRollupsConfig, RecomputeQueueMessage } from '../types';

const OWNER_COLS = {
  giftLedgerJson: 'col_glj', lifetimeGiving: 'col_lt', giftCount: 'col_gc', firstGift: 'col_fg',
  thisYearAmount: 'c', thisYearCount: 'c', lastYearAmount: 'c', lastYearCount: 'c',
  largestGift: 'c', smallestGift: 'c', averageGift: 'c', lastGiftDate: 'c', lastGiftAmount: 'c',
};

function testConfig(over: Partial<DonationRollupsConfig['custodian']> = {}): DonationRollupsConfig {
  return {
    monday: { apiUrl: 'https://x', accountUrl: 'https://acme.monday.com' },
    custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null,
      annualSummaryBoardId: null, annualSummaryColumns: null, ...over },
    affiliations: null,
    donationRollups: {
      donationBoards: [{ boardId: 100, columns: { donorLink: 'd', amount: 'a', date: 'dt', status: 's', fiscalYear: 'fy', actingForLink: null } }],
      receivedStatusLabel: 'Received',
      ownerColumnsByBoard: { 'b1': OWNER_COLS },
      membership: null,
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
}

function fakeClient(state: FakeClientState): CustodianMondayClient {
  return {
    async archiveItem(itemId) {
      if (state.archiveFailFor?.has(itemId)) throw new Error(`boom ${itemId}`);
      state.archived.push(itemId);
    },
    async listWorkspaceBoards() { return state.boards ?? []; },
    async getItemsColumnsText(itemIds, columnIds) {
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
    async changeColumnValues(boardId, itemId, columnValues) {
      (state.changedColumns ??= []).push({ boardId, itemId, columnValues });
    },
  };
}

function deps(state: FakeClientState, sent: RecomputeQueueMessage[], config = testConfig()): CustodianDeps {
  return {
    gifts: new D1GiftsStore(env.DB),
    pending: new D1PendingStore(env.DB),
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
  ]);
});

const seedGift = (db: D1Database, id: string, over: Partial<{ owner: string; fy: number; cents: number; status: string; archivedAt: string | null }> = {}) =>
  db.prepare(`INSERT INTO gifts (monday_item_id, owner_item_id, owner_board_id, amount_cents, gift_date,
    fiscal_year, status, archived_at, source, updated_at)
    VALUES (?1, ?2, 'b1', ?3, '2020-01-01', ?4, ?5, ?6, 'import', 'now')`)
    .bind(id, over.owner ?? 'o1', over.cents ?? 1000, over.fy ?? 2020, over.status ?? 'Received', over.archivedAt ?? null)
    .run();

describe('dutiesForDate', () => {
  it('reconciles daily, checks capacity Mondays, sweeps July 1, archives July 15', () => {
    // requeue (fix 5) rides every night with reconcile.
    expect(dutiesForDate(new Date('2026-08-05T09:00:00Z'))).toEqual(['reconcile', 'requeue']); // a Wednesday
    expect(dutiesForDate(new Date('2026-08-03T09:00:00Z'))).toEqual(['reconcile', 'requeue', 'capacity']); // a Monday
    expect(dutiesForDate(new Date('2026-07-01T09:00:00Z'))).toEqual(['reconcile', 'requeue', 'sweep']);
    expect(dutiesForDate(new Date('2026-07-15T09:00:00Z'))).toEqual(['reconcile', 'requeue', 'archive']);
  });

  it('continues an incomplete sweep on subsequent days while its last run reports remaining > 0', async () => {
    const gifts = new D1GiftsStore(env.DB);
    await gifts.recordRun({ duty: 'sweep', ranAt: '2026-07-01T09:00:00Z', ok: true,
      report: { ok: true, summary: 'sliced', detail: { enqueued: 3500, remaining: 900, cursor: 'o3500' } } });
    expect(dutiesForDate(new Date('2026-07-02T09:00:00Z'), await gifts.lastRuns()))
      .toEqual(['reconcile', 'requeue', 'sweep']);
  });

  it('does not re-run a sweep whose last run completed (remaining === 0)', async () => {
    const gifts = new D1GiftsStore(env.DB);
    await gifts.recordRun({ duty: 'sweep', ranAt: '2026-07-01T09:00:00Z', ok: true,
      report: { ok: true, summary: 'done', detail: { enqueued: 900, remaining: 0, cursor: 'o4400' } } });
    expect(dutiesForDate(new Date('2026-07-02T09:00:00Z'), await gifts.lastRuns()))
      .toEqual(['reconcile', 'requeue']);
  });

  it('only the MOST RECENT run of a duty counts — an old incomplete run superseded by a complete one stays finished', async () => {
    const gifts = new D1GiftsStore(env.DB);
    await gifts.recordRun({ duty: 'archive', ranAt: '2026-07-15T09:00:00Z', ok: true,
      report: { ok: true, summary: 'sliced', detail: { remaining: 5 } } });
    await gifts.recordRun({ duty: 'archive', ranAt: '2026-07-16T09:00:00Z', ok: true,
      report: { ok: true, summary: 'done', detail: { remaining: 0 } } });
    expect(dutiesForDate(new Date('2026-07-17T09:00:00Z'), await gifts.lastRuns()))
      .toEqual(['reconcile', 'requeue']);
  });

  it('never doubles a duty its start date already scheduled', async () => {
    const gifts = new D1GiftsStore(env.DB);
    await gifts.recordRun({ duty: 'sweep', ranAt: '2026-06-30T09:00:00Z', ok: true,
      report: { ok: true, summary: 'sliced', detail: { remaining: 10 } } });
    expect(dutiesForDate(new Date('2026-07-01T09:00:00Z'), await gifts.lastRuns()))
      .toEqual(['reconcile', 'requeue', 'sweep']);
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
    expect(dutiesForDate(new Date('2026-07-16T09:00:00Z'), await gifts.lastRuns()))
      .toEqual(['reconcile', 'requeue', 'archive']);
    d.now = new Date('2026-08-02T00:00:00Z'); // a later ran_at, so lastRuns sees THIS run as most recent
    const second = await runDuty('archive', d);
    expect((second.detail as { remaining: number }).remaining).toBe(0);
    expect((await gifts.getAnnualSummaries()).map((s) => s.fiscalYear)).toEqual([2015]);

    // July 17: complete — archive drops back out of the schedule.
    expect(dutiesForDate(new Date('2026-07-17T09:00:00Z'), await gifts.lastRuns()))
      .toEqual(['reconcile', 'requeue']);
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
    expect(state.createdItems![0]!.columnValues).toMatchObject({ c_fy: '2015', c_total: '5', c_n: '1', c_re: null });
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
    expect(report.ok).toBe(false); // stuck rows mean the consumer lost work earlier — say so
    expect(report.summary).toContain('251');
    expect(state.updates).toHaveLength(1); // one alert
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
