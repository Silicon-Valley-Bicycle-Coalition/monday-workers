import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppKey } from './apps';
import { TokenBroker } from './broker';
import type { Env } from './env';
import { D1AppTokenStore } from './tokenStore';
import { TEST_ENC_KEY } from '../test/enc-key';

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

type Responder = (form: URLSearchParams, call: number) => { status: number; body: unknown };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!cond()) throw new Error('until: condition never became true');
}

// Fake Monday token endpoint: counts calls, rotates tokens (`acc-new-N` / `ref-new-N`) unless a
// responder overrides. With `gate`, every token-endpoint call and every broker sleep waits for
// the gate, so a test holds the winner mid-refresh until the loser is polling. After the gate
// opens each poll sleeps 20 ms: a 200 ms budget, far longer than the winner's D1 write.
function harness(opts: { responder?: Responder; gate?: Promise<void>; env?: Env } = {}) {
  const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
  const tokenCalls: URLSearchParams[] = [];
  const alerts: string[] = [];
  let sleeps = 0;
  let n = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== TOKEN_URL) throw new Error(`unexpected fetch ${url}`);
    const form = new URLSearchParams(JSON.parse(String(init?.body ?? '{}')) as Record<string, string>);
    tokenCalls.push(form);
    const call = tokenCalls.length;
    if (opts.gate) await opts.gate;
    const res = opts.responder
      ? opts.responder(form, call)
      : { status: 200, body: { access_token: `acc-new-${++n}`, refresh_token: `ref-new-${n}`, expires_in: 3600 } };
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const broker = new TokenBroker({
    store,
    env: opts.env ?? testEnv,
    fetchFn,
    now: () => NOW,
    sleep: async () => {
      sleeps++;
      if (opts.gate) await opts.gate;
      await new Promise((r) => setTimeout(r, 20));
    },
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
  return { store, broker, tokenCalls, alerts, seed, env, sleeps: () => sleeps };
}

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

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
    const gate = deferred();
    const h = harness({ gate: gate.promise });
    await h.seed('sync', 1);
    const both = Promise.all([h.broker.token('sync'), h.broker.token('sync')]);
    // The winner is inside the token-endpoint call and the loser is polling.
    await until(() => h.tokenCalls.length === 1 && h.sleeps() >= 1);
    gate.resolve();
    expect(await both).toEqual(['acc-new-1', 'acc-new-1']);
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
    const gate = deferred();
    const h = harness({ gate: gate.promise, responder: () => ({ status: 400, body: { error: 'invalid_grant' } }) });
    await h.seed('sync', 1);
    const both = Promise.allSettled([h.broker.token('sync'), h.broker.token('sync')]);
    await until(() => h.tokenCalls.length === 1 && h.sleeps() >= 1);
    gate.resolve();
    for (const r of await both) {
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
    await h.store.markNeedsConsent('readonly', 1);
    await expect(h.broker.token('readonly')).rejects.toThrow(/needs consent/);
    await expect(h.broker.token('readonly', 'acc-old-readonly')).rejects.toThrow(/needs consent/);
    expect(h.tokenCalls).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
  });

  it('transient failure inside the margin returns the still-valid stored token', async () => {
    const errors = quiet();
    const h = harness({ responder: () => ({ status: 503, body: { error: 'server_error' } }) });
    await h.seed('sync', 5);
    expect(await h.broker.token('sync')).toBe('acc-old-sync');
    expect(h.tokenCalls).toHaveLength(1);
    expect(await h.store.get('sync')).toMatchObject({ status: 'ok', version: 1 });
    expect(h.alerts).toHaveLength(0);
    expect(errors).toHaveBeenCalled();
  });

  it('transient failure on an expired token throws retryable, releases the lease, and does not alert', async () => {
    let fail = true;
    const h = harness({
      responder: () =>
        fail
          ? { status: 503, body: { error: 'server_error' } }
          : { status: 200, body: { access_token: 'acc-after', refresh_token: 'ref-after', expires_in: 3600 } },
    });
    await h.seed('sync', -1);
    await expect(h.broker.token('sync')).rejects.toThrow(/retryable.*503/);
    expect((await h.store.get('sync'))?.status).toBe('ok');
    expect(h.alerts).toHaveLength(0);
    // Lease released: the next call can refresh straight away.
    fail = false;
    expect(await h.broker.token('sync')).toBe('acc-after');
  });

  it('transient failure on a forced refresh throws retryable even though the token is unexpired', async () => {
    const h = harness({ responder: () => ({ status: 503, body: {} }) });
    await h.seed('portal', 50);
    await expect(h.broker.token('portal', 'acc-old-portal')).rejects.toThrow(/retryable/);
  });

  it('a loser takes over the lease after the winner fails transiently', async () => {
    const gate = deferred();
    const h = harness({
      gate: gate.promise,
      responder: (_form, call) =>
        call === 1
          ? { status: 503, body: {} }
          : { status: 200, body: { access_token: 'acc-takeover', refresh_token: 'ref-takeover', expires_in: 3600 } },
    });
    await h.seed('sync', -1); // expired: the failed winner throws, so only the loser's refresh succeeds
    const both = Promise.allSettled([h.broker.token('sync'), h.broker.token('sync')]);
    await until(() => h.tokenCalls.length === 1 && h.sleeps() >= 1);
    gate.resolve();
    const results = await both;
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<string>).value)).toEqual([
      'acc-takeover',
    ]);
    expect(h.tokenCalls).toHaveLength(2);
    expect(await h.store.get('sync')).toMatchObject({ refreshToken: 'ref-takeover', version: 2 });
  });

  it('a missing client secret is a config error that never calls Monday', async () => {
    const h = harness({ env: { ...testEnv, SYNC_CLIENT_SECRET: '' } });
    await h.seed('sync', 1);
    const p = h.broker.token('sync');
    await expect(p).rejects.toThrow('monday-auth: SYNC_CLIENT_SECRET is not set');
    await expect(p).rejects.not.toThrow(/retryable/);
    expect(h.tokenCalls).toHaveLength(0);
    // The lease wasn't taken: a correctly configured broker refreshes at once.
    expect(await harness().broker.token('sync')).toBe('acc-new-1');
  });

  it('refreshAllIfDue refreshes apps within 8 hours of expiry, isolates failures, then rejects naming them', async () => {
    const errors = quiet();
    const h = harness({
      responder: (form) =>
        form.get('client_id') === 'portal-id'
          ? { status: 500, body: {} }
          : { status: 200, body: { access_token: 'acc-sync-refreshed', refresh_token: 'ref-sync-refreshed', expires_in: 3600 } },
    });
    await h.seed('portal', -1); // due and expired, but Monday fails
    await h.seed('sync', 7 * 60); // due: inside the 8-hour cron window, outside the 10-minute margin
    await h.seed('readonly', 9 * 60); // not due
    await expect(h.broker.refreshAllIfDue()).rejects.toThrow(/scheduled refresh failed for: portal$/);
    expect(h.tokenCalls.map((f) => f.get('client_id')).sort()).toEqual(['portal-id', 'sync-id']);
    expect((await h.store.get('sync'))?.accessToken).toBe('acc-sync-refreshed');
    expect((await h.store.get('portal'))?.accessToken).toBe('acc-old-portal');
    expect((await h.store.get('readonly'))?.version).toBe(1);
    expect(errors).toHaveBeenCalled();
  });

  it('refreshAllIfDue counts a failure the stored token papered over (fallback) as a failure', async () => {
    quiet();
    const h = harness({ responder: () => ({ status: 503, body: {} }) });
    await h.seed('sync', 7 * 60); // valid for 7 h: obtain() hands it out, but the refresh failed
    await expect(h.broker.refreshAllIfDue()).rejects.toThrow(/scheduled refresh failed for: sync$/);
    expect(await h.store.get('sync')).toMatchObject({ status: 'ok', version: 1, lastRefreshErrorAt: NOW.toISOString() });
  });

  it('cron alerts once when refreshes keep failing and under 6 hours remain, and again after a recovery', async () => {
    quiet();
    let fail = true;
    const h = harness({
      responder: () =>
        fail ? { status: 503, body: { error: 'server_error' } } : { status: 200, body: { access_token: 'acc-ok', refresh_token: 'ref-ok', expires_in: 86_400 } },
    });
    await h.seed('sync', 7 * 60); // failing, but 7 h left: record, don't alert yet
    await h.broker.refreshAllIfDue().catch(() => {});
    expect(h.alerts).toHaveLength(0);
    expect((await h.store.get('sync'))?.refreshFailingSince).toBe(NOW.toISOString());

    // Same streak, now with 5 h left (as if two hours of failing cron runs went by).
    await h.env.DB.prepare('UPDATE oauth_tokens SET access_token_expires_at = ?1 WHERE app = ?2').bind(inMinutes(5 * 60), 'sync').run();
    await h.broker.refreshAllIfDue().catch(() => {});
    await h.broker.refreshAllIfDue().catch(() => {});
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatch(/\[sandbox\] the sync app's token refresh keeps failing/);
    expect(h.alerts[0]).toMatch(/2026-10-30T15:00:00.000Z/);

    // A successful refresh clears the state; a later streak alerts again.
    fail = false;
    await h.broker.refreshAllIfDue();
    expect(await h.store.get('sync')).toMatchObject({ lastRefreshErrorAt: null, refreshFailingSince: null, refreshErrorAlertedAt: null });
    fail = true;
    await h.env.DB.prepare('UPDATE oauth_tokens SET access_token_expires_at = ?1 WHERE app = ?2').bind(inMinutes(60), 'sync').run();
    await h.broker.refreshAllIfDue().catch(() => {});
    expect(h.alerts).toHaveLength(2);
  });

  it('on-demand refresh failures record the error but leave the under-6-hours alert to the cron', async () => {
    quiet();
    const h = harness({ responder: () => ({ status: 503, body: {} }) });
    await h.seed('sync', 5);
    expect(await h.broker.token('sync')).toBe('acc-old-sync');
    expect(h.alerts).toHaveLength(0);
    expect((await h.store.get('sync'))?.lastRefreshErrorAt).toBe(NOW.toISOString());
  });

  it('invalid_client / unauthorized_client alert at once (once per streak), keep serving the stored token, and need no consent', async () => {
    quiet();
    for (const code of ['invalid_client', 'unauthorized_client']) {
      const h = harness({ responder: () => ({ status: 401, body: { error: code, error_description: 'secret sync-secret wrong' } }) });
      await h.seed('sync', 5);
      expect(await h.broker.token('sync')).toBe('acc-old-sync');
      expect(await h.broker.token('sync')).toBe('acc-old-sync');
      await h.broker.refreshAllIfDue().catch(() => {});
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0]).toMatch(new RegExp(`\\[sandbox\\] Monday rejected the sync app's client credentials \\(${code}\\)`));
      expect(h.alerts[0]).toMatch(/SYNC_CLIENT_SECRET/);
      expect(h.alerts[0]).not.toContain('sync-secret');
      expect(await h.store.get('sync')).toMatchObject({ status: 'ok', version: 1 });
      await h.env.DB.prepare('DELETE FROM oauth_tokens').run();
    }
  });

  it('refreshAllIfDue skips missing and needs_consent apps without throwing', async () => {
    const h = harness();
    await h.seed('portal', 1);
    await h.store.markNeedsConsent('portal', 1);
    await expect(h.broker.refreshAllIfDue()).resolves.toBeUndefined();
    expect(h.tokenCalls).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
  });

  it('no thrown message or alert text contains the access or refresh token or client secret', async () => {
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

    // missing app
    await capture(harness().broker.token('readonly'));

    // invalid_grant (description echoes the token, as a careless server might)
    const rejected = harness({
      responder: (form) => ({
        status: 400,
        body: { error: 'invalid_grant', error_description: `refresh token ${form.get('refresh_token')} revoked` },
      }),
    });
    await rejected.seed('sync', 1);
    await capture(rejected.broker.token('sync'));
    await capture(rejected.broker.token('sync', 'acc-old-sync'));

    // 5xx whose body echoes the token and secret: expired (throws), still valid (logs, returns), cron
    const flaky = harness({
      responder: (form) => ({
        status: 502,
        body: { error: 'bad_gateway', token: form.get('refresh_token'), secret: form.get('client_secret') },
      }),
    });
    await flaky.seed('portal', -1);
    await capture(flaky.broker.token('portal'));
    await flaky.seed('readonly', 5);
    await capture(flaky.broker.token('readonly'));
    await capture(flaky.broker.refreshAllIfDue());

    // invalid_client whose description echoes the secret: logs and alerts
    const badClient = harness({
      responder: (form) => ({ status: 401, body: { error: 'invalid_client', error_description: `bad secret ${form.get('client_secret')}` } }),
    });
    await badClient.seed('sync', 5);
    await capture(badClient.broker.token('sync'));
    await capture(badClient.broker.refreshAllIfDue());

    expect(thrown.length).toBeGreaterThanOrEqual(4);
    expect(logged.length).toBeGreaterThan(0);
    const secrets = [
      'acc-old-sync',
      'ref-old-sync',
      'acc-old-portal',
      'ref-old-portal',
      'acc-old-readonly',
      'ref-old-readonly',
      'sync-secret',
      'portal-secret',
      'readonly-secret',
    ];
    expect(badClient.alerts).toHaveLength(1);
    for (const text of [...thrown, ...rejected.alerts, ...flaky.alerts, ...badClient.alerts, ...logged]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  });
});
