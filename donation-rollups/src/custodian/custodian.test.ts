import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1GiftsStore } from '../db/gifts';
import { D1DonationLinksStore } from '../db/links';
import { dutiesForDate, runDuty, type CustodianDeps, type CustodianMondayClient, type BoardCapacity } from './custodian';
import type { DonationRollupsConfig, RecomputeQueueMessage } from '../types';

const OWNER_COLS = {
  lifetimeGiving: 'col_lt', giftCount: 'col_gc', firstGift: 'col_fg',
  thisYearAmount: 'c', thisYearCount: 'c', lastYearAmount: 'c', lastYearCount: 'c',
  largestGift: 'c', smallestGift: 'c', averageGift: 'c', lastGiftDate: 'c', lastGiftAmount: 'c',
};

function testConfig(over: Partial<DonationRollupsConfig['custodian']> = {}): DonationRollupsConfig {
  return {
    monday: { apiUrl: 'https://x' },
    custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null, annualSummaryBoardId: null, ...over },
    donationRollups: {
      donationBoards: [{ boardId: 100, columns: { donorLink: 'd', amount: 'a', date: 'dt', status: 's', fiscalYear: 'fy' } }],
      receivedStatusLabel: 'Received',
      ownerColumnsByBoard: { 'b1': OWNER_COLS },
    },
  };
}

interface FakeClientState {
  archived: string[];
  archiveFailFor?: Set<string>;
  boards?: BoardCapacity[];
  columnNumbers?: Map<string, number | null>;
  updates: { itemId: number; body: string }[];
}

function fakeClient(state: FakeClientState): CustodianMondayClient {
  return {
    async archiveItem(itemId) {
      if (state.archiveFailFor?.has(itemId)) throw new Error(`boom ${itemId}`);
      state.archived.push(itemId);
    },
    async listWorkspaceBoards() { return state.boards ?? []; },
    async getItemsColumnNumber() { return state.columnNumbers ?? new Map(); },
    async createUpdate(itemId, body) { state.updates.push({ itemId, body }); },
  };
}

function deps(state: FakeClientState, sent: RecomputeQueueMessage[], config = testConfig()): CustodianDeps {
  return {
    gifts: new D1GiftsStore(env.DB),
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
    expect(dutiesForDate(new Date('2026-08-05T09:00:00Z'))).toEqual(['reconcile']); // a Wednesday
    expect(dutiesForDate(new Date('2026-08-03T09:00:00Z'))).toEqual(['reconcile', 'capacity']); // a Monday
    expect(dutiesForDate(new Date('2026-07-01T09:00:00Z'))).toEqual(['reconcile', 'sweep']);
    expect(dutiesForDate(new Date('2026-07-15T09:00:00Z'))).toEqual(['reconcile', 'archive']);
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
  it('clean when Monday matches the ledger in rounded cents (float noise tolerated)', async () => {
    await seedGift(env.DB, 'r1', { owner: 'oA', cents: 71493 });
    const d = deps({ archived: [], updates: [], columnNumbers: new Map([['oA', 714.9300000000001]]) }, []);
    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(true);
  });

  it('reports owner mismatches and stale annual summaries, and alerts', async () => {
    await seedGift(env.DB, 'r2', { owner: 'oA', cents: 5000, fy: 2019 });
    const state: FakeClientState = { archived: [], updates: [], columnNumbers: new Map([['oA', 10]]) };
    const d = deps(state, [], testConfig({ alertItemId: 7 }));
    await d.gifts.upsertAnnualSummaries([{ fiscalYear: 2019, totalCents: 1, giftCount: 1, byTypeJson: '{}' }], 'now');

    const report = await runDuty('reconcile', d);
    expect(report.ok).toBe(false);
    const detail = report.detail as { mismatchCount: number; staleFYs: number[] };
    expect(detail.mismatchCount).toBe(1);
    expect(detail.staleFYs).toEqual([2019]);
    expect(state.updates).toHaveLength(1);
    const runs = await d.gifts.lastRuns();
    expect(runs.find((r) => r.duty === 'reconcile')!.ok).toBe(false);
  });
});
