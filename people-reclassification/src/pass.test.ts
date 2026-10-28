import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { D1Ledger } from './db/ledger';
import { runPass, type PassDeps, type PassReport } from './pass';
import { AmbiguousWriteError, MondayApiError } from './monday/graphql';
import type { BoardSchema, ItemsPage, PageItem, ReclassificationMondayClient } from './monday/client';
import type { BoardColumn, ColumnMapping } from './columns';
import type { ReclassificationConfig } from './types';

// Fixed clock: 2026-10-09 in Los Angeles → window from 2019-10-09.
const NOW = new Date('2026-10-09T17:00:00Z');
const LIVE = 100;
const HIST = 200;
const EVENTS = 300;
const REGS = 400;
const VOLS = 500;
const IT = 600;

function config(over: Partial<ReclassificationConfig> = {}): ReclassificationConfig {
  return {
    monday: { apiUrl: 'https://x', accountUrl: 'https://acme.monday.com' },
    window: { years: 7, timeZone: 'America/Los_Angeles' },
    boards: { live: { boardId: LIVE, groupId: null }, historical: { boardId: HIST, groupId: null } },
    peopleColumns: { lastGift: 'Last Gift Date', memberUntil: 'Member Until', membershipTier: 'Membership Tier', funraiseProfile: 'Funraise Profile' },
    perpetual: { lifetimeTierLabel: 'Lifetime', funraiseLinked: true },
    eventRegistrations: {
      boardId: REGS, columns: { attendee: 'Attendee', event: 'Event', attendance: 'Attendance', source: 'Source' },
      countedAttendanceLabels: ['Attended'], countedRegisteredSources: ['Funraise'], events: { boardId: EVENTS, startColumn: 'Date' },
    },
    volunteers: { boardId: VOLS, columns: { volunteer: 'Volunteer', date: 'Date' } },
    thresholds: { itemsLimit: 10000, liveTriggerPct: 85, historicalWarnPct: 80 },
    run: { maxMovesPerRun: 400, quarterlyMonths: [1, 4, 7, 10], cronHourUTC: 10 },
    alerts: { itRequests: null },
    ...over,
  };
}

// Column ids differ per board (as on the real boards); titles agree.
const peopleColumns = (suffix: string): BoardColumn[] => [
  { id: 'name', title: 'Name', type: 'name' },
  { id: `date_lg_${suffix}`, title: 'Last Gift Date', type: 'date' },
  { id: `date_mu_${suffix}`, title: 'Member Until', type: 'date' },
  { id: `color_mt_${suffix}`, title: 'Membership Tier', type: 'status' },
  { id: `link_fp_${suffix}`, title: 'Funraise Profile', type: 'link' },
  { id: `br_org_${suffix}`, title: 'Organization', type: 'board_relation' },
  { id: `formula_${suffix}`, title: 'Age', type: 'formula' },
];

interface Person { id: string; lastGift?: string; memberUntil?: string; tier?: string; funraise?: string }
interface Registration { id: string; attendees: string[]; events: string[]; attendance?: string; source?: string }

interface FakeState {
  live: Person[];
  historical: Person[];
  liveCount?: number;
  historicalCount?: number;
  historicalColumns?: BoardColumn[];
  events?: { id: string; start?: string }[];
  registrations?: Registration[];
  volunteers?: { id: string; people: string[]; date?: string }[];
  itRequestsColumns?: BoardColumn[];
  moves: { itemId: string; boardId: number; groupId: string; mapping: ColumnMapping[] }[];
  failMove?: (itemId: string) => Error | null;
  created: { boardId: number; name: string; columnValues: Record<string, unknown> }[];
  boardOf?: Record<string, string | null>;
  pageSize?: number;
}

function personItem(p: Person, suffix: string): PageItem {
  return {
    id: p.id,
    text: new Map([
      [`date_lg_${suffix}`, p.lastGift ?? null], [`date_mu_${suffix}`, p.memberUntil ?? null],
      [`color_mt_${suffix}`, p.tier ?? null], [`link_fp_${suffix}`, p.funraise ?? null],
    ]),
    linked: new Map(),
  };
}

