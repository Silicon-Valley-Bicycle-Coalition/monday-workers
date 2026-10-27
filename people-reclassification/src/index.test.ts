import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker from './index';

// The daily cron reads the write mode before it touches Monday or the ledger.
function cronEnv(mode: string | null) {
  return { ...env, FLAGS: { get: vi.fn(async () => mode) } } as unknown as typeof env;
}

describe('scheduled', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['hold', 'unknown'])('skips the whole run under %s: no Monday call', async (mode) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const e = mode === 'unknown'
      ? ({ ...env, FLAGS: { get: vi.fn(async () => { throw new Error('kv down'); }) } } as unknown as typeof env)
      : cronEnv(mode);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.scheduled({} as ScheduledController, e, {} as ExecutionContext);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('"writeSwitch":"skipped"');
  });
});
