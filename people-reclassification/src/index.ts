import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector, environmentOf } from './environment';
import { validateConfig } from './config';
import { readLogLevel, readWriteMode, runDisposition } from './flags';
import { D1Ledger } from './db/ledger';
import { HttpMondayClient } from './monday/client';
import { tokenProviderFor } from './monday/graphql';
import { moveOneToPeople, runPass, type PassDeps } from './pass';
import { runDaily } from './daily';
import { promoteFromWebhook } from './promote';
import { createApp } from './routes';
import { jwtRequired } from './mondayJwt';
import { checkRequestRateLimit, isVerifiedMondayWebhook } from './rateLimit';
import { errorText } from './logSafe';
import type { Env } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

const WORKER = 'people-reclassification';

function passDeps(env: Env): PassDeps {
  const config = configFor(env);
  return { monday: new HttpMondayClient(config.monday.apiUrl, tokenProviderFor(env)), ledger: new D1Ledger(env.DB), config };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // configFor validates synchronously and must keep throwing synchronously on a misconfigured
    // ENVIRONMENT, before any routing or rate-limit check.
    configFor(env);
    // Monday's own promote deliveries (passing the URL secret) skip the per-IP limit (issue GL#110).
    return isVerifiedMondayWebhook(request, env.PROMOTE_WEBHOOK_SECRET).then((verified) => verified
      ? null
      : checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) }),
    ).then((limited) => {
      if (limited) return limited;
      const deps = passDeps(env);
      const app = createApp({
        runPass: (opts) => runPass(deps, { ...opts, trigger: 'http' }),
        moveToPeople: (opts) => moveOneToPeople(deps, opts),
        recentRuns: () => deps.ledger.recentRuns(10),
        mode: () => readWriteMode(env, WORKER),
        secret: env.RECLASSIFY_SECRET,
        promote: (opts) => promoteFromWebhook(deps, opts).catch((err) => console.error(`promote ${opts.runId}: ${errorText(err)}`)),
        requestLabel: deps.config.promote.requestLabel,
        webhookSecret: env.PROMOTE_WEBHOOK_SECRET,
        jwtPolicy: {
          signingSecret: env.MONDAY_SIGNING_SECRET, required: jwtRequired(env.MONDAY_WEBHOOK_JWT_REQUIRED),
          ...(deps.config.monday.accountId !== undefined ? { accountId: String(deps.config.monday.accountId) } : {}),
        },
        defer: (work) => ctx.waitUntil(work),
      });
      return app.fetch(request, env, ctx);
    });
  },

  // Daily trigger (wrangler.jsonc). The write mode is read once per run: `on` writes, `off` plans
  // only (a dry run still records its plan in the ledger), `hold`/`unknown` skip the run without
  // touching Monday or the ledger. src/daily.ts says what the morning does.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const mode = await readWriteMode(env, WORKER);
    const disposition = runDisposition(mode);
    if (disposition === 'skip') {
      console.log(JSON.stringify({
        writeSwitch: 'skipped', worker: WORKER, environment: environmentOf(env), mode, logLevel: await readLogLevel(env, WORKER),
        operation: 'cron', reason: 'write mode is not on or off',
      }));
      return;
    }
    await runDaily(passDeps(env), { dryRun: disposition === 'dry-run' });
  },
};
