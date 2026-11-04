import { describe, it, expect, vi } from 'vitest';
import { createApp, type RoutesDeps } from './routes';
import type { WriteMode } from './flags';
import type { PassReport, SingleMoveResult } from './pass';

const report = (over: Partial<PassReport> = {}): PassReport => ({
  runId: 'x', trigger: 'http', dryRun: true, todayISO: '2026-10-09', cutoffISO: '2019-10-09',
  live: { boardId: '1', name: 'People', itemsCount: 1, itemsLimit: 10000, pct: 0 },
  historical: { boardId: '2', name: 'People (Historical)', itemsCount: 1, itemsLimit: 10000, pct: 0 },
  scanned: { live: 0, historical: 0, registrations: 0, volunteers: 0, logged: 0 }, verdicts: { live: 0, historical: 0, unknown: 0 },
  decided: { toHistorical: 0, toLive: 0 }, planned: { toHistorical: 0, toLive: 0 },
  moved: 0, failed: 0, ambiguous: 0, settled: 0, remaining: 0, warnings: [], error: null, ...over,
});

const AUTH = { Authorization: 'Bearer s3cret' };

function app(over: Partial<RoutesDeps> = {}) {
  const deps: RoutesDeps = {
    runPass: vi.fn(async (opts) => report({ dryRun: opts.dryRun, runId: opts.runId })),
    moveToPeople: vi.fn(async (opts): Promise<SingleMoveResult> => ({ outcome: opts.dryRun ? 'dry-run' : 'moved', itemId: opts.itemId, reason: 'recent-activity', latestActivity: '2026-01-01' })),
    recentRuns: vi.fn(async () => []),
    mode: vi.fn(async (): Promise<WriteMode> => 'off'),
    secret: 's3cret',
    now: () => new Date('2026-10-09T17:00:00.123Z'),
    ...over,
  };
  return { deps, app: createApp(deps) };
}

describe('/reclassify routes', () => {
  it('rejects a missing or wrong secret, and every request when no secret is configured', async () => {
    const { app: a } = app();
    expect((await a.request('/reclassify/status')).status).toBe(401);
    expect((await a.request('/reclassify/run', { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await a.request('/reclassify/run', { method: 'POST', headers: { Authorization: 's3cret' } })).status).toBe(401);
    const { app: b, deps } = app({ secret: undefined });
    expect((await b.request('/reclassify/run', { method: 'POST', headers: AUTH })).status).toBe(401);
    expect(deps.runPass).not.toHaveBeenCalled();
  });

  it('no longer accepts the secret in the query string (#64)', async () => {
    const { app: a, deps } = app();
    expect((await a.request('/reclassify/status?secret=s3cret')).status).toBe(401);
    expect((await a.request('/reclassify/run?secret=s3cret', { method: 'POST' })).status).toBe(401);
    expect(deps.runPass).not.toHaveBeenCalled();
  });

  it('status reports the write mode and recent runs', async () => {
    const { app: a } = app({ mode: async () => 'hold' });
    const res = await a.request('/reclassify/status', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'hold', runs: [] });
  });

  it('run with no dryRun param follows the mode: off is a dry pass, on is live, and names the run after the clock', async () => {
    const { app: a, deps } = app({ mode: async () => 'off' });
    const res = await a.request('/reclassify/run', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
    expect(deps.runPass).toHaveBeenCalledWith({ dryRun: true, runId: 'http-2026-10-09T17-00-00-123Z' });
    expect(await res.json()).toMatchObject({ ok: true, dryRun: true });
    const { app: b, deps: live } = app({ mode: async () => 'on' });
    await b.request('/reclassify/run', { method: 'POST', headers: AUTH });
    expect(live.runPass).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
  });

  it('run with no dryRun param is refused with 409 under hold and unknown', async () => {
    for (const mode of ['hold', 'unknown'] as const) {
      const { app: a, deps } = app({ mode: async () => mode });
      expect((await a.request('/reclassify/run', { method: 'POST', headers: AUTH })).status).toBe(409);
      expect(deps.runPass).not.toHaveBeenCalled();
    }
  });

  it('dryRun=true forces a dry pass in on, off and hold, but not when the mode is unknown', async () => {
    for (const mode of ['on', 'off', 'hold'] as const) {
      const { app: a, deps } = app({ mode: async () => mode });
      expect((await a.request('/reclassify/run?dryRun=true', { method: 'POST', headers: AUTH })).status).toBe(200);
      expect(deps.runPass).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    }
    const { app: u, deps } = app({ mode: async () => 'unknown' });
    expect((await u.request('/reclassify/run?dryRun=true', { method: 'POST', headers: AUTH })).status).toBe(503);
    expect(deps.runPass).not.toHaveBeenCalled();
  });

  it('dryRun=false is no longer accepted, in any mode; other values are 400 too', async () => {
    const { app: a, deps } = app({ mode: async () => 'on' });
    const res = await a.request('/reclassify/run?dryRun=false', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'dryRun=false is no longer accepted; use scripts/flags.mjs' });
    expect((await a.request('/reclassify/run?dryRun=yes', { method: 'POST', headers: AUTH })).status).toBe(400);
    expect(deps.runPass).not.toHaveBeenCalled();
  });

  it('a pass that stopped early reports ok: false; a skipped one (lease held, run recorded) is a 409', async () => {
    const { app: a } = app({ runPass: async () => report({ error: 'stopped' }) });
    expect(await (await a.request('/reclassify/run', { method: 'POST', headers: AUTH })).json()).toMatchObject({ ok: false, error: 'stopped' });
    const { app: b } = app({ runPass: async () => ({ skipped: 'another pass is running' }) });
    const res = await b.request('/reclassify/run', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, skipped: 'another pass is running' });
  });
});

