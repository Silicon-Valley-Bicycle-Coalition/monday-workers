import { Hono } from 'hono';
import type { JWTVerifyGetKey } from 'jose';
import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { devBypassAllowed, remoteKeysFor, verifyAccess } from './access';
import { validateConfig, type MapConfig } from './config';
import { createConfigSelector } from './environment';
import type { MondayTokenSource } from './monday/graphql';
import { checkRequestRateLimit } from './rateLimit';

export interface Env {
  DB: D1Database;
  SNAPSHOTS: R2Bucket;
  ASSETS: Fetcher;
  // monday-auth's ReadOnlyToken entrypoint (wrangler.jsonc services).
  MONDAY_AUTH: MondayTokenSource;
  // The platform binding takes { key }; checkRequestRateLimit gets it through a small adapter.
  REQUEST_RATE_LIMITER: RateLimit;
  ENVIRONMENT?: string;
  // Set only in the git-ignored .dev.vars; honored only for localhost URLs.
  ACCESS_DEV_BYPASS?: string;
}

export interface AppDeps {
  keys?: JWTVerifyGetKey;
  refresh?: (env: Env) => Promise<void>;
  // Tests: replaces config.access (the shipped configs have an empty teamDomain until Access exists).
  accessOverride?: MapConfig['access'];
}

const SNAPSHOT_KEY = 'snapshot.json';
const REFRESH_COOLDOWN_MS = 10 * 60_000;
const NO_STORE = 'private, no-store';

const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

// Replaced by Task 8's snapshot build.
async function notImplemented(_env: Env): Promise<void> {
  throw new Error('not implemented');
}

export function createApp(deps: AppDeps = {}): Hono<{ Bindings: Env }> {
  const refresh = deps.refresh ?? notImplemented;
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

  app.post('/api/refresh', async (c) => {
    const head = await c.env.SNAPSHOTS.head(SNAPSHOT_KEY);
    if (head && Date.now() - head.uploaded.getTime() < REFRESH_COOLDOWN_MS) {
      return c.json({ error: 'snapshot is under 10 minutes old' }, 429, { 'Cache-Control': NO_STORE });
    }
    c.executionCtx.waitUntil(refresh(c.env));
    return c.json({ status: 'refresh started' }, 202, { 'Cache-Control': NO_STORE });
  });

  app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}

const app = createApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  // Task 8 builds the weekly snapshot here.
  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {},
};
