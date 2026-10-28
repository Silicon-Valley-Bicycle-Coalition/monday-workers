import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector, environmentOf } from './environment';
import { validateConfig } from './config';
import { readLogLevel, readWriteMode, runDisposition } from './flags';
import { D1Ledger } from './db/ledger';
import { HttpMondayClient } from './monday/client';
import { runPass, type PassDeps } from './pass';
import { decideCron } from './duties';
import { createApp } from './routes';
import { checkRequestRateLimit } from './rateLimit';
import { todayInZone } from './classify';
import { errorText } from './logSafe';
import type { Env } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

const WORKER = 'people-reclassification';

function passDeps(env: Env): PassDeps {
  const config = configFor(env);
  return { monday: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN), ledger: new D1Ledger(env.DB), config };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // configFor validates synchronously and must keep throwing synchronously on a misconfigured
    // ENVIRONMENT, before any routing or rate-limit check.
    configFor(env);
    return checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) }).then((limited) => {
      if (limited) return limited;
      const deps = passDeps(env);
      const app = createApp({
        runPass: (opts) => runPass(deps, { ...opts, trigger: 'http' }),
        recentRuns: () => deps.ledger.recentRuns(10),
        mode: () => readWriteMode(env, WORKER),
        secret: env.RECLASSIFY_SECRET,
      });
      return app.fetch(request, env, ctx);
    });
  },

  // Daily trigger (wrangler.jsonc); decideCron says whether today owes a pass. The write mode is
  // read once per run: `on` moves items, `off` plans only (a dry-run pass still records its plan in
  // the ledger), `hold`/`unknown` skip the run without touching Monday or the ledger.
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
    const deps = passDeps(env);
    const { config } = deps;
    const live = await deps.monday.getBoardSchema(config.boards.live.boardId);
    if (live === null) {
      console.error(`reclassify cron: People board ${config.boards.live.boardId} is not visible — nothing checked`);
      return;
    }
    const decision = decideCron({
      todayISO: todayInZone(new Date(), config.window.timeZone),
      liveItemsCount: live.itemsCount, liveItemsLimit: live.itemsLimit ?? config.thresholds.itemsLimit,
      lastRun: await deps.ledger.lastRun({ skipPreviews: true }), config,
    });
    if (decision === null) {
      console.log(`reclassify cron: no pass due (People at ${live.itemsCount}/${live.itemsLimit ?? config.thresholds.itemsLimit})`);
      return;
    }
    try {
      const result = await runPass(deps, { ...decision, dryRun: disposition === 'dry-run' });
      if ('skipped' in result) console.log(`reclassify cron: ${result.skipped}`);
    } catch (err) {
      console.error(`reclassify cron (${decision.trigger}): ${errorText(err)}`);
    }
  },
};
