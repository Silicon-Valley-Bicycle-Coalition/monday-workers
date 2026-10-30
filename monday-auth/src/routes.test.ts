import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './env';
import { createApp } from './routes';
import { D1AppTokenStore } from './tokenStore';

afterEach(() => vi.restoreAllMocks());

const NOW = new Date('2026-10-30T10:00:00.000Z');
const SECRET_ACCESS = 'ACCESS-TOKEN-SECRET-VALUE';
const SECRET_REFRESH = 'REFRESH-TOKEN-SECRET-VALUE';

const testEnv: Env = {
  DB: env.DB,
  ENVIRONMENT: 'sandbox',
  EXPECTED_USER_ID: '42',
  MONDAY_SUBDOMAIN: 'bikesiliconvalley',
  START_KEY: 'the-start-key',
  PORTAL_CLIENT_ID: 'portal-id',
  PORTAL_CLIENT_SECRET: 'portal-secret',
  SYNC_CLIENT_ID: 'sync-id',
  SYNC_CLIENT_SECRET: 'sync-secret',
  READONLY_CLIENT_ID: 'readonly-id',
  READONLY_CLIENT_SECRET: 'readonly-secret',
};

interface Call {
  url: string;
  body: string;
}

// Fake Monday: token endpoint, `me` query, revoke endpoint.
function fakeMonday(meId: string, meName = 'Sam Integrator') {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? '') });
    if (url.endsWith('/oauth/token')) {
      return Response.json({ access_token: SECRET_ACCESS, refresh_token: SECRET_REFRESH, expires_in: 3600 });
    }
    if (url === 'https://api.monday.com/v2') return Response.json({ data: { me: { id: meId, name: meName } } });
    if (url.endsWith('/oauth/revoke')) return new Response('', { status: 200 });
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function appWith(fetchFn: typeof fetch, over: Partial<Env> = {}) {
  const store = new D1AppTokenStore(env.DB);
  return { app: createApp({ store, env: { ...testEnv, ...over }, fetchFn, now: () => NOW }), store };
}

const noFetch = (async () => {
  throw new Error('fetch must not be called');
}) as typeof fetch;

async function startAndGetState(app: ReturnType<typeof createApp>, name = 'sync'): Promise<string> {
  const res = await app.request(`https://broker.test/oauth/start/${name}?key=the-start-key`);
  return new URL(res.headers.get('location')!).searchParams.get('state')!;
}

describe('GET /oauth/start/:app', () => {
  it('start without the key is 403 and stores nothing', async () => {
    const { app } = appWith(noFetch);
    for (const url of ['https://broker.test/oauth/start/sync', 'https://broker.test/oauth/start/sync?key=wrong']) {
      expect((await app.request(url)).status).toBe(403);
    }
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_pending').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('is 403 when START_KEY is unset or empty, even for an empty key', async () => {
    const { app } = appWith(noFetch, { START_KEY: '' });
    expect((await app.request('https://broker.test/oauth/start/sync?key=')).status).toBe(403);
    expect((await app.request('https://broker.test/oauth/start/sync')).status).toBe(403);
    const { app: app2 } = appWith(noFetch, { START_KEY: undefined as unknown as string });
    expect((await app2.request('https://broker.test/oauth/start/sync?key=undefined')).status).toBe(403);
  });

  it('unknown app is 404, but only after the key check', async () => {
    const { app } = appWith(noFetch);
    expect((await app.request('https://broker.test/oauth/start/nope?key=the-start-key')).status).toBe(404);
    expect((await app.request('https://broker.test/oauth/start/nope?key=bad')).status).toBe(403);
  });

  it('start redirects to auth.monday.com with the stored state and S256 challenge', async () => {
    const { app, store } = appWith(noFetch);
    const res = await app.request('https://broker.test/oauth/start/sync?key=the-start-key');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://auth.monday.com/oauth2/authorize');
    const q = location.searchParams;
    expect(q.get('client_id')).toBe('sync-id');
    expect(q.get('redirect_uri')).toBe('https://broker.test/oauth/callback');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('subdomain')).toBe('bikesiliconvalley');
    expect(q.get('scope')).toContain('boards:write');
    const pending = await store.takePending(q.get('state')!, NOW);
    expect(pending?.app).toBe('sync');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending!.codeVerifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(q.get('code_challenge')).toBe(challenge);
  });

  it('is 500 naming the variable, without storing anything, when the app has no client id', async () => {
    const { app } = appWith(noFetch, { SYNC_CLIENT_ID: '' });
    const res = await app.request('https://broker.test/oauth/start/sync?key=the-start-key');
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('SYNC_CLIENT_ID');
  });
});

