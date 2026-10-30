import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { PortalToken, ReadOnlyToken, SyncToken } from './index';
import { TokenBroker } from './broker';
import type { Env } from './env';
import { D1AppTokenStore } from './tokenStore';

const testEnv = env as unknown as Env;

afterEach(() => vi.restoreAllMocks());

const ctx = {} as ExecutionContext;

describe('entrypoints', () => {
  it('each entrypoint asks the broker for its own app only', async () => {
    const spy = vi.spyOn(TokenBroker.prototype, 'token').mockResolvedValue('tok');
    const stubEnv = testEnv;
    expect(await new PortalToken(ctx, stubEnv).token()).toBe('tok');
    expect(await new SyncToken(ctx, stubEnv).token('old')).toBe('tok');
    expect(await new ReadOnlyToken(ctx, stubEnv).token()).toBe('tok');
    expect(spy.mock.calls).toEqual([['portal', undefined], ['sync', 'old'], ['readonly', undefined]]);
  });
});

describe('scheduled', () => {
  it('scheduled calls refreshAllIfDue', async () => {
    const spy = vi.spyOn(TokenBroker.prototype, 'refreshAllIfDue').mockResolvedValue();
    await worker.scheduled({} as ScheduledController, testEnv, ctx);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('purges abandoned consent rows, and a refresh failure does not skip the purge', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.putPending('stale', 'portal', 'v', 'https://a.test/cb', new Date(Date.now() - 60 * 60_000));
    vi.spyOn(TokenBroker.prototype, 'refreshAllIfDue').mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await worker.scheduled({} as ScheduledController, testEnv, ctx);
    const row = await env.DB.prepare('SELECT 1 FROM oauth_pending WHERE state = ?1').bind('stale').first();
    expect(row).toBeNull();
  });

  it('a purge failure does not skip the refresh', async () => {
    const refresh = vi.spyOn(TokenBroker.prototype, 'refreshAllIfDue').mockResolvedValue();
    vi.spyOn(D1AppTokenStore.prototype, 'purgeExpiredPending').mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await worker.scheduled({} as ScheduledController, testEnv, ctx);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('fetch', () => {
  it('serves /health through the app', async () => {
    const res = await worker.fetch(new Request('https://broker.test/health'), testEnv, ctx);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
