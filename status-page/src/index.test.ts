import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { createHandler, type Env } from './index';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const keys = async () => publicKey;
const accessOverride = { teamDomain: 'https://svbc.cloudflareaccess.com', aud: 'aud123', allowedEmailDomain: 'bikesiliconvalley.org' };
const valid = await new SignJWT({ email: 'pat@bikesiliconvalley.org' })
  .setProtectedHeader({ alg: 'RS256' })
  .setIssuer(accessOverride.teamDomain)
  .setAudience('aud123')
  .setExpirationTime('5m')
  .sign(privateKey);

function env(over: Partial<Env> = {}): Env {
  return {
    WATCHDOG_STATE: { get: async () => null } as unknown as KVNamespace,
    REQUEST_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    ...over,
  };
}
const handler = createHandler({ keys, accessOverride });
const get = (url: string, token?: string) =>
  new Request(url, token ? { headers: { 'Cf-Access-Jwt-Assertion': token } } : {});

describe('access gate', () => {
  it('refuses a request without an Access token', async () =>
    expect((await handler.fetch(get('https://status.bikesiliconvalley.org/'), env())).status).toBe(403));

  it('serves a request with a valid Access token', async () =>
    expect((await handler.fetch(get('https://status.bikesiliconvalley.org/', valid), env())).status).toBe(200));

  it('honors ACCESS_DEV_BYPASS only on localhost', async () => {
    const bypass = env({ ACCESS_DEV_BYPASS: '1' });
    expect((await handler.fetch(get('http://localhost:8787/'), bypass)).status).toBe(200);
    expect((await handler.fetch(get('https://status.bikesiliconvalley.org/'), bypass)).status).toBe(403);
  });

  it('rate-limits before checking Access', async () => {
    const limited = env({ REQUEST_RATE_LIMITER: { limit: async () => ({ success: false }) } as unknown as RateLimit });
    expect((await handler.fetch(get('https://status.bikesiliconvalley.org/'), limited)).status).toBe(429);
  });

  it('404s an unknown path, after the Access check', async () => {
    expect((await handler.fetch(get('https://status.bikesiliconvalley.org/nope', valid), env())).status).toBe(404);
    expect((await handler.fetch(get('https://status.bikesiliconvalley.org/nope'), env())).status).toBe(403);
  });
});

describe('routes', () => {
  const live = (over: Partial<Env> = {}) => env(over);
  const stubFeeds = (respond: () => Promise<Response>) => vi.stubGlobal('fetch', respond);
  afterEach(() => vi.unstubAllGlobals());
  vi.spyOn(console, 'error').mockImplementation(() => {});

  it('GET / renders the page, private and with a strict CSP', async () => {
    stubFeeds(async () => Response.json({ status: { indicator: 'none' }, components: [], incidents: [], scheduled_maintenances: [] }));
    const res = await handler.fetch(get('https://status.bikesiliconvalley.org/', valid), live());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(await res.text()).toContain('Services we use');
  });

  it('GET / still renders when every feed rejects', async () => {
    stubFeeds(async () => { throw new TypeError('network down'); });
    const res = await handler.fetch(get('https://status.bikesiliconvalley.org/', valid), live());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Couldn't check");
  });

  it('GET /styles.css and a font', async () => {
    const css = await handler.fetch(get('https://status.bikesiliconvalley.org/styles.css', valid), live());
    expect(css.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    const fontPath = /url\((\/fonts\/[^)]+\.woff2)\)/.exec(await css.text())![1]!;
    const font = await handler.fetch(get(`https://status.bikesiliconvalley.org${fontPath}`, valid), live());
    expect(font.headers.get('Content-Type')).toBe('font/woff2');
  });

  it('styles and fonts need Access too', async () => {
    expect((await handler.fetch(get('https://status.bikesiliconvalley.org/styles.css'), live())).status).toBe(403);
    expect((await handler.fetch(get('https://status.bikesiliconvalley.org/fonts/nunito-sans-latin-wght-normal-v5.woff2'), live())).status).toBe(403);
  });
});
