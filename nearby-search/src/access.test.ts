import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Hono } from 'hono';

vi.mock('./config', () => ({
  configFor: () => ({ access: { teamDomain: 'svbc.cloudflareaccess.com', aud: 'aud-123' } }),
}));

import { verifyAccessJwt, requireAccess, type AccessVariables } from './access';
import type { Env } from './types';

const cfg = { teamDomain: 'svbc.cloudflareaccess.com', aud: 'aud-123' };
const NOW = 1_800_000_000;

let publicJwk: JsonWebKey;
let privateKey: CryptoKey;

const b64url = (data: ArrayBuffer | string): string => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function sign(payload: Record<string, unknown>, kid = 'k1'): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  aud: [cfg.aud],
  iss: `https://${cfg.teamDomain}`,
  email: 'staff@example.org',
  exp: NOW + 600,
  ...over,
});

const certs = async () => [{ ...publicJwk, kid: 'k1' } as JsonWebKey];

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
});

describe('verifyAccessJwt', () => {
  it('returns the email for a valid token', async () => {
    expect(await verifyAccessJwt(await sign(claims()), cfg, certs, NOW)).toEqual({ email: 'staff@example.org' });
  });
  it('accepts aud as a plain string', async () => {
    expect(await verifyAccessJwt(await sign(claims({ aud: cfg.aud })), cfg, certs, NOW)).toEqual({ email: 'staff@example.org' });
  });
  it('rejects the wrong aud', async () => {
    expect(await verifyAccessJwt(await sign(claims({ aud: ['other'] })), cfg, certs, NOW)).toBeNull();
  });
  it('rejects the wrong issuer', async () => {
    expect(await verifyAccessJwt(await sign(claims({ iss: 'https://evil.cloudflareaccess.com' })), cfg, certs, NOW)).toBeNull();
  });
  it('rejects an expired token', async () => {
    expect(await verifyAccessJwt(await sign(claims({ exp: NOW - 1 })), cfg, certs, NOW)).toBeNull();
  });
  it('rejects a kid not in the certs', async () => {
    expect(await verifyAccessJwt(await sign(claims(), 'unknown'), cfg, certs, NOW)).toBeNull();
  });
  it('rejects a tampered payload', async () => {
    const [h, , s] = (await sign(claims())).split('.');
    const forged = b64url(JSON.stringify(claims({ email: 'attacker@example.org' })));
    expect(await verifyAccessJwt(`${h}.${forged}.${s}`, cfg, certs, NOW)).toBeNull();
  });
  it('rejects a missing email', async () => {
    expect(await verifyAccessJwt(await sign(claims({ email: undefined })), cfg, certs, NOW)).toBeNull();
  });
  it('returns null for a null or malformed token', async () => {
    expect(await verifyAccessJwt(null, cfg, certs, NOW)).toBeNull();
    expect(await verifyAccessJwt('not.a.jwt', cfg, certs, NOW)).toBeNull();
    expect(await verifyAccessJwt('garbage', cfg, certs, NOW)).toBeNull();
  });
});

describe('requireAccess', () => {
  const app = new Hono<{ Bindings: Env; Variables: AccessVariables }>();
  app.use('*', requireAccess());
  app.get('/who', (c) => c.text(c.get('staffEmail')));

  it('returns 403 without a token', async () => {
    const res = await app.request('/who', {}, {} as Env);
    expect(res.status).toBe(403);
  });
  it('returns 403 for a bad token', async () => {
    const res = await app.request('/who', { headers: { 'Cf-Access-Jwt-Assertion': 'x.y.z' } }, {} as Env);
    expect(res.status).toBe(403);
  });
});

describe('requireAccess with a valid token', () => {
  it('sets staffEmail and continues', async () => {
    const realNow = Math.floor(Date.now() / 1000);
    const token = await sign(claims({ exp: realNow + 600 }));
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'k1' } as JsonWebKey] })));
    try {
      const app = new Hono<{ Bindings: Env; Variables: AccessVariables }>();
      app.use('*', requireAccess());
      app.get('/who', (c) => c.text(c.get('staffEmail')));
      const res = await app.request('/who', { headers: { 'Cf-Access-Jwt-Assertion': token } }, {} as Env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('staff@example.org');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
