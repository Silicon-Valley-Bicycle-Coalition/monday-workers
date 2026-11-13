import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { D1Ledger } from './db/ledger';
import { moveLoggedContacts } from './loggedContact';
import { runDaily } from './daily';
import { AmbiguousWriteError, MondayApiError } from './monday/graphql';
import { config, deps, moveRows, type FakeState, HIST, LIVE, LOGGED } from '../test/fakeMonday';

const opts = { runId: 'logged', dryRun: false };
const old = { lastGift: '2010-01-01' };
const base = (over: Partial<FakeState>): FakeState => ({ live: [], historical: [], moves: [], created: [], ...over });

describe('moveLoggedContacts', () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM alerts'), env.DB.prepare('DELETE FROM runs'), env.DB.prepare('DELETE FROM pass_lease')]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('moves someone on Historical with a Call inside the window', async () => {
    const s = base({ historical: [{ id: 'h', ...old }], logged: [{ id: 'a', people: ['h'], date: '2026-09-15', type: 'Call' }] });
    expect(await moveLoggedContacts(deps(s), opts)).toEqual({ planned: 1, moved: 1, failed: 0, ambiguous: 0, deferred: 0 });
    expect(s.moves.map((m) => [m.itemId, m.boardId])).toEqual([['h', LIVE]]);
    expect(await moveRows()).toMatchObject([{ item_id: 'h', direction: 'to-live', status: 'moved', reason: 'logged-contact', latest_activity: '2026-09-15' }]);
    expect(await new D1Ledger(env.DB).lastRun()).toMatchObject({ runId: 'logged', trigger: 'logged-contact', status: 'ok' });
  });

  it('leaves someone whose only logged item is a Bulk Email or before the cutoff', async () => {
    const s = base({
      historical: [{ id: 'bulk', ...old }, { id: 'older', ...old }],
      logged: [{ id: 'a', people: ['bulk'], date: '2026-09-15', type: 'Bulk Email' }, { id: 'b', people: ['older'], date: '2019-10-08', type: 'Call' }],
    });
    expect(await moveLoggedContacts(deps(s), opts)).toMatchObject({ planned: 0, moved: 0 });
    expect(s.moves).toEqual([]);
  });

  it('moves only the person on Historical when one item links people on People and a deleted item too', async () => {
    const s = base({
      live: [{ id: 'on-people' }], historical: [{ id: 'h', ...old }],
      logged: [{ id: 'a', people: ['on-people', 'h', 'deleted'], date: '2026-09-15', type: 'Meeting' }],
    });
    expect(await moveLoggedContacts(deps(s), opts)).toMatchObject({ planned: 1, moved: 1, failed: 0 });
    expect(s.moves.map((m) => m.itemId)).toEqual(['h']);
    expect(await new D1Ledger(env.DB).lastRun()).toMatchObject({ status: 'ok' });
  });

  it('uses each person\'s latest counted date, moving the most recent first', async () => {
    const s = base({
      historical: [{ id: 'first', ...old }, { id: 'second', ...old }],
      logged: [
        { id: 'a', people: ['first'], date: '2026-01-01', type: 'Email' }, { id: 'b', people: ['second'], date: '2026-02-01', type: 'Email' },
        { id: 'c', people: ['first'], date: '2026-09-01', type: 'Call' },
      ],
    });
    await moveLoggedContacts(deps(s), opts);
    expect(s.moves.map((m) => m.itemId)).toEqual(['first', 'second']);
  });

  it('caps at maxMovesPerRun and at People\'s room', async () => {
    const people = ['a', 'b', 'c'].map((id) => ({ id, ...old }));
    const logged = people.map((p) => ({ id: `l-${p.id}`, people: [p.id], date: '2026-09-15', type: 'Call' }));
    const capped = config();
    capped.run.maxMovesPerRun = 2;
    const s1 = base({ historical: people, logged });
    expect(await moveLoggedContacts(deps(s1, capped), opts)).toMatchObject({ planned: 2, deferred: 1 });
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM runs')]);
    const s2 = base({ historical: people, logged, liveCount: 9999 });
    expect(await moveLoggedContacts(deps(s2), opts)).toMatchObject({ planned: 1, deferred: 2 });
  });

  it('records dry-run rows and moves nothing in a dry run', async () => {
    const s = base({ historical: [{ id: 'h', ...old }], logged: [{ id: 'a', people: ['h'], date: '2026-09-15', type: 'Call' }] });
    expect(await moveLoggedContacts(deps(s), { ...opts, dryRun: true })).toMatchObject({ planned: 1, moved: 0 });
    expect(s.moves).toEqual([]);
    expect(await moveRows()).toMatchObject([{ status: 'dry-run' }]);
  });

  it('does nothing and records no run when loggedActivities is null', async () => {
    const s = base({ historical: [{ id: 'h', ...old }] });
    expect(await moveLoggedContacts(deps(s, config({ loggedActivities: null })), opts)).toMatchObject({ planned: 0 });
    expect(await new D1Ledger(env.DB).lastRun()).toBeNull();
  });

  it('skips when a pass holds the lease', async () => {
    await new D1Ledger(env.DB).acquireLease('a-pass', '2026-10-09T17:00:00Z', '2026-10-09T18:00:00Z');
    const s = base({ historical: [{ id: 'h', ...old }], logged: [{ id: 'a', people: ['h'], date: '2026-09-15', type: 'Call' }] });
    expect(await moveLoggedContacts(deps(s), opts)).toHaveProperty('skipped');
    expect(s.moves).toEqual([]);
  });

  it('stops after five consecutive failures, recording an ambiguous move as such', async () => {
    const people = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, ...old }));
    const logged = people.map((p) => ({ id: `l-${p.id}`, people: [p.id], date: '2026-09-15', type: 'Call' }));
    const s = base({ historical: people, logged, failMove: (id) => (id === 'p0' ? new AmbiguousWriteError('maybe') : new MondayApiError('nope', { httpStatus: 500 })) });
    expect(await moveLoggedContacts(deps(s), opts)).toEqual({ planned: 7, moved: 0, failed: 4, ambiguous: 1, deferred: 0 });
    expect(await new D1Ledger(env.DB).lastRun()).toMatchObject({ status: 'failed' });
  });

  it('finishes ok with nobody to move', async () => {
    expect(await moveLoggedContacts(deps(base({})), opts)).toEqual({ planned: 0, moved: 0, failed: 0, ambiguous: 0, deferred: 0 });
    expect(await new D1Ledger(env.DB).lastRun()).toMatchObject({ trigger: 'logged-contact', status: 'ok' });
  });

  it('settles an earlier ambiguous move first', async () => {
    const ledger = new D1Ledger(env.DB);
    await ledger.startRun({ runId: 'before', trigger: 'single-move', dryRun: false, startedAt: '2026-10-08T17:00:00Z' });
    await ledger.insertMove({ runId: 'before', itemId: 'x', fromBoardId: String(HIST), toBoardId: String(LIVE), direction: 'to-live', latestActivity: null, reason: 'r', status: 'ambiguous', plannedAt: '2026-10-08T17:00:00Z' });
    await moveLoggedContacts(deps(base({ boardOf: { x: String(LIVE) } })), opts);
    expect(await ledger.unsettledMoves()).toEqual([]);
  });
});

