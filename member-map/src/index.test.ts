import { describe, expect, it, vi } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import worker, { createApp, createWorker, type Env, type RefreshMessage } from './index';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const keys = async () => publicKey;
const valid = await new SignJWT({ email: 'pat@bikesiliconvalley.org' })
  .setProtectedHeader({ alg: 'RS256' }).setIssuer('https://svbc.cloudflareaccess.com').setAudience('aud123').setExpirationTime('5m').sign(privateKey);

// A small in-memory R2: head/get/put/delete, with an upload time and etag per key, and put's
// onlyIf etagMatches / etagDoesNotMatch ('*' = any object), answering null when the condition
// fails, as the R2 binding does (checked against local workerd via getPlatformProxy).
class FakeBucket {
  objects = new Map<string, { body: string; uploaded: Date; etag: string }>();
  private n = 0;
  // Race tests: a read of the marker (head) waits until `barrier` reads have started (or 50 ms,
  // when fewer come), so two requests that check before writing both look before either writes:
  // the interleaving a real double click can hit.
  barrier = 0;
  private waiting: (() => void)[] = [];
  private async rendezvous(key: string) {
    if (key !== 'refresh-pending.json' || this.barrier === 0) return;
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      setTimeout(resolve, 50);
      if (this.waiting.length >= this.barrier) { this.barrier = 0; for (const w of this.waiting.splice(0)) w(); }
    });
  }
  set(key: string, uploaded: Date, body = '{"ok":true}') { this.objects.set(key, { body, uploaded, etag: `e${++this.n}` }); }
  async head(key: string) { await this.rendezvous(key); const o = this.objects.get(key); return o ? { uploaded: o.uploaded, etag: o.etag } : null; }
  async get(key: string) { const o = this.objects.get(key); return o ? { uploaded: o.uploaded, body: new Response(o.body).body } : null; }
  async put(key: string, body: string, opts: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } } = {}) {
    const cur = this.objects.get(key);
    const { etagMatches, etagDoesNotMatch } = opts.onlyIf ?? {};
    if (etagMatches !== undefined && cur?.etag !== etagMatches) return null;
    if (etagDoesNotMatch !== undefined && cur && (etagDoesNotMatch === '*' || cur.etag === etagDoesNotMatch)) return null;
    this.set(key, new Date(), body);
    return {};
  }
  async delete(key: string) { this.objects.delete(key); }
}

// Configs ship with teamDomain "" until Access is set up, so tests inject the access settings.
function fakeEnv(opts: { snapshotUploadedAt?: Date | null; limiter?: boolean } = {}) {
  const uploaded = opts.snapshotUploadedAt === undefined ? new Date(Date.now() - 3600_000) : opts.snapshotUploadedAt;
  const bucket = new FakeBucket();
  if (uploaded) bucket.set('snapshot.json', uploaded);
  const send = vi.fn(async (_msg: unknown) => {});
  const env: Env = {
    DB: {} as D1Database,
    SNAPSHOTS: bucket as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response('asset', { headers: { 'Content-Type': 'text/html' } }) } as unknown as Fetcher,
    MONDAY_AUTH: { token: async () => 't' },
    REQUEST_RATE_LIMITER: { limit: async () => ({ success: opts.limiter ?? true }) } as unknown as RateLimit,
    REFRESH_QUEUE: { send } as unknown as Queue<RefreshMessage>,
  };
  return Object.assign(env, { bucket, send });
}

