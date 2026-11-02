import { describe, expect, it, vi } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { createApp, type Env } from './index';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const keys = async () => publicKey;
const valid = await new SignJWT({ email: 'pat@bikesiliconvalley.org' })
  .setProtectedHeader({ alg: 'RS256' }).setIssuer('https://svbc.cloudflareaccess.com').setAudience('aud123').setExpirationTime('5m').sign(privateKey);

// Configs ship with teamDomain "" until Access is set up, so tests inject the access settings.
function fakeEnv(opts: { snapshotUploadedAt?: Date | null; limiter?: boolean } = {}): Env {
  const uploaded = opts.snapshotUploadedAt === undefined ? new Date(Date.now() - 3600_000) : opts.snapshotUploadedAt;
  const object = uploaded && { uploaded, body: '{"ok":true}', httpEtag: '"x"' };
  return {
    DB: {} as D1Database,
    SNAPSHOTS: {
      get: async () => (object ? { ...object, body: new Response('{"ok":true}').body } : null),
      head: async () => (object ? { uploaded } : null),
    } as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    MONDAY_AUTH: { token: async () => 't' },
    REQUEST_RATE_LIMITER: { limit: async () => ({ success: opts.limiter ?? true }) } as unknown as RateLimit,
  };
}

function setup(opts: Parameters<typeof fakeEnv>[0] = {}) {
  const refresh = vi.fn(async () => {});
  const app = createApp({ keys, refresh, accessOverride: { teamDomain: 'https://svbc.cloudflareaccess.com', aud: 'aud123', allowedEmailDomain: 'bikesiliconvalley.org' } });
  const env = fakeEnv(opts);
  const ctx = { waitUntil: vi.fn(), passThroughOnException: () => {} } as unknown as ExecutionContext;
  const call = (path: string, token?: string, method = 'GET') =>
    app.fetch(new Request(`https://map.bikesiliconvalley.org${path}`, { method, headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} }), env, ctx);
  return { call, refresh, ctx };
}

describe('access gate', () => {
  it('403s an asset path without a token', async () => expect((await setup().call('/index.html')).status).toBe(403));
  it('403s /data/blockgroups.geojson without a token', async () => expect((await setup().call('/data/blockgroups.geojson')).status).toBe(403));
  it('403s /api/snapshot without a token', async () => expect((await setup().call('/api/snapshot')).status).toBe(403));
  it('serves an asset with a valid token', async () => {
    const res = await setup().call('/index.html', valid);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset');
  });
  it('rate-limits before the Access check', async () => expect((await setup({ limiter: false }).call('/index.html')).status).toBe(429));
});

describe('production key path', () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const headers = { 'Cf-Access-Jwt-Assertion': valid };
  it('403s (not 500) with an empty teamDomain and no injected keys', async () => {
    const app = createApp({ accessOverride: { teamDomain: '', aud: 'aud123', allowedEmailDomain: 'bikesiliconvalley.org' } });
    const res = await app.fetch(new Request('https://map.bikesiliconvalley.org/index.html', { headers }), fakeEnv(), ctx);
    expect(res.status).toBe(403);
  });
  it('403s with an empty aud and no injected keys', async () => {
    const app = createApp({ accessOverride: { teamDomain: 'https://svbc.cloudflareaccess.com', aud: '', allowedEmailDomain: 'bikesiliconvalley.org' } });
    const res = await app.fetch(new Request('https://map.bikesiliconvalley.org/index.html', { headers }), fakeEnv(), ctx);
    expect(res.status).toBe(403);
  });
  it('403s with the shipped config, whose teamDomain is empty', async () => {
    const res = await createApp().fetch(new Request('https://map.bikesiliconvalley.org/index.html', { headers }), fakeEnv(), ctx);
    expect(res.status).toBe(403);
  });
});

describe('/api/snapshot', () => {
  it('returns the R2 object with private no-store', async () => {
    const res = await setup().call('/api/snapshot', valid);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });
  it('is 503 before the first build', async () => {
    const res = await setup({ snapshotUploadedAt: null }).call('/api/snapshot', valid);
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('POST /api/refresh', () => {
  it('starts a refresh and returns 202', async () => {
    const s = setup();
    const res = await s.call('/api/refresh', valid, 'POST');
    expect(res.status).toBe(202);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(s.refresh).toHaveBeenCalledTimes(1);
  });
  it('is 429 within 10 minutes of the last snapshot', async () => {
    const s = setup({ snapshotUploadedAt: new Date(Date.now() - 5 * 60_000) });
    const res = await s.call('/api/refresh', valid, 'POST');
    expect(res.status).toBe(429);
    expect(s.refresh).not.toHaveBeenCalled();
  });
  it('403s without a token', async () => {
    const s = setup();
    expect((await s.call('/api/refresh', undefined, 'POST')).status).toBe(403);
    expect(s.refresh).not.toHaveBeenCalled();
  });
});
