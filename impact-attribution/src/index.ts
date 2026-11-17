import { configFor } from './config';
import { environmentOf } from './environment';
import { readLogLevel, readWriteMode, runDisposition } from './flags';
import { HttpMondayClient } from './monday/client';
import { tokenProviderFor } from './monday/graphql';
import { runNightly } from './nightly';
import type { Env } from './types';

const WORKER = 'impact-attribution';

export default {
  // No HTTP surface: the Worker only runs on its nightly cron.
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },

  // The write mode is read once per run and governs both jobs (src/nightly.ts): `on` writes, `off`
  // refreshes the Worker's own D1 state and logs what it would propose, and `hold`/`unknown` skip
  // the run without touching Monday or D1.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const mode = await readWriteMode(env, WORKER);
    const disposition = runDisposition(mode);
    if (disposition === 'skip') {
      console.log(JSON.stringify({
        writeSwitch: 'skipped', worker: WORKER, environment: environmentOf(env), mode, logLevel: await readLogLevel(env, WORKER),
        operation: 'cron', reason: 'write mode is not on or off',
      }));
      return;
    }
    const config = configFor(env);
    const monday = new HttpMondayClient(config.monday.apiUrl, tokenProviderFor(env));
    const now = new Date().toISOString();
    await runNightly(
      { monday, db: env.DB, config, environment: environmentOf(env), today: now.slice(0, 10), now },
      disposition === 'run' ? 'on' : 'off',
    );
  },
} satisfies ExportedHandler<Env>;
