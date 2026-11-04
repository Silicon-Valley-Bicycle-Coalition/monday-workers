import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { D1Ledger } from './db/ledger';
import { parsePromoteEvent, promoteFromWebhook, promoteOne, sweepPromotes, type PromoteSource } from './promote';
import { resolveBoards } from './pass';
import { AmbiguousWriteError, MondayApiError } from './monday/graphql';
import { config, deps, moveRows, peopleColumns, type FakeState, type Person, HIST, LIVE } from '../test/fakeMonday';

const TODAY = '2026-10-09';

function state(where: 'live' | 'historical' | 'elsewhere' | 'gone', p: Person, over: Partial<FakeState> = {}): FakeState {
  const board = { live: String(LIVE), historical: String(HIST), elsewhere: '999', gone: null }[where];
  return {
    live: where === 'live' ? [p] : [], historical: where === 'historical' ? [p] : [],
    boardOf: { [p.id]: board }, moves: [], created: [], writes: [], updates: [], ...over,
  };
}

const requested = { id: 'p1', lastGift: '2010-01-01', promote: 'Promote' };

async function one(s: FakeState, opts: { source?: PromoteSource; dryRun?: boolean; cfg?: ReturnType<typeof config> } = {}) {
  const d = deps(s, opts.cfg);
  const ledger = new D1Ledger(env.DB);
  await ledger.startRun({ runId: 'r1', trigger: 'single-move', dryRun: opts.dryRun ?? false, startedAt: '2026-10-09T17:00:00Z' });
  return promoteOne(d, await resolveBoards(d.monday, d.config), { runId: 'r1', itemId: 'p1', dryRun: opts.dryRun ?? false, source: opts.source ?? 'webhook' });
}

