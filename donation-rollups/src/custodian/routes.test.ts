import { describe, it, expect, vi } from 'vitest';
import { createCustodianApp, type CustodianAppDeps } from './routes';

function app(deps: Partial<CustodianAppDeps> = {}) {
  return createCustodianApp({
    runDuty: vi.fn().mockResolvedValue({ ok: true, summary: 'did the thing' }),
    lastRuns: vi.fn().mockResolvedValue([]),
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
    expect(runDuty).toHaveBeenCalledWith('sweep', {});
    expect(await res.json()).toMatchObject({ duty: 'sweep', ok: true });
  });

  it('passes all=true and since through to the duty; absent options are undefined', async () => {
    const runDuty = vi.fn().mockResolvedValue({ ok: true, summary: 'x' });
    const a = app({ secret: 'shh', runDuty });
    await a.request('/custodian/run/membership?secret=shh&all=true&since=2026-10-17T00:00:00Z', { method: 'POST' });
    expect(runDuty).toHaveBeenCalledWith('membership', { all: true, since: '2026-10-17T00:00:00Z' });
    await a.request('/custodian/run/membership?secret=shh', { method: 'POST' });
    expect(runDuty).toHaveBeenLastCalledWith('membership', {});
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