function fakeClient(state: FakeState): ReclassificationMondayClient {
  const schema = (id: number, name: string, columns: BoardColumn[], count: number): BoardSchema =>
    ({ id: String(id), name, itemsCount: count, itemsLimit: 10000, columns, groups: [{ id: `g_${id}`, title: 'Main' }] });
  const schemas: Record<number, BoardSchema> = {
    [LIVE]: schema(LIVE, 'People', peopleColumns('l'), state.liveCount ?? state.live.length),
    [HIST]: schema(HIST, 'People (Historical)', state.historicalColumns ?? peopleColumns('h'), state.historicalCount ?? state.historical.length),
    [EVENTS]: schema(EVENTS, 'Events', [{ id: 'date_start', title: 'Date', type: 'date' }], 0),
    [REGS]: schema(REGS, 'Event Registrations', [
      { id: 'br_att', title: 'Attendee', type: 'board_relation' }, { id: 'br_ev', title: 'Event', type: 'board_relation' },
      { id: 'color_at', title: 'Attendance', type: 'status' }, { id: 'color_src', title: 'Source', type: 'status' },
    ], 0),
    [VOLS]: schema(VOLS, 'Volunteers', [{ id: 'br_vol', title: 'Volunteer', type: 'board_relation' }, { id: 'date_d', title: 'Date', type: 'date' }], 0),
    [IT]: schema(IT, 'IT Requests', state.itRequestsColumns ?? [{ id: 'color_type', title: 'Type', type: 'status' }], 0),
  };
  const items: Record<number, PageItem[]> = {
    [LIVE]: state.live.map((p) => personItem(p, 'l')),
    [HIST]: state.historical.map((p) => personItem(p, 'h')),
    [EVENTS]: (state.events ?? []).map((e) => ({ id: e.id, text: new Map([['date_start', e.start ?? null]]), linked: new Map() })),
    [REGS]: (state.registrations ?? []).map((r) => ({
      id: r.id, text: new Map([['color_at', r.attendance ?? null], ['color_src', r.source ?? null]]),
      linked: new Map([['br_att', r.attendees], ['br_ev', r.events]]),
    })),
    [VOLS]: (state.volunteers ?? []).map((v) => ({ id: v.id, text: new Map([['date_d', v.date ?? null]]), linked: new Map([['br_vol', v.people]]) })),
  };
  return {
    async getBoardSchema(boardId) { return schemas[boardId] ?? null; },
    async pageItems(boardId, _columnIds, cursor): Promise<ItemsPage> {
      const all = items[boardId] ?? [];
      const size = state.pageSize ?? 500;
      const start = cursor === null ? 0 : Number(cursor);
      const page = all.slice(start, start + size);
      return { items: page, cursor: start + size < all.length ? String(start + size) : null };
    },
    async getItemBoardId(itemId) { return state.boardOf?.[itemId] ?? null; },
    async moveItemToBoard(itemId, boardId, groupId, mapping) {
      const err = state.failMove?.(itemId) ?? null;
      if (err) throw err;
      state.moves.push({ itemId, boardId, groupId, mapping });
    },
    async createItem(boardId, name, columnValues) {
      state.created.push({ boardId, name, columnValues });
      return `it-${state.created.length}`;
    },
  };
}

function deps(state: FakeState, cfg = config()): PassDeps {
  return { monday: fakeClient(state), ledger: new D1Ledger(env.DB), config: cfg, now: () => NOW };
}

async function pass(state: FakeState, opts: { dryRun?: boolean; runId?: string; cfg?: ReclassificationConfig } = {}): Promise<PassReport> {
  const result = await runPass(deps(state, opts.cfg), { runId: opts.runId ?? 'r1', trigger: 'http', dryRun: opts.dryRun ?? false });
  if ('skipped' in result) throw new Error(result.skipped);
  return result;
}

const moveRows = () => env.DB.prepare('SELECT item_id, direction, status, reason, latest_activity, error FROM moves ORDER BY id').all<Record<string, unknown>>().then((r) => r.results);