describe('promoteOne', () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM alerts'), env.DB.prepare('DELETE FROM runs'), env.DB.prepare('DELETE FROM pass_lease')]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('moves someone on Historical, writing the date first and Promoted last', async () => {
    const s = state('historical', requested);
    expect(await one(s)).toEqual({ outcome: 'moved', itemId: 'p1' });
    expect(s.writes).toEqual([
      { boardId: HIST, itemId: 'p1', values: { date_po_h: { date: TODAY } } },
      { boardId: LIVE, itemId: 'p1', values: { color_pp_l: { label: 'Promoted' } } },
    ]);
    expect(s.moves.map((m) => [m.itemId, m.boardId])).toEqual([['p1', LIVE]]);
    expect(await moveRows()).toMatchObject([{ item_id: 'p1', direction: 'to-live', status: 'moved', reason: 'staff-promoted', latest_activity: TODAY }]);
  });

  it('promotes someone already on People in place, with no move and no moves row', async () => {
    const s = state('live', requested);
    expect(await one(s)).toEqual({ outcome: 'promoted-in-place', itemId: 'p1' });
    expect(s.writes).toEqual([{ boardId: LIVE, itemId: 'p1', values: { date_po_l: { date: TODAY }, color_pp_l: { label: 'Promoted' } } }]);
    expect(s.moves).toEqual([]);
    expect(await moveRows()).toEqual([]);
  });

  it('finishes someone left on People at Promote by a death before the label, without moving them', async () => {
    const s = state('live', { ...requested, promotedOn: TODAY });
    expect(await one(s)).toEqual({ outcome: 'promoted-in-place', itemId: 'p1' });
    expect(s.moves).toEqual([]);
  });

  it('treats a redelivery as a no-op once the status has moved on', async () => {
    const s = state('live', { ...requested, promote: 'Promoted', promotedOn: '2026-10-01' });
    expect(await one(s)).toEqual({ outcome: 'not-requested', itemId: 'p1' });
    expect(s.writes).toEqual([]);
  });

  it('leaves someone on Historical alone unless the status is Promote', async () => {
    for (const promote of [undefined, 'Promoted', "Couldn't promote"]) {
      const s = state('historical', { ...requested, promote });
      expect(await one(s)).toEqual({ outcome: 'not-requested', itemId: 'p1' });
      expect(s.writes).toEqual([]);
      expect(s.moves).toEqual([]);
      await env.DB.prepare('DELETE FROM runs').run();
    }
  });

  it('reports a deleted item and an item on another board, writing nothing', async () => {
    const gone = state('gone', requested);
    expect(await one(gone)).toEqual({ outcome: 'not-found', itemId: 'p1' });
    await env.DB.prepare('DELETE FROM runs').run();
    const elsewhere = state('elsewhere', requested);
    expect(await one(elsewhere)).toEqual({ outcome: 'wrong-board', itemId: 'p1' });
    expect([...gone.writes!, ...elsewhere.writes!]).toEqual([]);
  });

  it('blocks when People is full: the failure label and Update, no date, no move', async () => {
    const s = state('historical', requested, { liveCount: 10000 });
    expect(await one(s)).toEqual({ outcome: 'blocked', itemId: 'p1' });
    expect(s.writes).toEqual([{ boardId: HIST, itemId: 'p1', values: { color_pp_h: { label: "Couldn't promote" } } }]);
    expect(s.updates).toEqual([{ itemId: 'p1', body: "Couldn't promote this person: the People board is full. IT has to make room first. Set Promote again after that." }]);
    expect(s.moves).toEqual([]);
  });

  it('leaves a failed webhook move at Promote for the sweep, posting nothing', async () => {
    const s = state('historical', requested, { failMove: () => new MondayApiError('nope', { httpStatus: 500 }) });
    expect(await one(s)).toMatchObject({ outcome: 'failed', itemId: 'p1' });
    expect(s.writes).toEqual([{ boardId: HIST, itemId: 'p1', values: { date_po_h: { date: TODAY } } }]);
    expect(s.updates).toEqual([]);
    expect(await moveRows()).toMatchObject([{ status: 'failed' }]);
  });

  it('gives up on a failed sweep move: the label, the date cleared in the same write, the Update', async () => {
    const s = state('historical', requested, { failMove: () => new MondayApiError('nope', { httpStatus: 500 }) });
    expect(await one(s, { source: 'sweep' })).toMatchObject({ outcome: 'failed' });
    expect(s.writes!.at(-1)).toEqual({ boardId: HIST, itemId: 'p1', values: { color_pp_h: { label: "Couldn't promote" }, date_po_h: {} } });
    expect(s.updates).toEqual([{ itemId: 'p1', body: "Couldn't promote this person: Monday wouldn't move the item, even after retrying. Set Promote again to retry, or file an IT Request if it keeps happening." }]);
  });

  it('writes no label on an ambiguous move, whichever path it came from', async () => {
    for (const source of ['webhook', 'sweep'] as const) {
      const s = state('historical', requested, { failMove: () => new AmbiguousWriteError('maybe') });
      expect(await one(s, { source })).toMatchObject({ outcome: 'ambiguous' });
      expect(s.writes).toEqual([{ boardId: HIST, itemId: 'p1', values: { date_po_h: { date: TODAY } } }]);
      expect(s.updates).toEqual([]);
      await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM runs')]);
    }
  });

  it('writes nothing to Monday in a dry run, recording the row for someone on Historical', async () => {
    const s = state('historical', requested);
    expect(await one(s, { dryRun: true })).toEqual({ outcome: 'dry-run', itemId: 'p1' });
    expect(s.writes).toEqual([]);
    expect(s.moves).toEqual([]);
    expect(await moveRows()).toMatchObject([{ status: 'dry-run', reason: 'staff-promoted' }]);
  });

  it('writes nothing in a dry run for someone on People or a full People board either', async () => {
    const onLive = state('live', requested);
    expect(await one(onLive, { dryRun: true })).toEqual({ outcome: 'dry-run', itemId: 'p1' });
    await env.DB.prepare('DELETE FROM runs').run();
    const full = state('historical', requested, { liveCount: 10000 });
    expect(await one(full, { dryRun: true })).toEqual({ outcome: 'blocked', itemId: 'p1' });
    expect([...onLive.writes!, ...full.writes!, ...full.updates!]).toEqual([]);
  });

  it('stops with an error if the date write fails: no move, no label', async () => {
    const s = state('historical', requested, { failWrite: () => new MondayApiError('nope', { httpStatus: 500 }) });
    expect(await one(s)).toMatchObject({ outcome: 'error', itemId: 'p1' });
    expect(s.moves).toEqual([]);
    expect(s.updates).toEqual([]);
  });

  it('still reports moved if the Promoted label fails, leaving the sweep to finish it', async () => {
    const s = state('historical', requested, { failWrite: (_id, values) => ('color_pp_l' in values ? new MondayApiError('nope', { httpStatus: 500 }) : null) });
    expect(await one(s)).toEqual({ outcome: 'moved', itemId: 'p1' });
    expect(s.moves).toHaveLength(1);
  });
});

