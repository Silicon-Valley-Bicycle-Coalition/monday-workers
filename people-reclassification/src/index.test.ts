import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from './index';
import type { Env } from './types';

// The daily cron reads the write mode before it touches Monday or the ledger.
function cronEnv(mode: string | null) {
  return { ...env, FLAGS: { get: vi.fn(async () => mode) } } as unknown as Env;
}

describe('scheduled', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['hold', 'unknown'])('skips the whole run under %s: no Monday call', async (mode) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const e = mode === 'unknown'
      ? ({ ...env, FLAGS: { get: vi.fn(async () => { throw new Error('kv down'); }) } } as unknown as Env)
      : cronEnv(mode);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.scheduled({} as ScheduledController, e, {} as ExecutionContext);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('"writeSwitch":"skipped"');
  });
});

describe('Monday token from the monday-auth broker', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('builds its Monday client from the MONDAY_AUTH binding when bound', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // "Board not visible" — the cron's first Monday read is all this checks.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { boards: [] } }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const auth = { token: vi.fn().mockResolvedValue('brokered') };
    const e = { ...cronEnv('on'), MONDAY_API_TOKEN: undefined, MONDAY_AUTH: auth } as unknown as Env;

    await worker.scheduled({} as ScheduledController, e, {} as ExecutionContext);

    expect(auth.token).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('brokered');
  });
});
