import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { MapConfig } from './config';

// Verifies the Cloudflare Access JWT the edge adds to every request that passed Access. The
// Worker checks it again itself, so a route that bypasses the Access app (a misconfigured
// workers.dev or an extra route) still serves nothing. Returns null on any failure; the caller
// answers 403 and logs no identity.
export async function verifyAccess(
  request: Request,
  access: MapConfig['access'],
  keys: JWTVerifyGetKey,
): Promise<{ email: string } | null> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  const teamDomain = access.teamDomain.replace(/\/+$/, '');
  if (!token || !teamDomain || !access.aud) return null;
  try {
    const { payload } = await jwtVerify(token, keys, { issuer: teamDomain, audience: access.aud });
    const email = typeof payload.email === 'string' ? payload.email : '';
    if (!email.toLowerCase().endsWith('@' + access.allowedEmailDomain.toLowerCase())) return null;
    return { email };
  } catch {
    return null;
  }
}

// `wrangler dev` has no Access in front of it. The bypass needs the ACCESS_DEV_BYPASS var (only
// in the git-ignored .dev.vars) AND a localhost URL, so a stray var in a deployed env still fails.
export function devBypassAllowed(request: Request, env: { ACCESS_DEV_BYPASS?: string }): boolean {
  if (!env.ACCESS_DEV_BYPASS) return false;
  const { hostname } = new URL(request.url);
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

// One remote JWKS per team domain per isolate (sandbox and production may differ). jose caches
// and rotates the fetched keys itself.
const remoteKeys = new Map<string, JWTVerifyGetKey>();

export function remoteKeysFor(teamDomain: string): JWTVerifyGetKey {
  const base = teamDomain.replace(/\/+$/, '');
  let keys = remoteKeys.get(base);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(base + '/cdn-cgi/access/certs'));
    remoteKeys.set(base, keys);
  }
  return keys;
}