describe('promoteFromWebhook', () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM alerts'), env.DB.prepare('DELETE FROM runs'), env.DB.prepare('DELETE FROM pass_lease')]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const opts = { runId: 'promote-p1', itemId: 'p1', dryRun: false };

  it('records a single-move run and releases the lease', async () => {
    const s = state('historical', requested);
    expect(await promoteFromWebhook(deps(s), opts)).toEqual({ outcome: 'moved', itemId: 'p1' });
    const ledger = new D1Ledger(env.DB);
    expect(await ledger.lastRun()).toMatchObject({ runId: 'promote-p1', trigger: 'single-move', status: 'ok' });
    expect(await ledger.acquireLease('next', '2026-10-09T17:00:00Z', '2026-10-09T18:00:00Z')).toBe(true);
  });

  it('marks the run failed when the move fails', async () => {
    const s = state('historical', requested, { failMove: () => new MondayApiError('nope', { httpStatus: 500 }) });
    await promoteFromWebhook(deps(s), opts);
    expect(await new D1Ledger(env.DB).lastRun()).toMatchObject({ status: 'failed' });
  });

  it('skips with no writes when a pass holds the lease, leaving the item at Promote', async () => {
    await new D1Ledger(env.DB).acquireLease('a-pass', '2026-10-09T17:00:00Z', '2026-10-09T18:00:00Z');
    const s = state('historical', requested);
    expect(await promoteFromWebhook(deps(s), opts)).toEqual({ outcome: 'skipped', itemId: 'p1' });
    expect(s.writes).toEqual([]);
    expect(s.moves).toEqual([]);
  });

  it('labels the item and posts the columns Update when the two boards disagree', async () => {
    const s = state('historical', requested, { historicalColumns: [...peopleColumns('h'), { id: 'extra_h', title: 'Only Here', type: 'text' }] });
    expect(await promoteFromWebhook(deps(s), opts)).toEqual({ outcome: 'blocked', itemId: 'p1' });
    expect(s.writes).toEqual([{ boardId: HIST, itemId: 'p1', values: { color_pp_h: { label: "Couldn't promote" } } }]);
    expect(s.updates).toEqual([{ itemId: 'p1', body: "Couldn't promote this person: the two People boards don't match, so moves are paused. File an IT Request, then set Promote again." }]);
  });

  it('writes no label for a disagreement in a dry run', async () => {
    const s = state('historical', requested, { historicalColumns: [...peopleColumns('h'), { id: 'extra_h', title: 'Only Here', type: 'text' }] });
    expect(await promoteFromWebhook(deps(s), { ...opts, dryRun: true })).toEqual({ outcome: 'blocked', itemId: 'p1' });
    expect(s.writes).toEqual([]);
  });

  it('returns error with no writes on any other read failure', async () => {
    const s = state('historical', requested);
    const d = deps(s);
    d.monday.getBoardSchema = async () => { throw new MondayApiError('down', { httpStatus: 503 }); };
    expect(await promoteFromWebhook(d, opts)).toMatchObject({ outcome: 'error', itemId: 'p1' });
    expect(s.writes).toEqual([]);
  });
});

