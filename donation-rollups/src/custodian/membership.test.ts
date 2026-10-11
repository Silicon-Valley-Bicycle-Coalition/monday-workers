import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMembership, ENQUEUE_PER_RUN, type MembershipDetail } from './membership';
import type { CustodianDeps, CustodianMondayClient } from './custodian';
import { D1GiftsStore } from '../db/gifts';
import { D1PendingStore } from '../db/pending';
import { D1VolunteerActivityStore } from '../db/volunteerActivity';
import { D1OwnerRecomputesStore } from '../db/ownerRecomputes';
import type { DonationRollupsConfig, RecomputeQueueMessage } from '../types';

const MEMBERSHIP = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil', currentTermStart: 'mcts', memberType: 'mtype', lapseCount: 'mlc', lastLapsed: 'mll' };
const OWNER_COLS = { giftLedgerJson: 'c', lifetimeGiving: 'c', giftCount: 'c', firstGift: 'c', thisYearAmount: 'c', thisYearCount: 'c',
  lastYearAmount: 'c', lastYearCount: 'c', largestGift: 'c', smallestGift: 'c', averageGift: 'c', lastGiftDate: 'c', lastGiftAmount: 'c' };
const VOL_BOARD = { boardId: 7, columns: { attendee: 'att', event: 'ev', attendance: 'atd', role: 'role', hours: null as string | null },
  eventBoard: { boardId: 8, columns: { start: 'start' } }, volunteerRoleLabels: ['Volunteer'], countedAttendanceLabels: ['Attended'] };
const HIST_BOARD = { boardId: 9, columns: { volunteer: 'vol', date: 'dt', hours: 'hrs', status: 'st' }, countedStatusLabels: ['Completed'] };

