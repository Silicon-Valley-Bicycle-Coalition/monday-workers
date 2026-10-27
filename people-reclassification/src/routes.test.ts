import { describe, it, expect, vi } from 'vitest';
import { createApp, type RoutesDeps } from './routes';
import type { WriteMode } from './flags';
import type { PassReport } from './pass';

const report = (over: Partial<PassReport> = {}): PassReport => ({
  runId: 'x', trigger: 'http', dryRun: true, todayISO: '2026-10-09', cutoffISO: '2019-10-09',
  live: { boardId: '1', name: 'People', itemsCount: 1, itemsLimit: 10000, pct: 0 },
  historical: { boardId: '2', name: 'People (Historical)', itemsCount: 1, itemsLimit: 10000, pct: 0 },
  scanned: { live: 0, historical: 0, registrations: 0, volunteers: 0 }, verdicts: { live: 0, historical: 0, unknown: 0 },
  decided: { toHistorical: 0, toLive: 0 }, planned: { toHistorical: 0, toLive: 0 },
  moved: 0, failed: 0, ambiguous: 0, settled: 0, remaining: 0, warnings: [], error: null, ...over,
});

function app(over: Partial<RoutesDeps> = {}) {
  const deps: RoutesDeps = {
    runPass: vi.fn(async (opts) => report({ dryRun: opts.dryRun, runId: opts.runId })),
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
    expect((await a.request('/reclassify/run?secret=nope', { method: 'POST' })).status).toBe(401);
    const { app: b, deps } = app({ secret: undefined });
    expect((await b.request('/reclassify/run?secret=s3cret', { method: 'POST' })).status).toBe(401);
    expect(deps.runPass).not.toHaveBeenCalled();
  });

  it('status reports the write mode and recent runs', async () => {
    const { app: a } = app({ mode: async () => 'hold' });
    const res = await a.request('/reclassify/status?secret=s3cret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'hold', runs: [] });
  });

  it('run with no dryRun param follows the mode: off is a dry pass, on is live, and names the run after the clock', async () => {
    const { app: a, deps } = app({ mode: async () => 'off' });
    const res = await a.request('/reclassify/run?secret=s3cret', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(deps.runPass).toHaveBeenCalledWith({ dryRun: true, runId: 'http-2026-10-09T17-00-00-123Z' });
    expect(await res.json()).toMatchObject({ ok: true, dryRun: true });
    const { app: b, deps: live } = app({ mode: async () => 'on' });
    await b.request('/reclassify/run?secret=s3cret', { method: 'POST' });
    expect(live.runPass).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
  });

  it('run with no dryRun param is refused with 409 under hold and unknown', async () => {
    for (const mode of ['hold', 'unknown'] as const) {
      const { app: a, deps } = app({ mode: async () => mode });
      expect((await a.request('/reclassify/run?secret=s3cret', { method: 'POST' })).status).toBe(409);
      expect(deps.runPass).not.toHaveBeenCalled();
    }
  });

  it('dryRun=true forces a dry pass in on, off and hold, but not when the mode is unknown', async () => {
    for (const mode of ['on', 'off', 'hold'] as const) {
      const { app: a, deps } = app({ mode: async () => mode });
      expect((await a.request('/reclassify/run?secret=s3cret&dryRun=true', { method: 'POST' })).status).toBe(200);
      expect(deps.runPass).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    }
    const { app: u, deps } = app({ mode: async () => 'unknown' });
    expect((await u.request('/reclassify/run?secret=s3cret&dryRun=true', { method: 'POST' })).status).toBe(503);
    expect(deps.runPass).not.toHaveBeenCalled();
  });

  it('dryRun=false is no longer accepted, in any mode; other values are 400 too', async () => {
    const { app: a, deps } = app({ mode: async () => 'on' });
    const res = await a.request('/reclassify/run?secret=s3cret&dryRun=false', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'dryRun=false is no longer accepted; use scripts/flags.mjs' });
    expect((await a.request('/reclassify/run?secret=s3cret&dryRun=yes', { method: 'POST' })).status).toBe(400);
    expect(deps.runPass).not.toHaveBeenCalled();
  });

  it('a pass that stopped early or was skipped reports ok: false', async () => {
    const { app: a } = app({ runPass: async () => report({ error: 'stopped' }) });
    expect(await (await a.request('/reclassify/run?secret=s3cret', { method: 'POST' })).json()).toMatchObject({ ok: false, error: 'stopped' });
    const { app: b } = app({ runPass: async () => ({ skipped: 'already' }) });
    expect(await (await b.request('/reclassify/run?secret=s3cret', { method: 'POST' })).json()).toEqual({ ok: false, skipped: 'already' });
  });
});