describe('sweepPromotes', () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM alerts'), env.DB.prepare('DELETE FROM runs'), env.DB.prepare('DELETE FROM pass_lease')]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const opts = { runId: 'sweep', dryRun: false };
  const many = (n: number, over: Partial<FakeState> = {}): FakeState => {
    const people = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, lastGift: '2010-01-01', promote: 'Promote' }));
    return { live: [], historical: people, boardOf: Object.fromEntries(people.map((p) => [p.id, String(HIST)])), moves: [], created: [], writes: [], updates: [], ...over };
  };

  it('promotes Promote items on both boards as the last try', async () => {
    const s: FakeState = {
      live: [{ id: 'l1', promote: 'Promote' }], historical: [{ id: 'h1', lastGift: '2010-01-01', promote: 'Promote' }],
      boardOf: { l1: String(LIVE), h1: String(HIST) }, moves: [], created: [], writes: [], updates: [],
    };
    const result = await sweepPromotes(deps(s), opts);
    expect(result).toMatchObject({ found: 2 });
    expect(s.moves.map((m) => m.itemId)).toEqual(['h1']);
    expect(s.writes!.some((w) => w.itemId === 'l1' && 'date_po_l' in w.values)).toBe(true);
    expect(await new D1Ledger(env.DB).lastRun()).toMatchObject({ runId: 'sweep', trigger: 'promote-sweep', status: 'ok' });
  });

  it('records no run when it finds nothing', async () => {
    expect(await sweepPromotes(deps(many(0)), opts)).toEqual({ found: 0, results: [] });
    expect(await new D1Ledger(env.DB).lastRun()).toBeNull();
  });

  it('leaves alone someone staff changed away from Promote', async () => {
    const s = many(1);
    s.historical[0]!.promote = 'Promoted';
    expect(await sweepPromotes(deps(s), opts)).toMatchObject({ found: 0 });
    expect(s.writes).toEqual([]);
    expect(s.moves).toEqual([]);
  });

  it('skips with no label when a pass holds the lease, and promotes them once it is free', async () => {
    const ledger = new D1Ledger(env.DB);
    await ledger.acquireLease('a-pass', '2026-10-09T17:00:00Z', '2026-10-09T18:00:00Z');
    const s = many(1);
    expect(await sweepPromotes(deps(s), opts)).toHaveProperty('skipped');
    expect(s.writes).toEqual([]);
    await ledger.releaseLease('a-pass');
    expect(await sweepPromotes(deps(s), opts)).toMatchObject({ found: 1 });
    expect(s.moves).toHaveLength(1);
  });

  it('stops at maxMovesPerRun', async () => {
    const s = many(3);
    const cfg = config();
    cfg.run.maxMovesPerRun = 2;
    expect(await sweepPromotes(deps(s, cfg), opts)).toMatchObject({ found: 3 });
    expect(s.moves).toHaveLength(2);
  });

  it('stops after five consecutive failures', async () => {
    const s = many(7, { failMove: () => new MondayApiError('nope', { httpStatus: 500 }) });
    const result = await sweepPromotes(deps(s), opts);
    expect(result).toMatchObject({ found: 7 });
    expect('results' in result && result.results).toHaveLength(5);
    expect(await new D1Ledger(env.DB).lastRun()).toMatchObject({ status: 'failed' });
  });

  it('skips a run id already recorded', async () => {
    const s = many(1);
    await new D1Ledger(env.DB).startRun({ runId: 'sweep', trigger: 'promote-sweep', dryRun: false, startedAt: '2026-10-09T17:00:00Z' });
    expect(await sweepPromotes(deps(s), opts)).toHaveProperty('skipped');
    expect(s.moves).toEqual([]);
  });

  it('skips when the boards disagree, leaving items at Promote', async () => {
    const s = many(1, { historicalColumns: [...peopleColumns('h'), { id: 'extra_h', title: 'Only Here', type: 'text' }] });
    expect(await sweepPromotes(deps(s), opts)).toHaveProperty('skipped');
    expect(s.writes).toEqual([]);
  });

  it('writes nothing in a dry run', async () => {
    const s = many(1);
    expect(await sweepPromotes(deps(s), { ...opts, dryRun: true })).toMatchObject({ found: 1 });
    expect(s.writes).toEqual([]);
    expect(s.moves).toEqual([]);
  });
});

describe('parsePromoteEvent', () => {
  it('reads the item id and insists on the request label', () => {
    const event = (text: string, pulseId: unknown = 123) => ({ event: { pulseId, value: { label: { text } } } });
    expect(parsePromoteEvent(event('Promote'), 'Promote')).toEqual({ itemId: '123' });
    expect(parsePromoteEvent(event('Promote', '456'), 'Promote')).toEqual({ itemId: '456' });
    expect(parsePromoteEvent(event('Promoted'), 'Promote')).toBeNull();
    expect(parsePromoteEvent(event('Promote', {}), 'Promote')).toBeNull();
    expect(parsePromoteEvent({ event: {} }, 'Promote')).toBeNull();
    expect(parsePromoteEvent(null, 'Promote')).toBeNull();
  });
});
