import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('./config', () => ({
  configFor: () => ({ access: { teamDomain: 'svbc.cloudflareaccess.com', aud: 'aud-123' } }),
}));

import { verifyAccessJwt, requireAccess, resetCertCacheForTests, type AccessVariables } from './access';
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

async function sign(payload: Record<string, unknown>, kid = 'k1', header: Record<string, unknown> = {}): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }));
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

beforeEach(() => resetCertCacheForTests());
afterEach(() => vi.unstubAllGlobals());

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

describe('verifyAccessJwt fail-closed paths', () => {
  it('rejects alg none', async () => {
    expect(await verifyAccessJwt(await sign(claims(), 'k1', { alg: 'none' }), cfg, certs, NOW)).toBeNull();
  });
  it('rejects alg HS256', async () => {
    expect(await verifyAccessJwt(await sign(claims(), 'k1', { alg: 'HS256' }), cfg, certs, NOW)).toBeNull();
  });
  it('rejects a missing kid', async () => {
    expect(await verifyAccessJwt(await sign(claims(), 'k1', { kid: undefined }), cfg, certs, NOW)).toBeNull();
  });
  it('rejects nbf in the future', async () => {
    expect(await verifyAccessJwt(await sign(claims({ nbf: NOW + 300 })), cfg, certs, NOW)).toBeNull();
  });
  it('returns null when the cert fetch throws', async () => {
    const boom = async (): Promise<JsonWebKey[]> => {
      throw new Error('network');
    };
    expect(await verifyAccessJwt(await sign(claims()), cfg, boom, NOW)).toBeNull();
  });
  it('returns null on a non-200 cert fetch and does not cache the failure', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return calls === 1 ? new Response('nope', { status: 500 }) : new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'k1' } as JsonWebKey] }));
    });
    const token = await sign(claims({ exp: Math.floor(Date.now() / 1000) + 600 }));
    expect(await verifyAccessJwt(token, cfg)).toBeNull();
    expect(await verifyAccessJwt(token, cfg)).toEqual({ email: 'staff@example.org' });
    expect(calls).toBe(2);
  });
});

describe('cert cache and key rotation', () => {
  it('refetches once on an unknown kid, then rate-limits forced refetches to one per minute', async () => {
    let calls = 0;
    const rotated = { ...publicJwk, kid: 'k1' } as JsonWebKey;
    const old = { ...publicJwk, kid: 'old' } as JsonWebKey;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response(JSON.stringify({ keys: calls === 1 ? [old] : [rotated] }));
    });
    const exp = Math.floor(Date.now() / 1000) + 600;
    expect(await verifyAccessJwt(await sign(claims({ exp })), cfg)).toEqual({ email: 'staff@example.org' });
    expect(calls).toBe(2);
    expect(await verifyAccessJwt(await sign(claims({ exp }), 'forged'), cfg)).toBeNull();
    expect(calls).toBe(2);
    expect(await verifyAccessJwt(await sign(claims({ exp }), 'forged2'), cfg)).toBeNull();
    expect(calls).toBe(2);
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
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'k1' } as JsonWebKey] }));
    });
    try {
      const app = new Hono<{ Bindings: Env; Variables: AccessVariables }>();
      app.use('*', requireAccess());
      app.get('/who', (c) => c.text(c.get('staffEmail')));
      const res = await app.request('/who', { headers: { 'Cf-Access-Jwt-Assertion': token } }, {} as Env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('staff@example.org');
      expect(urls).toEqual(['https://svbc.cloudflareaccess.com/cdn-cgi/access/certs']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