describe('POST /reclassify/move-to-people/:itemId', () => {
  const post = (a: ReturnType<typeof app>['app'], path: string, headers: Record<string, string> = AUTH) =>
    a.request(`/reclassify/move-to-people/${path}`, { method: 'POST', headers });

  it('needs the secret and a numeric item id', async () => {
    const { app: a, deps } = app();
    expect((await post(a, '123', {})).status).toBe(401);
    expect((await post(a, 'abc')).status).toBe(400);
    expect(deps.moveToPeople).not.toHaveBeenCalled();
  });

  it('follows the write mode like /run: off is a dry run, on is live, hold and unknown are refused', async () => {
    const off = app({ mode: async () => 'off' });
    expect((await post(off.app, '123')).status).toBe(200);
    expect(off.deps.moveToPeople).toHaveBeenCalledWith({ itemId: '123', dryRun: true, runId: 'move-123-2026-10-09T17-00-00-123Z' });
    const on = app({ mode: async () => 'on' });
    await post(on.app, '123');
    expect(on.deps.moveToPeople).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
    for (const mode of ['hold', 'unknown'] as const) {
      const held = app({ mode: async () => mode });
      expect((await post(held.app, '123')).status).toBe(409);
      expect(held.deps.moveToPeople).not.toHaveBeenCalled();
    }
  });

  it('dryRun=true forces a preview, except when the mode is unknown; dryRun=false is rejected', async () => {
    const on = app({ mode: async () => 'on' });
    expect((await post(on.app, '123?dryRun=true')).status).toBe(200);
    expect(on.deps.moveToPeople).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect((await post(app({ mode: async () => 'unknown' }).app, '123?dryRun=true')).status).toBe(503);
    expect((await post(app({ mode: async () => 'on' }).app, '123?dryRun=false')).status).toBe(400);
  });

  it('maps each outcome to a status, and ok only when the person is on People or would be', async () => {
    const cases: [SingleMoveResult, number, boolean][] = [
      [{ outcome: 'moved', itemId: '123', reason: 'recent-activity', latestActivity: '2026-01-01' }, 200, true],
      [{ outcome: 'dry-run', itemId: '123', reason: 'recent-activity', latestActivity: '2026-01-01' }, 200, true],
      [{ outcome: 'already-on-people', itemId: '123' }, 200, true],
      [{ outcome: 'not-found', itemId: '123' }, 404, false],
      [{ outcome: 'wrong-board', itemId: '123', boardId: '9' }, 409, false],
      [{ outcome: 'refused', itemId: '123', latestActivity: '2010-01-01', cutoffISO: '2019-10-09' }, 409, false],
      [{ outcome: 'skipped', itemId: '123', error: 'another pass is running' }, 409, false],
      [{ outcome: 'failed', itemId: '123', error: 'nope' }, 502, false],
      [{ outcome: 'ambiguous', itemId: '123', error: 'timed out' }, 502, false],
      [{ outcome: 'error', itemId: '123', error: 'nope' }, 502, false],
    ];
    for (const [result, status, ok] of cases) {
      const { app: a } = app({ mode: async () => 'on', moveToPeople: async () => result });
      const res = await post(a, '123');
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ ok, ...result });
    }
  });
});
