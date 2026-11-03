import { Hono } from 'hono';
import type { JWTVerifyGetKey } from 'jose';
import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { devBypassAllowed, remoteKeysFor, verifyAccess } from './access';
import { validateConfig, type MapConfig } from './config';
import { createConfigSelector } from './environment';
import { CensusGeocoder, D1GeocodeStore } from './geocode';
import { HttpMondayClient } from './monday/client';
import { tokenProviderFor, type MondayTokenSource } from './monday/graphql';
import { checkRequestRateLimit } from './rateLimit';
import { runRefresh, SNAPSHOT_KEY } from './snapshot';

export interface Env {
  DB: D1Database;
  SNAPSHOTS: R2Bucket;
  ASSETS: Fetcher;
  // monday-auth's ReadOnlyToken entrypoint (wrangler.jsonc services).
  MONDAY_AUTH: MondayTokenSource;
  // The platform binding takes { key }; checkRequestRateLimit gets it through a small adapter.
  REQUEST_RATE_LIMITER: RateLimit;
  // svbc-member-map-refresh(-sandbox): POST /api/refresh enqueues; this Worker's queue() runs it.
  REFRESH_QUEUE: Queue<RefreshMessage>;
  ENVIRONMENT?: string;
  // Set only in the git-ignored .dev.vars; honored only for localhost URLs.
  ACCESS_DEV_BYPASS?: string;
}

export interface RefreshMessage { requestedAt: string }

export interface AppDeps {
  keys?: JWTVerifyGetKey;
  // Tests: replaces the refresh the cron and the queue consumer run.
  refresh?: (env: Env) => Promise<void>;
  // Tests: replaces config.access (the shipped configs have an empty teamDomain until Access exists).
  accessOverride?: MapConfig['access'];
}

// Written when a refresh is enqueued, deleted when the queue consumer finishes (either way). A
// marker older than PENDING_TTL_MS is ignored, in case a consumer died without clearing it.
const PENDING_KEY = 'refresh-pending.json';
const PENDING_TTL_MS = 20 * 60_000;
const REFRESH_COOLDOWN_MS = 10 * 60_000;
const NO_STORE = 'private, no-store';

// Leaflet's script and stylesheet come from cdnjs; tiles from OpenStreetMap; the page's own
// fetches go only to this origin. (Not exported: workerd rejects a non-handler, non-function
// export from the main module.)
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self' https://cdnjs.cloudflare.com",
  "img-src 'self' data: https://tile.openstreetmap.org",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

export async function refreshSnapshot(env: Env): Promise<void> {
  const config = configFor(env);
  await runRefresh({
    monday: new HttpMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
    store: new D1GeocodeStore(env.DB),
    geocoder: new CensusGeocoder(config.geocoder),
    assets: env.ASSETS,
    bucket: env.SNAPSHOTS,
    config,
    now: new Date(),
  });
}

const errorName = (err: unknown) => (err instanceof Error ? err.name : 'unknown');

// Error name only, never a message (which could echo a Monday response or an address).
export function logRefreshFailure(err: unknown): void {
  console.error(`member-map: refresh failed: ${errorName(err)}`);
}

// Cron and queue runs log the failure, then throw this so Workers marks the invocation failed
// (Cron Events, queue metrics) without carrying the original message anywhere.
async function refreshOrThrow(env: Env, refresh: (env: Env) => Promise<void>): Promise<void> {
  try {
    await refresh(env);
  } catch (err) {
    logRefreshFailure(err);
    throw new Error(`member-map: refresh failed: ${errorName(err)}`);
  }
}

export function createApp(deps: AppDeps = {}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Rate limit first, then the Access gate in front of every route, assets included.
  app.use('*', async (c, next) => {
    const limited = await checkRequestRateLimit(c.req.raw, { limit: (key) => c.env.REQUEST_RATE_LIMITER.limit({ key }) });
    if (limited) return limited;
    if (!devBypassAllowed(c.req.raw, c.env)) {
      const access = deps.accessOverride ?? configFor(c.env).access;
      // Access not set up yet: refuse before building a JWKS URL from an empty teamDomain.
      if (!access.teamDomain || !access.aud) return new Response('Forbidden', { status: 403 });
      const keys = deps.keys ?? remoteKeysFor(access.teamDomain);
      if (!(await verifyAccess(c.req.raw, access, keys))) return new Response('Forbidden', { status: 403 });
    }
    await next();
  });

  app.get('/api/snapshot', async (c) => {
    const object = await c.env.SNAPSHOTS.get(SNAPSHOT_KEY);
    if (!object) return c.json({ error: 'no snapshot yet' }, 503, { 'Cache-Control': NO_STORE });
    return new Response(object.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': NO_STORE } });
  });

  // A refresh reads every board and geocodes, far past the ~30 s an HTTP waitUntil gets, so it
  // runs in this Worker's queue consumer (15 minutes). The marker keeps repeat clicks from
  // stacking refreshes.
  app.post('/api/refresh', async (c) => {
    const now = Date.now();
    const snapshot = await c.env.SNAPSHOTS.head(SNAPSHOT_KEY);
    if (snapshot && now - snapshot.uploaded.getTime() < REFRESH_COOLDOWN_MS) {
      return c.json({ error: 'snapshot is under 10 minutes old' }, 429, { 'Cache-Control': NO_STORE });
    }
    const pending = await c.env.SNAPSHOTS.head(PENDING_KEY);
    if (pending && now - pending.uploaded.getTime() < PENDING_TTL_MS) {
      return c.json({ error: 'a refresh is already running' }, 429, { 'Cache-Control': NO_STORE });
    }
    const message: RefreshMessage = { requestedAt: new Date(now).toISOString() };
    await c.env.SNAPSHOTS.put(PENDING_KEY, JSON.stringify(message), { httpMetadata: { contentType: 'application/json' } });
    try {
      await c.env.REFRESH_QUEUE.send(message);
    } catch (err) {
      await c.env.SNAPSHOTS.delete(PENDING_KEY);
      console.error(`member-map: could not enqueue a refresh: ${errorName(err)}`);
      return c.json({ error: 'could not start a refresh' }, 503, { 'Cache-Control': NO_STORE });
    }
    return c.json({ status: 'refresh started' }, 202, { 'Cache-Control': NO_STORE });
  });

  app.all('*', async (c) => {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    const res = new Response(asset.body, asset);
    res.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    return res;
  });

  return app;
}

export function createWorker(deps: AppDeps = {}) {
  const refresh = deps.refresh ?? refreshSnapshot;
  const app = createApp(deps);
  return {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),

    // Weekly cron. Awaited (not waitUntil) so a failure marks the Cron Event failed.
    scheduled: (_controller: ScheduledController, env: Env, _ctx: ExecutionContext) => refreshOrThrow(env, refresh),

    // svbc-member-map-refresh: one refresh per batch (max_batch_size 1; extra messages would only
    // ask for the same thing). max_retries 0: a failed refresh waits for the next click or cron
    // rather than being retried against Monday and Census. The marker is cleared either way.
    queue: async (_batch: MessageBatch<RefreshMessage>, env: Env, _ctx: ExecutionContext) => {
      try {
        await refreshOrThrow(env, refresh);
      } finally {
        // If this fails, the marker simply expires after PENDING_TTL_MS.
        await env.SNAPSHOTS.delete(PENDING_KEY).catch(() => console.warn('member-map: could not clear the refresh marker'));
      }
    },
  };
}

export default createWorker();
