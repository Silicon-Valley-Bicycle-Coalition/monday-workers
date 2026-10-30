import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppKey } from './apps';
import { TokenBroker } from './broker';
import type { Env } from './env';
import { D1AppTokenStore } from './tokenStore';

const TOKEN_URL = 'https://auth.monday.com/oauth_ms/oauth/token';
const NOW = new Date('2026-10-30T10:00:00.000Z');
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

const testEnv: Env = {
  DB: env.DB,
  ENVIRONMENT: 'sandbox',
  EXPECTED_USER_ID: '42',
  MONDAY_SUBDOMAIN: 'bikesiliconvalley',
  START_KEY: 'k',
  PORTAL_CLIENT_ID: 'portal-id',
  PORTAL_CLIENT_SECRET: 'portal-secret',
  SYNC_CLIENT_ID: 'sync-id',
  SYNC_CLIENT_SECRET: 'sync-secret',
  READONLY_CLIENT_ID: 'readonly-id',
  READONLY_CLIENT_SECRET: 'readonly-secret',
};

type Responder = (form: URLSearchParams) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

// Fake Monday token endpoint: counts calls, rotates tokens (`acc-N` / `ref-N`) unless overridden.
function harness(responder?: Responder) {
  const store = new D1AppTokenStore(env.DB);
  const tokenCalls: URLSearchParams[] = [];
  const alerts: string[] = [];
  let n = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== TOKEN_URL) throw new Error(`unexpected fetch ${url}`);
    const form = new URLSearchParams(String(init?.body ?? ''));
    tokenCalls.push(form);
    // Yield so a concurrent caller gets to run while this "network call" is in flight.
    await new Promise((r) => setTimeout(r, 5));
    const res = responder
      ? await responder(form)
      : { status: 200, body: { access_token: `acc-new-${++n}`, refresh_token: `ref-new-${n}`, expires_in: 3600 } };
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const broker = new TokenBroker({
    store,
    env: testEnv,
    fetchFn,
    now: () => NOW,
    sleep: () => new Promise((r) => setTimeout(r, 5)),
    alert: async (text) => {
      alerts.push(text);
    },
  });
  const seed = (app: AppKey, expiresInMinutes: number, suffix = 'old') =>
    store.save({
      app,
      accessToken: `acc-${suffix}-${app}`,
      refreshToken: `ref-${suffix}-${app}`,
      accessTokenExpiresAt: inMinutes(expiresInMinutes),
      authorizedUserId: '42',
    });
  return { store, broker, tokenCalls, alerts, seed };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TokenBroker', () => {
  it('returns the stored token while more than 10 minutes remain', async () => {
    const h = harness();
    await h.seed('sync', 11);
    expect(await h.broker.token('sync')).toBe('acc-old-sync');
    expect(h.tokenCalls).toHaveLength(0);
  });

  it('refreshes inside the margin and stores the rotated refresh token', async () => {
    const h = harness();
    await h.seed('sync', 9);
    expect(await h.broker.token('sync')).toBe('acc-new-1');
    expect(h.tokenCalls).toHaveLength(1);
    expect(h.tokenCalls[0]!.get('refresh_token')).toBe('ref-old-sync');
    expect(h.tokenCalls[0]!.get('client_id')).toBe('sync-id');
    expect(h.tokenCalls[0]!.get('client_secret')).toBe('sync-secret');
    expect(await h.store.get('sync')).toMatchObject({
      accessToken: 'acc-new-1',
      refreshToken: 'ref-new-1',
      accessTokenExpiresAt: inMinutes(60),
      version: 2,
      status: 'ok',
    });
  });

  it('two concurrent token() calls on an expiring token make one refresh call', async () => {
    const h = harness();
    await h.seed('sync', 1);
    const [a, b] = await Promise.all([h.broker.token('sync'), h.broker.token('sync')]);
    expect(a).toBe('acc-new-1');
    expect(b).toBe('acc-new-1');
    expect(h.tokenCalls).toHaveLength(1);
  });

  it('rejected token equal to the stored one forces a refresh even if not near expiry', async () => {
    const h = harness();
    await h.seed('portal', 50);
    expect(await h.broker.token('portal', 'acc-old-portal')).toBe('acc-new-1');
    expect(h.tokenCalls).toHaveLength(1);
  });

  it('rejected token that is already stale returns the stored token without refreshing', async () => {
    const h = harness();
    await h.seed('portal', 50);
    expect(await h.broker.token('portal', 'some-older-token')).toBe('acc-old-portal');
    expect(h.tokenCalls).toHaveLength(0);
  });

  it('invalid_grant marks needs_consent, alerts once, and throws', async () => {
    const h = harness(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    await h.seed('sync', 1);
    const results = await Promise.allSettled([h.broker.token('sync'), h.broker.token('sync')]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect(String((r as PromiseRejectedResult).reason.message)).toMatch(/needs consent/);
    }
    // A later call fails on the row check alone.
    await expect(h.broker.token('sync')).rejects.toThrow(/needs consent/);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatch(/sync/);
    expect(h.tokenCalls).toHaveLength(1);
    expect((await h.store.get('sync'))?.status).toBe('needs_consent');
  });

  it('token() on a needs_consent or missing app throws without calling Monday', async () => {
    const h = harness();
    await expect(h.broker.token('readonly')).rejects.toThrow(/not authorized/);
    await h.seed('readonly', 1);
    await h.store.markNeedsConsent('readonly');
    await expect(h.broker.token('readonly')).rejects.toThrow(/needs consent/);
    await expect(h.broker.token('readonly', 'acc-old-readonly')).rejects.toThrow(/needs consent/);
    expect(h.tokenCalls).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
  });

  it('a non-invalid_grant failure releases the lease, keeps status ok and does not alert', async () => {
    let fail = true;
    const h = harness(() =>
      fail
        ? { status: 503, body: { error: 'server_error' } }
        : { status: 200, body: { access_token: 'acc-after', refresh_token: 'ref-after', expires_in: 3600 } }
    );
    await h.seed('sync', 1);
    await expect(h.broker.token('sync')).rejects.toThrow(/503/);
    expect((await h.store.get('sync'))?.status).toBe('ok');
    expect(h.alerts).toHaveLength(0);
    // Lease released: the next call can refresh straight away.
    fail = false;
    expect(await h.broker.token('sync')).toBe('acc-after');
  });

  it('refreshAllIfDue refreshes only apps inside the margin and isolates failures', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness((form) =>
      form.get('client_id') === 'portal-id'
        ? { status: 500, body: {} }
        : { status: 200, body: { access_token: 'acc-sync-refreshed', refresh_token: 'ref-sync-refreshed', expires_in: 3600 } }
    );
    await h.seed('portal', 2); // due, but Monday fails
    await h.seed('sync', 5); // due
    await h.seed('readonly', 30); // not due
    await expect(h.broker.refreshAllIfDue()).resolves.toBeUndefined();
    expect(h.tokenCalls.map((f) => f.get('client_id')).sort()).toEqual(['portal-id', 'sync-id']);
    expect((await h.store.get('sync'))?.accessToken).toBe('acc-sync-refreshed');
    expect((await h.store.get('portal'))?.accessToken).toBe('acc-old-portal');
    expect((await h.store.get('readonly'))?.version).toBe(1);
    expect(errors).toHaveBeenCalled();
  });

  it('refreshAllIfDue skips missing and needs_consent apps without throwing', async () => {
    const h = harness();
    await h.seed('portal', 1);
    await h.store.markNeedsConsent('portal');
    await expect(h.broker.refreshAllIfDue()).resolves.toBeUndefined();
    expect(h.tokenCalls).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
  });

  it('no thrown message or alert text contains the access or refresh token', async () => {
    const logged: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '));
      });
    }
    const thrown: string[] = [];
    const capture = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (err) {
        thrown.push(`${(err as Error).message} ${(err as Error).stack ?? ''}`);
      }
    };

    // invalid_grant (description echoes the token, as a careless server might)
    const rejected = harness((form) => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: `refresh token ${form.get('refresh_token')} revoked` },
    }));
    await rejected.seed('sync', 1);
    await capture(rejected.broker.token('sync'));
    await capture(rejected.broker.token('sync', 'acc-old-sync'));

    // 5xx whose body echoes the token
    const flaky = harness((form) => ({ status: 502, body: { error: 'bad_gateway', token: form.get('refresh_token') } }));
    await flaky.seed('portal', 1);
    await capture(flaky.broker.token('portal'));
    await flaky.broker.refreshAllIfDue();

    // missing app
    await capture(flaky.broker.token('readonly'));

    expect(thrown.length).toBeGreaterThanOrEqual(4);
    const secrets = ['acc-old-sync', 'ref-old-sync', 'acc-old-portal', 'ref-old-portal'];
    for (const text of [...thrown, ...rejected.alerts, ...flaky.alerts, ...logged]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  });
});
