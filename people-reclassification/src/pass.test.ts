import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { D1Ledger } from './db/ledger';
import { moveOneToPeople, runPass, type PassReport } from './pass';
import { AmbiguousWriteError, MondayApiError } from './monday/graphql';
import type { BoardColumn } from './columns';
import type { ReclassificationConfig } from './types';
import { config, deps, fakeClient, moveRows, peopleColumns, type FakeState, type Person, EVENTS, HIST, IT, LIVE, LOGGED, REGS, VOLS, NOW } from '../test/fakeMonday';

async function pass(state: FakeState, opts: { dryRun?: boolean; runId?: string; cfg?: ReclassificationConfig } = {}): Promise<PassReport> {
  const result = await runPass(deps(state, opts.cfg), { runId: opts.runId ?? 'r1', trigger: 'http', dryRun: opts.dryRun ?? false });
  if ('skipped' in result) throw new Error(result.skipped);
  return result;
}


describe('runPass', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM alerts'), env.DB.prepare('DELETE FROM runs'), env.DB.prepare('DELETE FROM pass_lease')]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  describe('logged contact and promotions', () => {
    const old = { lastGift: '2010-01-01' };
    const empty = () => ({ moves: [], created: [] });

    it('a Call logged last month brings someone on Historical back', async () => {
      const state: FakeState = { live: [], historical: [{ id: 'h', ...old }], logged: [{ id: 'a', people: ['h'], date: '2026-09-15', type: 'Call' }], ...empty() };
      const report = await pass(state);
      expect(state.moves.map((m) => [m.itemId, m.boardId])).toEqual([['h', LIVE]]);
      expect(report.scanned.logged).toBe(1);
    });

    it('a Bulk Email does not', async () => {
      const state: FakeState = { live: [], historical: [{ id: 'h', ...old }], logged: [{ id: 'a', people: ['h'], date: '2026-09-15', type: 'Bulk Email' }], ...empty() };
      await pass(state);
      expect(state.moves).toEqual([]);
    });

    it('a logged item with no Date or no Person counts for nobody', async () => {
      const state: FakeState = {
        live: [], historical: [{ id: 'h', ...old }],
        logged: [{ id: 'a', people: ['h'], type: 'Email' }, { id: 'b', date: '2026-09-15', type: 'Email' }], ...empty(),
      };
      await pass(state);
      expect(state.moves).toEqual([]);
    });

    it('a recent Promoted On brings someone back and keeps someone on People', async () => {
      const state: FakeState = {
        live: [{ id: 'l', ...old, promotedOn: '2026-09-15' }], historical: [{ id: 'h', ...old, promotedOn: '2026-09-15' }], ...empty(),
      };
      await pass(state);
      expect(state.moves.map((m) => [m.itemId, m.boardId])).toEqual([['h', LIVE]]);
    });

    it('moveOneToPeople no longer refuses someone whose only recent activity is a logged Email', async () => {
      const state: FakeState = {
        live: [], historical: [{ id: 'h', ...old }], logged: [{ id: 'a', people: ['h'], date: '2026-09-15', type: 'Email' }],
        boardOf: { h: String(HIST) }, ...empty(),
      };
      const result = await moveOneToPeople(deps(state), { runId: 'one', itemId: 'h', dryRun: false });
      expect(result).toMatchObject({ outcome: 'moved', latestActivity: '2026-09-15' });
    });

    it('loggedActivities: null reads no such board', async () => {
      const state: FakeState = { live: [], historical: [{ id: 'h', ...old }], logged: [{ id: 'a', people: ['h'], date: '2026-09-15', type: 'Call' }], ...empty() };
      const report = await pass(state, { cfg: config({ loggedActivities: null }) });
      expect(state.moves).toEqual([]);
      expect(report.scanned.logged).toBe(0);
    });
  });

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
    expect(report.scanned).toEqual({ live: 6, historical: 3, registrations: 0, volunteers: 0, logged: 0 });
    expect(report.verdicts).toEqual({ live: 5, historical: 2, unknown: 2 });
    expect(report.decided).toEqual({ toHistorical: 1, toLive: 1 });
    expect(report.planned).toEqual({ toHistorical: 1, toLive: 1 });
    expect(report.moved).toBe(2);
    expect(report.cutoffISO).toBe('2019-10-09');
    expect(state.moves).toEqual([
      // Every source column but the name, once (Monday rejects a partial mapping and a mapped
      // name): connect columns map by title, formula columns go to null.
      { itemId: 'stale', boardId: HIST, groupId: `g_${HIST}`, mapping: [
        { source: 'date_lg_l', target: 'date_lg_h' }, { source: 'date_mu_l', target: 'date_mu_h' },
        { source: 'color_mt_l', target: 'color_mt_h' }, { source: 'link_fp_l', target: 'link_fp_h' },
        { source: 'br_org_l', target: 'br_org_h' }, { source: 'formula_l', target: null },
        { source: 'color_pp_l', target: 'color_pp_h' }, { source: 'date_po_l', target: 'date_po_h' },
      ] },
      { itemId: 'gave-again', boardId: LIVE, groupId: `g_${LIVE}`, mapping: [
        { source: 'date_lg_h', target: 'date_lg_l' }, { source: 'date_mu_h', target: 'date_mu_l' },
        { source: 'color_mt_h', target: 'color_mt_l' }, { source: 'link_fp_h', target: 'link_fp_l' },
        { source: 'br_org_h', target: 'br_org_l' }, { source: 'formula_h', target: null },
        { source: 'color_pp_h', target: 'color_pp_l' }, { source: 'date_po_h', target: 'date_po_l' },
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

  it('runs one pass at a time: a pass that finds the lease held is skipped and touches nothing (#64)', async () => {
    const state: FakeState = { live: [{ id: 'stale', lastGift: '2001-01-01' }], historical: [], moves: [], created: [] };
    await env.DB.prepare("INSERT INTO pass_lease (id, holder, expires_at) VALUES (1, 'cron-other', '2026-10-09T17:20:00Z')").run();
    const result = await runPass(deps(state), { runId: 'r1', trigger: 'http', dryRun: true });
    expect(result).toEqual({ skipped: 'another pass is running; run r1 not started' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runs').first('n')).toBe(0);
    expect(state.moves).toHaveLength(0);
  });

  it('takes over a lease whose holder died (expired), and releases its own when done or failed', async () => {
    const state: FakeState = { live: [{ id: 'stale', lastGift: '2001-01-01' }], historical: [], moves: [], created: [] };
    await env.DB.prepare("INSERT INTO pass_lease (id, holder, expires_at) VALUES (1, 'dead', '2026-10-09T16:00:00Z')").run();
    await pass(state);
    expect(state.moves).toHaveLength(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pass_lease').first('n')).toBe(0);
    const failing = { ...deps(state), monday: { ...fakeClient(state), getBoardSchema: async () => { throw new Error('boom'); } } };
    await expect(runPass(failing, { runId: 'r2', trigger: 'http', dryRun: true })).rejects.toThrow('boom');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pass_lease').first('n')).toBe(0);
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

describe('moveOneToPeople', () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM alerts'), env.DB.prepare('DELETE FROM runs'), env.DB.prepare('DELETE FROM pass_lease')]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const onHistorical = (p: Person, over: Partial<FakeState> = {}): FakeState =>
    ({ live: [], historical: [p], boardOf: { [p.id]: String(HIST) }, moves: [], created: [], ...over });
  const move = (state: FakeState, opts: { dryRun?: boolean; itemId?: string; cfg?: ReclassificationConfig } = {}) =>
    moveOneToPeople(deps(state, opts.cfg), { runId: 'single-1', itemId: opts.itemId ?? 'p1', dryRun: opts.dryRun ?? false });
  const leaseFree = async () => {
    const ledger = new D1Ledger(env.DB);
    expect(await ledger.acquireLease('probe', NOW.toISOString(), new Date(NOW.getTime() + 1000).toISOString())).toBe(true);
    await ledger.releaseLease('probe');
  };

  it('moves a person with recent activity to People with the explicit mapping, and records it as a single-move run', async () => {
    const state = onHistorical({ id: 'p1', lastGift: '2026-09-30' });
    expect(await move(state)).toMatchObject({ outcome: 'moved', itemId: 'p1', reason: 'recent-activity', latestActivity: '2026-09-30' });
    expect(state.moves).toEqual([{ itemId: 'p1', boardId: LIVE, groupId: `g_${LIVE}`, mapping: [
      { source: 'date_lg_h', target: 'date_lg_l' }, { source: 'date_mu_h', target: 'date_mu_l' },
      { source: 'color_mt_h', target: 'color_mt_l' }, { source: 'link_fp_h', target: 'link_fp_l' },
      { source: 'br_org_h', target: 'br_org_l' }, { source: 'formula_h', target: null },
        { source: 'color_pp_h', target: 'color_pp_l' }, { source: 'date_po_h', target: 'date_po_l' },
    ] }]);
    expect(await moveRows()).toEqual([{ item_id: 'p1', direction: 'to-live', status: 'moved', reason: 'recent-activity', latest_activity: '2026-09-30', error: null }]);
    const run = await new D1Ledger(env.DB).lastRun();
    expect(run).toMatchObject({ runId: 'single-1', trigger: 'single-move', status: 'ok', dryRun: false });
    await leaseFree();
  });

  it('counts registrations and volunteer hours, which only the activity boards hold', async () => {
    const reg = onHistorical({ id: 'p1', lastGift: '2010-01-01' }, {
      events: [{ id: 'e1', start: '2025-05-01' }],
      registrations: [{ id: 'r1', attendees: ['p1'], events: ['e1'], attendance: 'Attended' }],
    });
    expect(await move(reg)).toMatchObject({ outcome: 'moved', latestActivity: '2025-05-01' });
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM runs')]);
    const vol = onHistorical({ id: 'p1', lastGift: '2010-01-01' }, { volunteers: [{ id: 'v1', people: ['p1'], date: '2024-06-01' }] });
    expect(await move(vol)).toMatchObject({ outcome: 'moved', latestActivity: '2024-06-01' });
  });

  it('ignores activity that belongs to someone else', async () => {
    const state = onHistorical({ id: 'p1', lastGift: '2010-01-01' }, { volunteers: [{ id: 'v1', people: ['other'], date: '2024-06-01' }] });
    expect(await move(state)).toMatchObject({ outcome: 'refused' });
  });

  it('refuses someone the next pass would send straight back, and writes nothing', async () => {
    const state = onHistorical({ id: 'p1', lastGift: '2010-01-01' });
    expect(await move(state)).toEqual({ outcome: 'refused', itemId: 'p1', latestActivity: '2010-01-01', cutoffISO: '2019-10-09' });
    expect(state.moves).toEqual([]);
    expect(await moveRows()).toEqual([]);
    expect(await new D1Ledger(env.DB).lastRun()).toBeNull();
    await leaseFree();
  });

  it('moves someone with no evidence, since no pass ever moves them back', async () => {
    const state = onHistorical({ id: 'p1' });
    expect(await move(state)).toMatchObject({ outcome: 'moved', reason: 'no-evidence', latestActivity: null });
    expect(state.moves).toHaveLength(1);
  });

  it('a dry run records the plan and does not call Monday', async () => {
    const state = onHistorical({ id: 'p1', lastGift: '2026-09-30' });
    expect(await move(state, { dryRun: true })).toMatchObject({ outcome: 'dry-run', reason: 'recent-activity' });
    expect(state.moves).toEqual([]);
    expect(await moveRows()).toMatchObject([{ item_id: 'p1', status: 'dry-run' }]);
    expect(await new D1Ledger(env.DB).lastRun()).toMatchObject({ trigger: 'single-move', dryRun: true, status: 'ok' });
  });

  it('never touches an item that is not on People (Historical)', async () => {
    const already = onHistorical({ id: 'p1' }, { boardOf: { p1: String(LIVE) } });
    expect(await move(already)).toEqual({ outcome: 'already-on-people', itemId: 'p1' });
    const missing = onHistorical({ id: 'p1' }, { boardOf: {} });
    expect(await move(missing)).toEqual({ outcome: 'not-found', itemId: 'p1' });
    const elsewhere = onHistorical({ id: 'p1' }, { boardOf: { p1: '999' } });
    expect(await move(elsewhere)).toEqual({ outcome: 'wrong-board', itemId: 'p1', boardId: '999' });
    expect([...already.moves, ...missing.moves, ...elsewhere.moves]).toEqual([]);
    expect(await moveRows()).toEqual([]);
    await leaseFree();
  });

  it('is skipped while a pass holds the lease, and leaves that lease alone', async () => {
    const ledger = new D1Ledger(env.DB);
    await ledger.acquireLease('pass', NOW.toISOString(), new Date(NOW.getTime() + 60_000).toISOString());
    const state = onHistorical({ id: 'p1', lastGift: '2026-09-30' });
    expect(await move(state)).toMatchObject({ outcome: 'skipped' });
    expect(state.moves).toEqual([]);
    expect(await ledger.acquireLease('other', NOW.toISOString(), new Date(NOW.getTime() + 60_000).toISOString())).toBe(false);
  });

  it('refuses when People has no room', async () => {
    const state = onHistorical({ id: 'p1', lastGift: '2026-09-30' }, { liveCount: 10000 });
    expect(await move(state)).toMatchObject({ outcome: 'error', error: expect.stringContaining('no room') });
    expect(state.moves).toEqual([]);
  });

  it('reports a column disagreement as an error without moving, and frees the lease', async () => {
    const state = onHistorical({ id: 'p1', lastGift: '2026-09-30' }, { historicalColumns: [...peopleColumns('h'), { id: 'extra', title: 'Extra', type: 'text' }] });
    expect(await move(state)).toMatchObject({ outcome: 'error', error: expect.stringContaining('disagree on columns') });
    expect(state.moves).toEqual([]);
    await leaseFree();
  });

  it('records a failed move, and leaves an ambiguous one for the next pass to settle', async () => {
    const failed = onHistorical({ id: 'p1', lastGift: '2026-09-30' }, { failMove: () => new MondayApiError('nope', { httpStatus: 500 }) });
    expect(await move(failed)).toMatchObject({ outcome: 'failed' });
    expect(await moveRows()).toMatchObject([{ status: 'failed' }]);
    expect(await new D1Ledger(env.DB).lastRun()).toMatchObject({ status: 'failed' });
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM runs')]);
    const ambiguous = onHistorical({ id: 'p1', lastGift: '2026-09-30' }, { failMove: () => new AmbiguousWriteError('timed out') });
    expect(await move(ambiguous)).toMatchObject({ outcome: 'ambiguous' });
    expect((await new D1Ledger(env.DB).unsettledMoves()).map((m) => m.itemId)).toEqual(['p1']);
  });
});
