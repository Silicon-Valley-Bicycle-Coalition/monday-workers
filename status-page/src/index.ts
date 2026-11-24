import type { JWTVerifyGetKey } from 'jose';
import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { devBypassAllowed, remoteKeysFor, verifyAccess } from './access';
import { validateConfig, type StatusConfig } from './config';
import { createConfigSelector } from './environment';
import { cloudflareSection } from './cloudflare';
import { fontResponse } from './fonts';
import { checkRequestRateLimit } from './rateLimit';
import { renderPage, STYLES_CSS } from './render';
import { syncSection } from './syncs';
import { vendorRow } from './vendors';

export interface Env {
  // sync-watchdog's STATE namespace; only `snapshot:latest` is ever read.
  WATCHDOG_STATE: KVNamespace;
  // The platform binding takes { key }; checkRequestRateLimit gets it through a small adapter.
  REQUEST_RATE_LIMITER: RateLimit;
  ENVIRONMENT?: string;
  // Set only in the git-ignored .dev.vars; honored only for localhost URLs.
  ACCESS_DEV_BYPASS?: string;
}

export interface AppDeps {
  keys?: JWTVerifyGetKey;
  // Tests: replaces config.access (the shipped configs have an empty teamDomain until Access exists).
  accessOverride?: StatusConfig['access'];
  now?: () => Date;
}

// Only this origin's stylesheet and fonts; no script at all.
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

export function createHandler(deps: AppDeps = {}) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const limited = await checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) });
      if (limited) return limited;

      const config = configFor(env);
      const access = deps.accessOverride ?? config.access;
      if (!devBypassAllowed(request, env)) {
        const who = await verifyAccess(request, access, deps.keys ?? remoteKeysFor(access.teamDomain || 'https://invalid.invalid'));
        if (!who) return new Response('Forbidden', { status: 403 });
      }

      const url = new URL(request.url);
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      if (url.pathname === '/') return page(env, config, (deps.now ?? (() => new Date()))());
      if (url.pathname === '/styles.css') {
        return new Response(STYLES_CSS, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'private, max-age=300' } });
      }
      if (url.pathname.startsWith('/fonts/')) return fontResponse(url.pathname) ?? new Response('Not found', { status: 404 });
      return new Response('Not found', { status: 404 });
    },
  };
}

// Every source is fetched in parallel and none can throw (feeds and the snapshot read turn their
// own failures into "Couldn't check"), so one slow or broken vendor never blanks the page.
async function page(env: Env, config: StatusConfig, now: Date): Promise<Response> {
  const opts = { timeoutMs: config.feedTimeoutMs, cacheSeconds: config.feedCacheSeconds };
  const [syncs, cloudflare, vendors] = await Promise.all([
    syncSection(env.WATCHDOG_STATE, config.syncs, config.snapshotMaxAgeHours, now),
    cloudflareSection(config.cloudflare, opts),
    Promise.all(config.vendors.map((v) => vendorRow(v, opts))),
  ]);
  return new Response(renderPage({ syncs, cloudflare, vendors, checkedAt: now }, config.timezone), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export default createHandler() satisfies ExportedHandler<Env>;