function setup(opts: Parameters<typeof fakeEnv>[0] = {}) {
  const refresh = vi.fn(async () => {});
  const app = createApp({ keys, refresh, accessOverride: { teamDomain: 'https://svbc.cloudflareaccess.com', aud: 'aud123', allowedEmailDomain: 'bikesiliconvalley.org' } });
  const env = fakeEnv(opts);
  const ctx = { waitUntil: vi.fn(), passThroughOnException: () => {} } as unknown as ExecutionContext;
  const call = (path: string, token?: string, method = 'GET') =>
    app.fetch(new Request(`https://map.bikesiliconvalley.org${path}`, { method, headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} }), env, ctx);
  return { call, refresh, ctx, env };
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
  it('enqueues a refresh, writes the in-progress marker and returns 202 without running it inline', async () => {
    const s = setup();
    const res = await s.call('/api/refresh', valid, 'POST');
    expect(res.status).toBe(202);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(s.env.send).toHaveBeenCalledTimes(1);
    expect(s.env.send.mock.calls[0]![0]).toMatchObject({ requestedAt: expect.any(String) });
    expect(s.env.bucket.objects.has('refresh-pending.json')).toBe(true);
    expect(s.refresh).not.toHaveBeenCalled();
    expect(s.ctx.waitUntil).not.toHaveBeenCalled();
  });
  it('is 429 within 10 minutes of the last snapshot', async () => {
    const s = setup({ snapshotUploadedAt: new Date(Date.now() - 5 * 60_000) });
    const res = await s.call('/api/refresh', valid, 'POST');
    expect(res.status).toBe(429);
    expect(s.env.send).not.toHaveBeenCalled();
  });
  it('a second click while a refresh is pending is 429 and enqueues nothing more', async () => {
    const s = setup({ snapshotUploadedAt: null });
    expect((await s.call('/api/refresh', valid, 'POST')).status).toBe(202);
    const again = await s.call('/api/refresh', valid, 'POST');
    expect(again.status).toBe(429);
    expect(await again.json()).toEqual({ error: 'a refresh is already running' });
    expect(s.env.send).toHaveBeenCalledTimes(1);
  });
  it('a marker older than 20 minutes no longer blocks a refresh, and is replaced', async () => {
    const s = setup({ snapshotUploadedAt: null });
    s.env.bucket.set('refresh-pending.json', new Date(Date.now() - 21 * 60_000));
    const staleEtag = s.env.bucket.objects.get('refresh-pending.json')!.etag;
    expect((await s.call('/api/refresh', valid, 'POST')).status).toBe(202);
    expect(s.env.send).toHaveBeenCalledTimes(1);
    expect(s.env.bucket.objects.get('refresh-pending.json')!.etag).not.toBe(staleEtag);
  });
  it('two simultaneous clicks: exactly one enqueues, the other is 429', async () => {
    const s = setup({ snapshotUploadedAt: null });
    s.env.bucket.barrier = 2;
    const statuses = (await Promise.all([s.call('/api/refresh', valid, 'POST'), s.call('/api/refresh', valid, 'POST')])).map((r) => r.status);
    expect(statuses.sort()).toEqual([202, 429]);
    expect(s.env.send).toHaveBeenCalledTimes(1);
  });
  it('two simultaneous clicks over a stale marker: exactly one enqueues', async () => {
    const s = setup({ snapshotUploadedAt: null });
    s.env.bucket.set('refresh-pending.json', new Date(Date.now() - 21 * 60_000));
    s.env.bucket.barrier = 2;
    const statuses = (await Promise.all([s.call('/api/refresh', valid, 'POST'), s.call('/api/refresh', valid, 'POST')])).map((r) => r.status);
    expect(statuses.sort()).toEqual([202, 429]);
    expect(s.env.send).toHaveBeenCalledTimes(1);
  });
  it('clears the marker and answers 503 when the enqueue fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup();
    s.env.send.mockRejectedValueOnce(new Error('queue down'));
    const res = await s.call('/api/refresh', valid, 'POST');
    expect(res.status).toBe(503);
    expect(s.env.bucket.objects.has('refresh-pending.json')).toBe(false);
    err.mockRestore();
  });
  it('403s without a token', async () => {
    const s = setup();
    expect((await s.call('/api/refresh', undefined, 'POST')).status).toBe(403);
    expect(s.env.send).not.toHaveBeenCalled();
  });
});

describe('security headers', () => {
  it('asset responses carry a Content-Security-Policy', async () => {
    const res = await setup().call('/index.html', valid);
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' https://cdnjs.cloudflare.com");
    expect(csp).toContain('img-src \'self\' data: https://tile.openstreetmap.org');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(res.headers.get('Content-Type')).toBe('text/html');
  });
});

const EMAIL_ERROR = () => new TypeError('secret detail pat@example.org');
const batch = (n = 1) => ({
  queue: 'svbc-member-map-refresh',
  messages: Array.from({ length: n }, () => ({ body: { requestedAt: 'x' }, ack: () => {}, retry: () => {} })),
}) as unknown as MessageBatch<RefreshMessage>;
const noCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe('queue consumer', () => {
  it('runs the refresh and clears the marker on success', async () => {
    const refresh = vi.fn(async () => {});
    const env = fakeEnv();
    env.bucket.set('refresh-pending.json', new Date());
    await createWorker({ refresh }).queue(batch(), env, noCtx);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(env.bucket.objects.has('refresh-pending.json')).toBe(false);
  });

  it('runs the refresh once per batch, however many clicks it holds', async () => {
    const refresh = vi.fn(async () => {});
    await createWorker({ refresh }).queue(batch(3), fakeEnv(), noCtx);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('on failure logs the name only, clears the marker and throws a sanitized error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = fakeEnv();
    env.bucket.set('refresh-pending.json', new Date());
    const thrown = await createWorker({ refresh: async () => { throw EMAIL_ERROR(); } }).queue(batch(), env, noCtx).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('member-map: refresh failed: TypeError');
    expect((thrown as Error).message).not.toMatch(/secret|@|example/);
    expect(env.bucket.objects.has('refresh-pending.json')).toBe(false);
    expect(err).toHaveBeenCalledWith('member-map: refresh failed: TypeError');
    err.mockRestore();
  });
});

describe('cron', () => {
  it('awaits the refresh', async () => {
    const refresh = vi.fn(async () => {});
    await createWorker({ refresh }).scheduled({} as ScheduledController, fakeEnv(), noCtx);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('logs a failure by name and rethrows a sanitized error, so the Cron Event shows failed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = await createWorker({ refresh: async () => { throw EMAIL_ERROR(); } })
      .scheduled({} as ScheduledController, fakeEnv(), noCtx).catch((e: unknown) => e);
    expect((thrown as Error).message).toBe('member-map: refresh failed: TypeError');
    expect((thrown as Error).message).not.toMatch(/secret|pat@example\.org/);
    expect(err).toHaveBeenCalledWith('member-map: refresh failed: TypeError');
    err.mockRestore();
  });

  it('the default export runs the real refresh, which fails fast without a token source', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { ...fakeEnv(), MONDAY_AUTH: undefined } as unknown as Env;
    await expect(worker.scheduled({} as ScheduledController, env, noCtx)).rejects.toThrow('member-map: refresh failed: Error');
    err.mockRestore();
  });
});

describe('main module exports', () => {
  it('are all functions besides the default handler (workerd refuses to start otherwise)', async () => {
    const mod = (await import('./index')) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (name !== 'default') expect(typeof value, name).toBe('function');
    }
  });
});
