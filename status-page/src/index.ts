import type { JWTVerifyGetKey } from 'jose';
import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { devBypassAllowed, remoteKeysFor, verifyAccess } from './access';
import { validateConfig, type StatusConfig } from './config';
import { createConfigSelector } from './environment';
import { checkRequestRateLimit } from './rateLimit';

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
      if (request.method === 'GET' && url.pathname === '/') return new Response('ok');
      return new Response('Not found', { status: 404 });
    },
  };
}

export default createHandler() satisfies ExportedHandler<Env>;
