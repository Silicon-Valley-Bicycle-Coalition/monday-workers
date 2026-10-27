import { describe, it, expect, vi } from 'vitest';
import { createCustodianApp, type CustodianAppDeps } from './routes';

function app(deps: Partial<CustodianAppDeps> = {}) {
  return createCustodianApp({
    runDuty: vi.fn().mockResolvedValue({ ok: true, summary: 'did the thing' }),
    lastRuns: vi.fn().mockResolvedValue([]),
    writeMode: async () => 'on',
    ...deps,
  });
}

describe('custodian route auth', () => {
  it('fails closed when no secret is configured — archive/sweep must never be open', async () => {
    const runDuty = vi.fn().mockResolvedValue({ ok: true, summary: 'x' });
    const a = app({ secret: undefined, runDuty });
    const res = await a.request('/custodian/run/archive', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(runDuty).not.toHaveBeenCalled();
  });

  it('fails closed on an empty-string secret too', async () => {
    const a = app({ secret: '' });
    // Even a request that "matches" the empty configured secret is refused.
    const res = await a.request('/custodian/run/sweep?secret=', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong secret', async () => {
    const a = app({ secret: 'shh' });
    const res = await a.request('/custodian/run/sweep?secret=wrong', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('authorizes a matching secret and runs the duty', async () => {
    const runDuty = vi.fn().mockResolvedValue({ ok: true, summary: 'swept' });
    const a = app({ secret: 'shh', runDuty });
    const res = await a.request('/custodian/run/sweep?secret=shh', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(runDuty).toHaveBeenCalledWith('sweep', {}, 'run');
    expect(await res.json()).toMatchObject({ duty: 'sweep', ok: true });
  });

  it('passes all=true and since through to the duty; absent options are undefined', async () => {
    const runDuty = vi.fn().mockResolvedValue({ ok: true, summary: 'x' });
    const a = app({ secret: 'shh', runDuty });
    await a.request('/custodian/run/membership?secret=shh&all=true&since=2026-10-17T00:00:00Z', { method: 'POST' });
    expect(runDuty).toHaveBeenCalledWith('membership', { all: true, since: '2026-10-17T00:00:00Z' }, 'run');
    await a.request('/custodian/run/membership?secret=shh', { method: 'POST' });
    expect(runDuty).toHaveBeenLastCalledWith('membership', {}, 'run');
  });

  it('rejects a malformed since', async () => {
    const a = app({ secret: 'shh' });
    expect((await a.request('/custodian/run/membership?secret=shh&all=true&since=yesterday', { method: 'POST' })).status).toBe(400);
  });

  it('guards /custodian/status the same way', async () => {
    expect((await app({ secret: undefined }).request('/custodian/status')).status).toBe(401);
    expect((await app({ secret: 'shh' }).request('/custodian/status?secret=shh')).status).toBe(200);
  });
});

// The write switch (spec 2026-10-26): a duty run on demand obeys the same mode as the cron.
describe('custodian route write switch', () => {
  it.each([['hold'], ['unknown']] as const)('refuses to run a duty under %s with 409 and the mode', async (mode) => {
    const runDuty = vi.fn().mockResolvedValue({ ok: true, summary: 'x' });
    const a = app({ secret: 'shh', runDuty, writeMode: async () => mode });
    const res = await a.request('/custodian/run/sweep?secret=shh', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, mode });
    expect(runDuty).not.toHaveBeenCalled();
  });

  it('dry-runs the duty under off and says so in the report', async () => {
    const runDuty = vi.fn().mockResolvedValue({ ok: true, summary: 'swept' });
    const a = app({ secret: 'shh', runDuty, writeMode: async () => 'off' });
    const res = await a.request('/custodian/run/sweep?secret=shh', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(runDuty).toHaveBeenCalledWith('sweep', {}, 'dry-run');
    expect(await res.json()).toMatchObject({ duty: 'sweep', mode: 'off', ok: true });
  });

  it('still serves /custodian/status under hold — it only reads', async () => {
    const a = app({ secret: 'shh', writeMode: async () => 'hold' });
    expect((await a.request('/custodian/status?secret=shh')).status).toBe(200);
  });

  it('checks auth and the duty name before reading the mode', async () => {
    const writeMode = vi.fn(async () => 'hold' as const);
    const a = app({ secret: 'shh', writeMode });
    expect((await a.request('/custodian/run/sweep?secret=wrong', { method: 'POST' })).status).toBe(401);
    expect((await a.request('/custodian/run/nope?secret=shh', { method: 'POST' })).status).toBe(400);
    expect(writeMode).not.toHaveBeenCalled();
  });
});
