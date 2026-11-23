import { describe, expect, it } from 'vitest';
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