describe('runPass', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM alerts'), env.DB.prepare('DELETE FROM runs')]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('moves aged-out live people to Historical and reactivated Historical people back, with an explicit column mapping', async () => {
    const state: FakeState = {
      live: [
        { id: 'stale', lastGift: '2012-05-05' },
        { id: 'recent', lastGift: '2024-01-01' },
        { id: 'lifetime', tier: 'Lifetime', lastGift: '2001-01-01' },
        { id: 'funraise', funraise: 'https://platform.funraise.io/x', lastGift: '2001-01-01' },
        { id: 'member', memberUntil: '2027-03-01' },
        { id: 'nothing' },
      ],
      historical: [
        { id: 'gave-again', lastGift: '2026-09-30' },
        { id: 'still-old', lastGift: '2010-01-01' },
        { id: 'h-nothing' },
      ],
      moves: [], created: [],
    };
    const report = await pass(state);
    expect(report.error).toBeNull();
    expect(report.scanned).toEqual({ live: 6, historical: 3, registrations: 0, volunteers: 0 });
    expect(report.verdicts).toEqual({ live: 5, historical: 2, unknown: 2 });
    expect(report.decided).toEqual({ toHistorical: 1, toLive: 1 });
    expect(report.planned).toEqual({ toHistorical: 1, toLive: 1 });
    expect(report.moved).toBe(2);
    expect(report.cutoffISO).toBe('2019-10-09');
    expect(state.moves).toEqual([
      { itemId: 'stale', boardId: HIST, groupId: `g_${HIST}`, mapping: [
        { source: 'date_lg_l', target: 'date_lg_h' }, { source: 'date_mu_l', target: 'date_mu_h' },
        { source: 'color_mt_l', target: 'color_mt_h' }, { source: 'link_fp_l', target: 'link_fp_h' },
      ] },
      { itemId: 'gave-again', boardId: LIVE, groupId: `g_${LIVE}`, mapping: [
        { source: 'date_lg_h', target: 'date_lg_l' }, { source: 'date_mu_h', target: 'date_mu_l' },
        { source: 'color_mt_h', target: 'color_mt_l' }, { source: 'link_fp_h', target: 'link_fp_l' },
      ] },
    ]);
    expect(await moveRows()).toEqual([
      { item_id: 'stale', direction: 'to-historical', status: 'moved', reason: 'aged-out', latest_activity: '2012-05-05', error: null },
      { item_id: 'gave-again', direction: 'to-live', status: 'moved', reason: 'recent-activity', latest_activity: '2026-09-30', error: null },
    ]);
    const run = await env.DB.prepare('SELECT status, dry_run, summary_json FROM runs WHERE run_id = ?').bind('r1').first<{ status: string; dry_run: number; summary_json: string }>();
    expect(run?.status).toBe('ok');
    expect(run?.dry_run).toBe(0);
    expect(JSON.parse(run!.summary_json).moved).toBe(2);
  });

  it('a dry run plans and records the same moves but writes nothing to Monday', async () => {
    const state: FakeState = { live: [{ id: 'stale', lastGift: '2012-05-05' }], historical: [{ id: 'back', memberUntil: '2030-01-01' }], moves: [], created: [] };
    const report = await pass(state, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.planned).toEqual({ toHistorical: 1, toLive: 1 });
    expect(report.moved).toBe(0);
    expect(state.moves).toEqual([]);
    expect((await moveRows()).map((r) => [r.item_id, r.status])).toEqual([['stale', 'dry-run'], ['back', 'dry-run']]);
    expect((await env.DB.prepare('SELECT dry_run FROM runs').first<{ dry_run: number }>())?.dry_run).toBe(1);
  });

  it('counts event registrations and volunteer hours as activity, by the import rule', async () => {
    const state: FakeState = {
      live: [{ id: 'eb-noshow', lastGift: '2010-01-01' }, { id: 'eb-attended', lastGift: '2010-01-01' }, { id: 'fr-registered', lastGift: '2010-01-01' },
        { id: 'volunteered', lastGift: '2010-01-01' }, { id: 'future-event', lastGift: '2010-01-01' }],
      historical: [],
      events: [{ id: 'e-old', start: '2018-06-01' }, { id: 'e-new', start: '2025-06-01 10:00' }, { id: 'e-future', start: '2031-01-01' }],
      registrations: [
        { id: 'r1', attendees: ['eb-noshow'], events: ['e-new'], attendance: 'Registered', source: 'Eventbrite' },
        { id: 'r2', attendees: ['eb-attended'], events: ['e-new'], attendance: 'Attended', source: 'Eventbrite' },
        { id: 'r3', attendees: ['fr-registered'], events: ['e-new'], attendance: 'Registered', source: 'Funraise' },
        { id: 'r4', attendees: ['future-event'], events: ['e-future'], attendance: 'Attended', source: 'Funraise' },
      ],
      volunteers: [{ id: 'v1', people: ['volunteered'], date: '2023-04-04' }],
      moves: [], created: [],
    };
    const report = await pass(state);
    expect(report.scanned.registrations).toBe(4);
    expect(report.scanned.volunteers).toBe(1);
    expect(state.moves.map((m) => m.itemId).sort()).toEqual(['eb-noshow', 'future-event']);
  });

  it('pages every board, and takes the longest-lapsed people first when capped', async () => {
    const live = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, lastGift: `201${i}-01-01` }));
    const state: FakeState = { live, historical: [], moves: [], created: [], pageSize: 3 };
    const cfg = config({ run: { maxMovesPerRun: 2, quarterlyMonths: [1], cronHourUTC: 10 } });
    const report = await pass(state, { cfg });
    expect(report.scanned.live).toBe(7);
    expect(report.decided.toHistorical).toBe(7); // 2010..2016 all before 2019-10-09
    expect(report.planned.toHistorical).toBe(2);
    expect(report.remaining).toBe(5);
    expect(state.moves.map((m) => m.itemId)).toEqual(['p0', 'p1']);
  });

  it('never moves more into a board than it has room for, and says so', async () => {
    const state: FakeState = {
      live: [{ id: 'a', lastGift: '2001-01-01' }, { id: 'b', lastGift: '2002-01-01' }],
      historical: [{ id: 'c', lastGift: '2026-01-01' }, { id: 'd', lastGift: '2026-02-01' }],
      historicalCount: 9999, liveCount: 9999,
      moves: [], created: [],
    };
    const report = await pass(state);
    // Historical has room for one; after one leaves live, live (9998) has room for two.
    expect(report.planned).toEqual({ toHistorical: 1, toLive: 2 });
    expect(report.remaining).toBe(1);
    expect(report.warnings[0]).toContain('room for 1 of the 2');
    expect(state.moves.map((m) => m.itemId)).toEqual(['a', 'd', 'c']);
  });

  it('refuses to move anything when the two boards disagree on a value-bearing column', async () => {
    const state: FakeState = {
      live: [{ id: 'stale', lastGift: '2001-01-01' }], historical: [],
      historicalColumns: peopleColumns('h').filter((c) => c.title !== 'Funraise Profile'),
      moves: [], created: [],
    };
    await expect(pass(state)).rejects.toThrow('missing on People (Historical): "Funraise Profile" (link)');
    expect(state.moves).toEqual([]);
    expect((await env.DB.prepare('SELECT status FROM runs').first<{ status: string }>())?.status).toBe('failed');
  });

  it('records a failed move and an ambiguous one, keeps going, and stops after five failures in a row', async () => {
    const live = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, lastGift: `200${i}-01-01` }));
    const state: FakeState = {
      live, historical: [], moves: [], created: [],
      failMove: (id) => id === 'p0' ? new AmbiguousWriteError('monday API: timed out (the write may have committed)', {})
        : id >= 'p2' ? new MondayApiError('monday API: HTTP 500', { httpStatus: 500 }) : null,
    };
    const report = await pass(state);
    expect(report.moved).toBe(1);
    expect(report.ambiguous).toBe(1);
    expect(report.failed).toBe(5);
    expect(report.error).toContain('5 consecutive move failures');
    expect(report.remaining).toBe(1);
    expect((await moveRows()).map((r) => [r.item_id, r.status])).toEqual([
      ['p0', 'ambiguous'], ['p1', 'moved'], ['p2', 'failed'], ['p3', 'failed'], ['p4', 'failed'], ['p5', 'failed'], ['p6', 'failed'],
    ]);
    expect((await env.DB.prepare('SELECT status FROM runs').first<{ status: string }>())?.status).toBe('failed');
  });

  it('settles planned and ambiguous rows from an earlier pass by where the item is now', async () => {
    const ledger = new D1Ledger(env.DB);
    await ledger.startRun({ runId: 'r0', trigger: 'quarterly', dryRun: false, startedAt: '2026-10-01T10:00:00Z' });
    const base = { runId: 'r0', fromBoardId: String(LIVE), toBoardId: String(HIST), direction: 'to-historical' as const, latestActivity: '2001-01-01', reason: 'aged-out', plannedAt: 'then' };
    await ledger.insertMove({ ...base, itemId: 'landed', status: 'ambiguous' });
    await ledger.insertMove({ ...base, itemId: 'stayed', status: 'planned' });
    await ledger.insertMove({ ...base, itemId: 'gone', status: 'planned' });
    const state: FakeState = { live: [], historical: [], moves: [], created: [], boardOf: { landed: String(HIST), stayed: String(LIVE), gone: null } };
    const report = await pass(state);
    expect(report.settled).toBe(3);
    expect((await moveRows()).map((r) => [r.item_id, r.status, r.error])).toEqual([
      ['landed', 'moved', null],
      ['stayed', 'failed', 'never moved (settled by a later pass)'],
      ['gone', 'failed', 'item no longer visible (settled by a later pass)'],
    ]);
  });

  it('is idempotent on run id: a repeated run id does nothing', async () => {
    const state: FakeState = { live: [{ id: 'stale', lastGift: '2001-01-01' }], historical: [], moves: [], created: [] };
    await pass(state);
    const second = await runPass(deps(state), { runId: 'r1', trigger: 'http', dryRun: false });
    expect(second).toEqual({ skipped: 'run r1 already recorded (ok)' });
    expect(state.moves).toHaveLength(1);
  });

  it('warns when Historical nears its ceiling and raises one IT Requests item per cooldown', async () => {
    const cfg = config({ alerts: { itRequests: { boardId: IT, typeColumn: 'Type', typeLabel: 'IT Support', cooldownDays: 30 } } });
    const state: FakeState = { live: [{ id: 'stale', lastGift: '2001-01-01' }], historical: [], historicalCount: 8100, moves: [], created: [] };
    const report = await pass(state, { cfg });
    expect(report.warnings).toEqual([expect.stringContaining('People (Historical) is at 81% of its 10000-item limit (8101 items)')]);
    expect(state.created).toEqual([{ boardId: IT, name: expect.stringContaining('81%'), columnValues: { color_type: { label: 'IT Support' } } }]);
    expect(warn).toHaveBeenCalledTimes(1);

    await pass(state, { cfg, runId: 'r2' });
    expect(state.created).toHaveLength(1); // inside the cooldown
    const dry = await pass({ ...state, historicalCount: 8100 }, { cfg: config({ alerts: cfg.alerts, thresholds: { ...cfg.thresholds, historicalWarnPct: 50 } }), runId: 'r3', dryRun: true });
    expect(dry.warnings).toHaveLength(1);
    expect(state.created).toHaveLength(1); // a dry run never creates the item either
  });

  it('a log-only config warns without creating anything', async () => {
    const state: FakeState = { live: [], historical: [], historicalCount: 9000, moves: [], created: [] };
    const report = await pass(state);
    expect(report.warnings).toHaveLength(1);
    expect(state.created).toEqual([]);
  });

  it('fails loudly on a 0 placeholder board id or a board the token cannot see', async () => {
    const state: FakeState = { live: [], historical: [], moves: [], created: [] };
    await expect(pass(state, { cfg: config({ boards: { live: { boardId: 0, groupId: null }, historical: { boardId: HIST, groupId: null } } }) }))
      .rejects.toThrow('People board id is the 0 placeholder');
    await expect(pass(state, { runId: 'r2', cfg: config({ boards: { live: { boardId: 999, groupId: null }, historical: { boardId: HIST, groupId: null } } }) }))
      .rejects.toThrow('People board 999 is not visible');
  });

  it('uses a configured group and rejects one the board lacks', async () => {
    const state: FakeState = { live: [{ id: 'stale', lastGift: '2001-01-01' }], historical: [], moves: [], created: [] };
    await pass(state, { cfg: config({ boards: { live: { boardId: LIVE, groupId: null }, historical: { boardId: HIST, groupId: `g_${HIST}` } } }) });
    expect(state.moves[0]?.groupId).toBe(`g_${HIST}`);
    await expect(pass(state, { runId: 'r2', cfg: config({ boards: { live: { boardId: LIVE, groupId: null }, historical: { boardId: HIST, groupId: 'nope' } } }) }))
      .rejects.toThrow('configured group "nope" does not exist');
  });
});