describe('GET /oauth/callback', () => {
  it('callback with an unknown or expired state is 400', async () => {
    const { app } = appWith(noFetch);
    expect((await app.request('https://broker.test/oauth/callback?code=c&state=nope')).status).toBe(400);
    expect((await app.request('https://broker.test/oauth/callback')).status).toBe(400);
  });

  it('callback for the expected user stores the token and the page shows app, user and scopes but not the token', async () => {
    const monday = fakeMonday('42');
    const { app, store } = appWith(monday.fetchFn);
    const state = await startAndGetState(app);
    const res = await app.request(`https://broker.test/oauth/callback?code=the-code&state=${state}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('sync');
    expect(html).toContain('Sam Integrator');
    expect(html).toContain('42');
    expect(html).toContain('boards:write');
    expect(html).not.toContain(SECRET_ACCESS);
    expect(html).not.toContain(SECRET_REFRESH);
    expect(await store.get('sync')).toMatchObject({
      accessToken: SECRET_ACCESS,
      refreshToken: SECRET_REFRESH,
      authorizedUserId: '42',
      status: 'ok',
    });
    const exchange = monday.calls.find((c) => c.url.endsWith('/oauth/token'))!;
    expect(new URLSearchParams(JSON.parse(exchange.body) as Record<string, string>).get('redirect_uri')).toBe('https://broker.test/oauth/callback');
    expect(new URLSearchParams(JSON.parse(exchange.body) as Record<string, string>).get('code_verifier')).toBeTruthy();
  });

  it('callback for another user revokes the token, stores nothing, and the page names both user ids', async () => {
    const monday = fakeMonday('99');
    const { app, store } = appWith(monday.fetchFn);
    const state = await startAndGetState(app);
    const res = await app.request(`https://broker.test/oauth/callback?code=c&state=${state}`);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('99');
    expect(html).toContain('42');
    expect(html).not.toContain(SECRET_ACCESS);
    expect(await store.get('sync')).toBeNull();
    const revoke = monday.calls.find((c) => c.url.endsWith('/oauth/revoke'));
    expect(revoke).toBeDefined();
    expect(new URLSearchParams(JSON.parse(revoke!.body) as Record<string, string>).get('token')).toBe(SECRET_ACCESS);
    const revoked = monday.calls.filter((c) => c.url.endsWith('/oauth/revoke')).map((c) => new URLSearchParams(JSON.parse(c.body) as Record<string, string>).get('token'));
    expect(revoked.sort()).toEqual([SECRET_ACCESS, SECRET_REFRESH].sort());
    const hints = monday.calls
      .filter((c) => c.url.endsWith('/oauth/revoke'))
      .map((c) => [(JSON.parse(c.body) as { token: string }).token, (JSON.parse(c.body) as { token_type_hint?: string }).token_type_hint]);
    expect(hints.sort()).toEqual(
      [
        [SECRET_ACCESS, 'access_token'],
        [SECRET_REFRESH, 'refresh_token'],
      ].sort()
    );
  });

  it('sends the start-time redirect_uri in the exchange even when the callback arrives on another host', async () => {
    const monday = fakeMonday('42');
    const { app } = appWith(monday.fetchFn);
    const state = await startAndGetState(app); // started on broker.test
    const res = await app.request(`https://other-host.example/oauth/callback?code=c&state=${state}`);
    expect(res.status).toBe(200);
    const exchange = monday.calls.find((c) => c.url.endsWith('/oauth/token'))!;
    expect(new URLSearchParams(JSON.parse(exchange.body) as Record<string, string>).get('redirect_uri')).toBe('https://broker.test/oauth/callback');
  });

  it('revokes both tokens, with no token in the page or logs, when the me lookup fails', async () => {
    const monday = fakeMonday('42');
    const meFails = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === 'https://api.monday.com/v2' ? new Response('', { status: 500 }) : monday.fetchFn(input, init)) as typeof fetch;
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a.join(' ')));
    const { app, store } = appWith(meFails);
    const state = await startAndGetState(app);
    const res = await app.request(`https://broker.test/oauth/callback?code=c&state=${state}`);
    spy.mockRestore();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(SECRET_ACCESS);
    expect(text).not.toContain(SECRET_REFRESH);
    expect(logs.join('\n')).not.toContain('TOKEN-SECRET');
    expect(await store.get('sync')).toBeNull();
    const revoked = monday.calls.filter((c) => c.url.endsWith('/oauth/revoke')).map((c) => new URLSearchParams(JSON.parse(c.body) as Record<string, string>).get('token'));
    expect(revoked.sort()).toEqual([SECRET_ACCESS, SECRET_REFRESH].sort());
  });

  it('a failing revoke of one token does not change the 403 and still tries the other', async () => {
    const monday = fakeMonday('99');
    const attempts: (string | null)[] = [];
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/oauth/revoke')) {
        const token = new URLSearchParams(JSON.parse(String(init?.body)) as Record<string, string>).get('token');
        attempts.push(token);
        return new Response('', { status: token === SECRET_ACCESS ? 500 : 200 });
      }
      return monday.fetchFn(input, init);
    }) as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = appWith(flaky);
    const state = await startAndGetState(app);
    const res = await app.request(`https://broker.test/oauth/callback?code=c&state=${state}`);
    expect(res.status).toBe(403);
    expect(attempts.sort()).toEqual([SECRET_ACCESS, SECRET_REFRESH].sort());
  });

  it('when the store cannot save, revokes both tokens and returns a 500 page that leaks no token', async () => {
    const monday = fakeMonday('42');
    const store = new D1AppTokenStore(env.DB);
    vi.spyOn(store, 'save').mockRejectedValue(new Error(`db down ${SECRET_ACCESS}`));
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a.join(' ')));
    const app = createApp({ store, env: testEnv, fetchFn: monday.fetchFn, now: () => NOW });
    const state = await startAndGetState(app);
    const res = await app.request(`https://broker.test/oauth/callback?code=c&state=${state}`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toMatch(/not stored/i);
    expect(text).toMatch(/consent/i);
    expect(text).not.toContain('TOKEN-SECRET');
    expect(logs.join('\n')).not.toContain('TOKEN-SECRET');
    const revoked = monday.calls.filter((c) => c.url.endsWith('/oauth/revoke')).map((c) => new URLSearchParams(JSON.parse(c.body) as Record<string, string>).get('token'));
    expect(revoked.sort()).toEqual([SECRET_ACCESS, SECRET_REFRESH].sort());
  });

  it('an empty EXPECTED_USER_ID rejects every user', async () => {
    const monday = fakeMonday('42');
    const { app, store } = appWith(monday.fetchFn, { EXPECTED_USER_ID: '' });
    const state = await startAndGetState(app);
    const res = await app.request(`https://broker.test/oauth/callback?code=c&state=${state}`);
    expect(res.status).toBe(403);
    expect(await store.get('sync')).toBeNull();
    expect(monday.calls.some((c) => c.url.endsWith('/oauth/revoke'))).toBe(true);
  });

  it('still returns 403 and stores nothing when the revoke call fails', async () => {
    const monday = fakeMonday('99');
    const failingRevoke = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/oauth/revoke') ? new Response('', { status: 500 }) : monday.fetchFn(input, init)) as typeof fetch;
    const { app, store } = appWith(failingRevoke);
    const state = await startAndGetState(app);
    const res = await app.request(`https://broker.test/oauth/callback?code=c&state=${state}`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET_ACCESS);
    expect(await store.get('sync')).toBeNull();
  });

  it('escapes HTML in the Monday user name', async () => {
    const monday = fakeMonday('42', '<script>alert(1)</script>');
    const { app } = appWith(monday.fetchFn);
    const state = await startAndGetState(app);
    const html = await (await app.request(`https://broker.test/oauth/callback?code=c&state=${state}`)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('missing client secret is 500 naming the variable, without calling Monday', async () => {
    const monday = fakeMonday('42');
    const { app } = appWith(monday.fetchFn);
    const state = await startAndGetState(app);
    const { app: broken } = appWith(monday.fetchFn, { SYNC_CLIENT_SECRET: '' });
    const res = await broken.request(`https://broker.test/oauth/callback?code=c&state=${state}`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('SYNC_CLIENT_SECRET');
    expect(monday.calls).toHaveLength(0);
  });
});

describe('GET /health', () => {
  it('/health never includes a token and reports each app', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.save({
      app: 'sync',
      accessToken: SECRET_ACCESS,
      refreshToken: SECRET_REFRESH,
      accessTokenExpiresAt: '2026-10-30T11:00:00.000Z',
      authorizedUserId: '42',
    });
    await store.save({
      app: 'portal',
      accessToken: 'p-acc',
      refreshToken: 'p-ref',
      accessTokenExpiresAt: '2026-10-30T11:00:00.000Z',
      authorizedUserId: '42',
    });
    await store.markNeedsConsent('portal', 1);
    const app = createApp({ store, env: testEnv, fetchFn: noFetch, now: () => NOW });
    const res = await app.request('https://broker.test/health');
    const text = await res.text();
    expect(text).not.toContain(SECRET_ACCESS);
    expect(text).not.toContain(SECRET_REFRESH);
    expect(text).not.toContain('p-acc');
    expect(JSON.parse(text)).toEqual([
      { app: 'portal', status: 'needs_consent' },
      { app: 'sync', status: 'ok', expiresAt: '2026-10-30T11:00:00.000Z' },
      { app: 'readonly', status: 'missing' },
    ]);
  });
});
