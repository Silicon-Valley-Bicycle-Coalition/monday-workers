// Verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion) in the Worker itself, so a
// request that reaches the workers.dev/route URL without passing through Access is still
// refused. No dependency: RS256 via Web Crypto against the team's published certs.
import type { MiddlewareHandler } from 'hono';
import { configFor, type Config } from './config';
import type { Env } from './types';

export type AccessVariables = { staffEmail: string };

const CERTS_TTL_MS = 60 * 60 * 1000;
// A forced refetch (unknown kid, i.e. possible key rotation) is allowed at most once per
// minute per team domain, so a forged kid can't turn every request into an outbound fetch.
const FORCED_REFETCH_FLOOR_MS = 60 * 1000;
const certCache = new Map<string, { keys: JsonWebKey[]; fetchedAt: number }>();
const lastForced = new Map<string, number>();

export function resetCertCacheForTests(): void {
  certCache.clear();
  lastForced.clear();
}

async function fetchAccessCerts(teamDomain: string, force = false): Promise<JsonWebKey[]> {
  const cached = certCache.get(teamDomain);
  const nowMs = Date.now();
  if (cached) {
    const fresh = nowMs - cached.fetchedAt < CERTS_TTL_MS;
    if (!force && fresh) return cached.keys;
    if (force) {
      const last = lastForced.get(teamDomain);
      if (last !== undefined && nowMs - last < FORCED_REFETCH_FLOOR_MS) return cached.keys;
      lastForced.set(teamDomain, nowMs);
    }
  } else if (force) {
    lastForced.set(teamDomain, nowMs);
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: JsonWebKey[] };
  const keys = body.keys ?? [];
  certCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

function decodeSegment(segment: string): Uint8Array<ArrayBuffer> {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function decodeJson(segment: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(decodeSegment(segment)));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  return value as Record<string, unknown>;
}

// Returns the staff email for a valid token, or null for anything else (never throws).
export async function verifyAccessJwt(
  token: string | null,
  cfg: Config['access'],
  fetchCerts: (opts?: { force?: boolean }) => Promise<JsonWebKey[]> = (opts) => fetchAccessCerts(cfg.teamDomain, opts?.force),
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ email: string } | null> {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts as [string, string, string];
    const header = decodeJson(head);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

    const findKey = (keys: JsonWebKey[]) => keys.find((k) => (k as { kid?: string }).kid === header.kid);
    // An unknown kid may mean Access rotated its keys: refetch once, bypassing the cache.
    const jwk = findKey(await fetchCerts()) ?? findKey(await fetchCerts({ force: true }));
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeSegment(sig), new TextEncoder().encode(`${head}.${body}`));
    if (!ok) return null;

    const claims = decodeJson(body);
    if (claims.iss !== `https://${cfg.teamDomain}`) return null;
    const aud = claims.aud;
    if (!(Array.isArray(aud) ? aud.includes(cfg.aud) : aud === cfg.aud)) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > now) return null;
    if (typeof claims.email !== 'string' || claims.email === '') return null;
    return { email: claims.email };
  } catch {
    return null;
  }
}

export function requireAccess(): MiddlewareHandler<{ Bindings: Env; Variables: AccessVariables }> {
  return async (c, next) => {
    const identity = await verifyAccessJwt(c.req.header('Cf-Access-Jwt-Assertion') ?? null, configFor(c.env).access);
    if (!identity) return c.text('Forbidden', 403);
    c.set('staffEmail', identity.email);
    await next();
  };
}