// A daily run reads Activities (Logged) only from shortly before the last clean live run, so a quiet
// day doesn't page the whole board, nor People (Historical) after it (#101).
describe('moveLoggedContacts — read window', () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM alerts'), env.DB.prepare('DELETE FROM runs'), env.DB.prepare('DELETE FROM pass_lease')]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const report = (over: Partial<Record<'planned' | 'moved' | 'failed' | 'ambiguous' | 'deferred', number>> = {}) =>
    ({ planned: 0, moved: 0, failed: 0, ambiguous: 0, deferred: 0, ...over });
  async function priorRun(runId: string, o: { dryRun?: boolean; status?: 'ok' | 'failed'; summary?: unknown } = {}) {
    const ledger = new D1Ledger(env.DB);
    await ledger.startRun({ runId, trigger: 'logged-contact', dryRun: o.dryRun ?? false, startedAt: '2026-10-08T17:00:00Z' });
    await ledger.finishRun(runId, o.status ?? 'ok', '2026-10-08T17:05:00Z', o.summary ?? report());
  }
  const loggedSince = (s: FakeState) => s.pageCalls?.filter((c) => c.boardId === LOGGED).map((c) => c.filter?.dateOnOrAfter.dateISO);
  const pagedHistorical = (s: FakeState) => (s.pageCalls ?? []).some((c) => c.boardId === HIST);
  // A Call from mid-September: inside the 7-year window, but well before the last clean run.
  const quiet = () => base({ historical: [{ id: 'h', ...old }], logged: [{ id: 'a', people: ['h'], date: '2026-09-15', type: 'Call' }] });

  it('reads from the window cutoff when there is no earlier live run', async () => {
    const s = quiet();
    await moveLoggedContacts(deps(s), opts);
    expect(loggedSince(s)).toEqual(['2019-10-09']);
    expect(s.moves.map((m) => m.itemId)).toEqual(['h']);
  });

  it('reads from 14 days before the last clean live run, and skips People (Historical) when nothing is new', async () => {
    await priorRun('yesterday');
    const s = quiet();
    expect(await moveLoggedContacts(deps(s), opts)).toEqual(report());
    expect(loggedSince(s)).toEqual(['2026-09-24']);
    expect(pagedHistorical(s)).toBe(false);
    expect(s.moves).toEqual([]);
  });

  it('still moves someone whose contact falls inside the narrowed window', async () => {
    await priorRun('yesterday');
    const s = base({ historical: [{ id: 'h', ...old }], logged: [{ id: 'a', people: ['h'], date: '2026-10-07', type: 'Call' }] });
    expect(await moveLoggedContacts(deps(s), opts)).toMatchObject({ planned: 1, moved: 1 });
  });

  // A few candidates on a big Historical: ask Monday where those people are rather than paging the
  // whole board to find them.
  it('looks up only the candidates\' boards instead of paging People (Historical)', async () => {
    await priorRun('yesterday');
    const historical = Array.from({ length: 1_200 }, (_, i) => ({ id: `h${i}`, ...old }));
    const candidates = ['h1', 'h2', 'h3', 'on-people', 'deleted', 'archived'];
    const s = base({
      live: [{ id: 'on-people' }], historical: [...historical, { id: 'archived', ...old }], archived: ['archived'],
      logged: candidates.map((id, i) => ({ id: `a${i}`, people: [id], date: `2026-10-0${i + 1}`, type: 'Call' })),
    });
    expect(await moveLoggedContacts(deps(s), opts)).toMatchObject({ planned: 3, moved: 3, deferred: 0 });
    expect(pagedHistorical(s)).toBe(false);
    expect(s.itemBoardCalls?.map((ids) => ids.length)).toEqual([6]);
    expect(s.moves.map((m) => m.itemId)).toEqual(['h3', 'h2', 'h1']);
    expect(s.calls?.filter((c) => c !== 'moveItemToBoard')).toEqual([
      'getBoardSchema', 'getBoardSchema', 'getBoardSchema', 'pageItems', 'getItemBoardIds',
    ]);
  });

  it('looks candidates up 100 at a time', async () => {
    const historical = Array.from({ length: 150 }, (_, i) => ({ id: `h${i}`, ...old }));
    const s = base({ historical, logged: historical.map((p) => ({ id: `l-${p.id}`, people: [p.id], date: '2026-09-15', type: 'Call' })) });
    expect(await moveLoggedContacts(deps(s), opts)).toMatchObject({ planned: 150, moved: 150 });
    expect(s.itemBoardCalls?.map((ids) => ids.length)).toEqual([100, 50]);
    expect(pagedHistorical(s)).toBe(false);
  });

  it.each([
    ['a failed run', { status: 'failed' as const }],
    ['a dry run', { dryRun: true }],
    ['a run with a failed move', { summary: report({ planned: 1, failed: 1 }) }],
    ['a run with an ambiguous move', { summary: report({ planned: 1, ambiguous: 1 }) }],
    ['a run that left people for later', { summary: report({ planned: 2, moved: 2, deferred: 1 }) }],
    ['a run recorded before deferred was counted', { summary: { planned: 0, moved: 0, failed: 0, ambiguous: 0 } }],
  ])('reads the whole window again after %s', async (_label, o) => {
    await priorRun('yesterday', o);
    const s = quiet();
    await moveLoggedContacts(deps(s), opts);
    expect(loggedSince(s)).toEqual(['2019-10-09']);
    expect(s.moves.map((m) => m.itemId)).toEqual(['h']);
  });
});

describe('runDaily and logged contact', () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM alerts'), env.DB.prepare('DELETE FROM runs'), env.DB.prepare('DELETE FROM pass_lease')]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const triggers = () => env.DB.prepare('SELECT trigger FROM runs ORDER BY rowid').all<{ trigger: string }>().then((r) => r.results.map((x) => x.trigger));
  const state = () => base({ historical: [{ id: 'h', ...old }], logged: [{ id: 'a', people: ['h'], date: '2026-09-15', type: 'Call' }] });

  it('runs when no pass is owed', async () => {
    await new D1Ledger(env.DB).startRun({ runId: 'done', trigger: 'quarterly', dryRun: false, startedAt: '2026-10-01T10:00:00Z' });
    const s = state();
    await runDaily(deps(s), { dryRun: false });
    expect(await triggers()).toEqual(['quarterly', 'logged-contact']);
    expect(s.moves.map((m) => m.itemId)).toEqual(['h']);
  });

  it('does not run on a day a pass is owed, since the pass covers it', async () => {
    const s = state();
    await runDaily(deps(s), { dryRun: false });
    expect(await triggers()).toEqual(['quarterly']);
    expect(s.moves.map((m) => m.itemId)).toEqual(['h']);
  });
});