function config(): DonationRollupsConfig {
  return {
    monday: { apiUrl: 'https://x', accountUrl: 'https://acme.monday.com' },
    fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
    custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null, annualSummaryBoardId: null, annualSummaryColumns: null },
    affiliations: null,
    donationRollups: {
      donationBoards: [{ boardId: 100, columns: { donorLink: 'd', amount: 'a', date: 'dt', status: 's', fiscalYear: null, giftType: 'gt', termStart: 'ts', termEnd: 'te', membershipType: 'mty', actingForLink: null, classification: null } }],
      receivedStatusLabel: 'Received',
      ownerColumnsByBoard: { '20': { ...OWNER_COLS, membership: MEMBERSHIP }, '28': { ...OWNER_COLS, membership: MEMBERSHIP }, '13': OWNER_COLS },
      membership: { fromISO: '2026-10-16', eligibleGiftTypes: ['Donation'], minAmountCents: 100, termMonths: 13, lifetimeThresholdCents: 100000,
        statusLabels: { active: 'Active', lapsed: 'Lapsed' }, tierLabels: { member: 'Member', lifetime: 'Lifetime' },
        typeLabels: { new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal', lifetime: 'Lifetime' } },
      donorLevel: null, volunteerBoards: [VOL_BOARD], historicalVolunteerBoards: [HIST_BOARD],
    },
  };
}

interface Fake {
  // board id -> items with column text, as pageItemsColumnsText pages them (one page)
  pages?: Record<string, { id: string; text: Record<string, string | null> }[]>;
  registrations?: { id: string; state?: 'active' | 'archived' | 'deleted'; attendeeItemId: string | null; eventItemId: string | null; attendanceLabel: string | null; roleLabel: string | null; hours: number | null }[];
  shifts?: { id: string; volunteerItemId: string | null; dateISO: string | null; hours: number | null; statusLabel: string | null }[];
  boardOf?: Record<string, string>;
  columnText?: Record<string, Record<string, string | null>>;
}
function fakeClient(f: Fake): CustodianMondayClient {
  return {
    async archiveItem() {}, async listWorkspaceBoards() { return []; }, async createUpdate() {}, async createItem() { return 'x'; }, async changeColumnValues() {},
    async pageItemsColumnsText(boardId, columnIds) {
      const items = (f.pages?.[String(boardId)] ?? []).map((i) => ({ id: i.id, text: new Map(columnIds.map((c) => [c, i.text[c] ?? null])) }));
      return { items, cursor: null };
    },
    async getItemsColumnsText(ids, columnIds) {
      const out = new Map<string, Map<string, string | null>>();
      for (const id of ids) { const rec = f.columnText?.[id]; if (rec) out.set(id, new Map(columnIds.map((c) => [c, rec[c] ?? null]))); }
      return out;
    },
    async pageRegistrations() { return { items: (f.registrations ?? []).map((r) => ({ state: 'active' as const, ...r })), cursor: null }; },
    async pageHistoricalShifts() { return { items: f.shifts ?? [], cursor: null }; },
    async getItemsBoardIds(ids) { return new Map(ids.flatMap((id) => (f.boardOf?.[id] ? [[id, f.boardOf[id]!] as [string, string]] : []))); },
  };
}
function deps(f: Fake, sent: RecomputeQueueMessage[], now = new Date('2027-12-03T10:00:00Z')): CustodianDeps {
  return { gifts: new D1GiftsStore(env.DB), pending: new D1PendingStore(env.DB), volunteers: new D1VolunteerActivityStore(env.DB),
    recomputes: new D1OwnerRecomputesStore(env.DB), mondayClient: fakeClient(f),
    queue: { sendBatch: async (m) => { sent.push(...m); } }, config: config(), now };
}

// An all=true pass at phase 3 with nothing done yet; tests override what they need.
const PASS: MembershipDetail = { all: true, since: null, phase: 'enqueue', cursor: '', remaining: 1, scanned: 0, enqueued: 0,
  loaded: 0, backfilled: 0, anniversariesThroughISO: '2027-12-02', loadedAtISO: null };

describe('membership duty — nightly anniversaries', () => {
  it('enqueues owner-keyed recomputes for people whose Current Term Start anniversary is today or yesterday', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({ pages: { '20': [
      { id: 'today', text: { mcts: '2026-11-03' } }, { id: 'yesterday', text: { mcts: '2026-11-02' } },
      { id: 'tomorrow', text: { mcts: '2026-11-04' } }, { id: 'blank', text: { mcts: null } } ],
      '28': [{ id: 'hist-today', text: { mcts: '2026-11-03 00:00' } }] } }, sent);
    const report = await runMembership(d, d.now!, { all: false, since: null }, null);
    expect(report.ok).toBe(true);
    expect(sent.map((m) => [m.ownerItemId, m.ownerBoardId])).toEqual([['today', '20'], ['yesterday', '20'], ['hist-today', '28']]);
    expect(sent[0]).toEqual({ donationItemId: 'custodian:membership', donationBoardId: '', ownerItemId: 'today', ownerBoardId: '20' });
    expect(report.detail).toMatchObject({ all: false, phase: 'anniversaries', enqueued: 3, scanned: 5, remaining: 0, anniversariesThroughISO: '2027-12-03' });
  });
  it('catches up on missed nights: everyone whose anniversary fell after the last run’s anniversariesThroughISO', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({ pages: { '20': [
      { id: 'two-days-ago', text: { mcts: '2026-11-01' } },    // anniversary 2027-12-01
      { id: 'covered', text: { mcts: '2026-10-30' } },         // anniversary 2027-11-30 — the last run had it
      { id: 'today', text: { mcts: '2026-11-03' } } ] } }, sent);
    const last: MembershipDetail = { all: false, since: null, phase: 'anniversaries', cursor: '', remaining: 0, scanned: 0, enqueued: 0,
      loaded: 0, backfilled: 0, anniversariesThroughISO: '2027-11-30', loadedAtISO: null };
    await runMembership(d, d.now!, { all: false, since: null }, last);
    expect(sent.map((m) => m.ownerItemId)).toEqual(['two-days-ago', 'today']);
  });
  it('caps the catch-up window at ANNIVERSARY_CATCH_UP_DAYS', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({ pages: { '20': [
      { id: 'in-window', text: { mcts: '2026-10-03' } },       // anniversary 2027-11-03, 30 days back
      { id: 'too-old', text: { mcts: '2026-09-01' } } ] } }, sent);   // anniversary 2027-10-01
    const last: MembershipDetail = { all: false, since: null, phase: 'anniversaries', cursor: '', remaining: 0, scanned: 0, enqueued: 0,
      loaded: 0, backfilled: 0, anniversariesThroughISO: '2027-06-01', loadedAtISO: null };
    await runMembership(d, d.now!, { all: false, since: null }, last);
    expect(sent.map((m) => m.ownerItemId)).toEqual(['in-window']);
  });
  it('a second run on the same day enqueues nobody again', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({ pages: { '20': [{ id: 'today', text: { mcts: '2026-11-03' } }] } }, sent);
    const first = await runMembership(d, d.now!, { all: false, since: null }, null);
    await runMembership(d, d.now!, { all: false, since: null }, first.detail as MembershipDetail);
    expect(sent.map((m) => m.ownerItemId)).toEqual(['today']);
  });
  it('is a no-op with a report when the membership block is null', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({}, sent);
    d.config.donationRollups.membership = null;
    const report = await runMembership(d, d.now!, { all: false, since: null }, null);
    expect(report.ok).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe('membership duty — all=true (the post-cutover recompute)', () => {
  beforeEach(async () => {
    await env.DB.batch(['volunteer_activity', 'owner_recomputes', 'gifts', 'custodian_runs'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it('phase 1 loads historical shifts and registrations into volunteer_activity with resolved owner boards', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({
      pages: { '8': [{ id: 'e1', text: { start: '2027-05-02 18:00' } }] },
      registrations: [
        { id: 'r1', attendeeItemId: 'pa', eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null },
        { id: 'r2', attendeeItemId: 'pb', eventItemId: 'e1', attendanceLabel: 'Registered', roleLabel: 'Volunteer', hours: null },
        { id: 'r3', attendeeItemId: null, eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null },
        { id: 'r4', state: 'archived', attendeeItemId: 'pd', eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null } ],
      shifts: [
        { id: 'v1', volunteerItemId: 'pc', dateISO: '2019-06-01', hours: 2, statusLabel: 'Completed' },
        { id: 'v2', volunteerItemId: 'pc', dateISO: '2019-07-01', hours: 2, statusLabel: 'Canceled' } ],
      boardOf: { pa: '20', pb: '28', pc: '28', pd: '20' },
    }, sent);
    const report = await runMembership(d, d.now!, { all: true, since: null }, null);
    const store = new D1VolunteerActivityStore(env.DB);
    expect(await store.forOwner('pa')).toEqual([expect.objectContaining({ registrationItemId: 'r1', ownerBoardId: '20', activityDateISO: '2027-05-02', qualifies: true, source: 'sweep' })]);
    expect(await store.forOwner('pb')).toEqual([]);
    expect(await store.forOwner('pd')).toEqual([]);   // archived: stored, but non-qualifying
    expect(await store.forOwner('pc')).toEqual([expect.objectContaining({ registrationItemId: 'v1', hours: 2, source: 'historical' })]);
    expect((report.detail as MembershipDetail).loaded).toBe(6);
    expect(report.detail).toMatchObject({ phase: 'enqueue', remaining: 0 });   // the tiny fixture completes in one run
  });

  it('phase 2 backfills migrated Term Starts from the board, blank as "", and skips post-cutover gifts', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const gifts = new D1GiftsStore(env.DB);
    const base = { ownerItemId: 'bf-owner', ownerBoardId: '20', amountCents: 500, fiscalYear: 2019, status: 'Received' };
    await gifts.refreshFacts([
      { ...base, mondayItemId: 'bf-1', giftDateISO: '2019-01-01' }, { ...base, mondayItemId: 'bf-2', giftDateISO: '2019-02-01' },
      { ...base, mondayItemId: 'bf-3', giftDateISO: '2026-11-01', fiscalYear: 2027 } ], 'import', 'now');
    const d = deps({ columnText: { 'bf-1': { ts: '2019-01-01 00:00' }, 'bf-2': { ts: '' } } }, sent);
    const last: MembershipDetail = { ...PASS, phase: 'backfill-terms' };
    const report = await runMembership(d, d.now!, { all: false, since: null }, last);   // nightly continuation
    expect(report.detail).toMatchObject({ phase: 'enqueue', loadedAtISO: '2027-12-03T10:00:00.000Z' });   // phase 2 finished
    const rows = await gifts.giftsForOwner('bf-owner');
    expect(rows.find((g) => g.mondayItemId === 'bf-1')?.termStart).toBe('2019-01-01');
    expect(rows.find((g) => g.mondayItemId === 'bf-2')?.termStart).toBe('');
    expect(rows.find((g) => g.mondayItemId === 'bf-3')?.termStart).toBeNull();
    expect((report.detail as MembershipDetail).backfilled).toBeGreaterThanOrEqual(2);
  });

  const seedGifts = (owners: [string, string][]) => new D1GiftsStore(env.DB).refreshFacts(owners.map(([ownerItemId, ownerBoardId]) => ({
    mondayItemId: `gift-${ownerItemId}`, ownerItemId, ownerBoardId, amountCents: 500, giftDateISO: '2020-01-01', fiscalYear: 2020, status: 'Received' })), 'import', 'now');

  it('phase 3 enqueues owners with a gift on a membership board plus check-in-only owners, once, skipping those recomputed since the given instant', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({}, sent);
    await seedGifts([['q-a', '20'], ['q-b', '20'], ['q-c', '28'], ['q-org', '13']]);   // '13' has no membership columns
    const volunteers = new D1VolunteerActivityStore(env.DB);
    await volunteers.upsert({ registrationItemId: 'q-r', boardId: '7', ownerItemId: 'q-vol', ownerBoardId: '28',
      activityDateISO: '2027-01-01', hours: null, qualifies: true, source: 'sweep' }, 'now');
    await volunteers.upsert({ registrationItemId: 'q-r99', boardId: '7', ownerItemId: 'q-elsewhere', ownerBoardId: '99',   // unconfigured board
      activityDateISO: '2027-01-01', hours: null, qualifies: true, source: 'sweep' }, 'now');
    await new D1OwnerRecomputesStore(env.DB).record({ ownerItemId: 'q-b', ownerBoardId: '20', fetchedAt: '2026-10-18T01:00:00Z', writtenAt: '2026-10-18T01:01:00Z' });
    const last: MembershipDetail = { ...PASS, since: '2026-10-18T00:00:00Z' };
    const report = await runMembership(d, d.now!, { all: false, since: null }, last);
    expect(sent.map((m) => [m.ownerItemId, m.ownerBoardId]).sort()).toEqual([['q-a', '20'], ['q-c', '28'], ['q-vol', '28']]);
    expect(sent.every((m) => m.donationItemId === 'custodian:membership')).toBe(true);
    expect(report.detail).toMatchObject({ phase: 'enqueue', remaining: 0, enqueued: 3 });
  });

  it('loadedAtISO is the wall clock when phase 2 finishes, not the run start', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({}, sent);
    delete d.now;   // production: no pinned clock
    const report = await runMembership(d, new Date('2020-01-01T00:00:00Z'), { all: false, since: null }, { ...PASS, phase: 'backfill-terms' });
    expect((report.detail as MembershipDetail).loadedAtISO! > '2026-01-01').toBe(true);
  });

  it('phase 3 skips only owners recomputed after the load finished, not ones recomputed between since and then', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({}, sent);
    await seedGifts([['l-before', '20'], ['l-after', '20']]);
    const recomputes = new D1OwnerRecomputesStore(env.DB);
    await recomputes.record({ ownerItemId: 'l-before', ownerBoardId: '20', fetchedAt: '2026-10-18T12:00:00Z', writtenAt: '2026-10-18T12:01:00Z' });
    await recomputes.record({ ownerItemId: 'l-after', ownerBoardId: '20', fetchedAt: '2026-10-19T12:00:00Z', writtenAt: '2026-10-19T12:01:00Z' });
    const last: MembershipDetail = { ...PASS, since: '2026-10-18T00:00:00Z', loadedAtISO: '2026-10-19T00:00:00Z' };
    await runMembership(d, d.now!, { all: false, since: null }, last);
    expect(sent.map((m) => m.ownerItemId)).toEqual(['l-before']);
    // With no since at all, loadedAtISO alone decides.
    sent.length = 0;
    await runMembership(d, d.now!, { all: false, since: null }, { ...PASS, loadedAtISO: '2026-10-19T00:00:00Z' });
    expect(sent.map((m) => m.ownerItemId)).toEqual(['l-before']);
  });

  it('phase 3 slices at ENQUEUE_PER_RUN and resumes from an owner-id cursor', async () => {
    const sent: RecomputeQueueMessage[] = [];
    await seedGifts(Array.from({ length: ENQUEUE_PER_RUN + 5 }, (_, i) => [`s-${String(i).padStart(5, '0')}`, '20'] as [string, string]));
    const d = deps({}, sent);
    const first = await runMembership(d, d.now!, { all: false, since: null }, PASS);
    expect(sent.length).toBe(ENQUEUE_PER_RUN);
    expect(first.detail).toMatchObject({ remaining: 5, cursor: `s-${String(ENQUEUE_PER_RUN - 1).padStart(5, '0')}` });
    const second = await runMembership(d, d.now!, { all: false, since: null }, first.detail as MembershipDetail);
    expect(sent.length).toBe(ENQUEUE_PER_RUN + 5);
    expect(second.detail).toMatchObject({ remaining: 0 });
  });

  it('anniversaries still run during an unfinished all=true pass, and the pass continues', async () => {
    const sent: RecomputeQueueMessage[] = [];
    await seedGifts([['p-giver', '20']]);
    const d = deps({ pages: { '20': [{ id: 'p-anniv', text: { mcts: '2026-11-03' } }] } }, sent);   // anniversary today
    const report = await runMembership(d, d.now!, { all: false, since: null }, PASS);
    expect(sent.map((m) => m.ownerItemId)).toEqual(['p-anniv', 'p-giver']);
    expect(report.summary).toContain('enqueued 1 anniversary recompute(s)');
    expect(report.summary).toContain('enqueued 1 owners');
    expect(report.detail).toMatchObject({ all: true, phase: 'enqueue', remaining: 0, anniversariesThroughISO: '2027-12-03' });
  });

  it('phase 3 skips an owner whose board never resolved (a deleted attendee)', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({
      pages: { '8': [{ id: 'e1', text: { start: '2027-05-02 18:00' } }] },
      registrations: [
        { id: 'g1', attendeeItemId: 'gone', eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null },
        { id: 'g2', attendeeItemId: 'here', eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null } ],
      boardOf: { here: '20' },   // 'gone' is absent, so phase 1 stores ownerBoardId null
    }, sent);
    const report = await runMembership(d, d.now!, { all: true, since: null }, null);
    expect(sent.map((m) => m.ownerItemId)).toEqual(['here']);
    expect(report.detail).toMatchObject({ phase: 'enqueue', remaining: 0, enqueued: 1 });
  });

  it('a fresh all=true after a finished pass starts over at phase 1', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({}, sent);
    const done: MembershipDetail = { ...PASS, cursor: 'zzz', remaining: 0, enqueued: 9 };
    const report = await runMembership(d, d.now!, { all: true, since: '2026-10-18T00:00:00Z' }, done);
    expect(report.detail).toMatchObject({ all: true, since: '2026-10-18T00:00:00Z', loaded: 0 });
  });
});
