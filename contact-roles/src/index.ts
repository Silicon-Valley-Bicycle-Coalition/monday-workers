import { configFor } from './config';
import { environmentOf } from './environment';
import { readLogLevel, readWriteMode, runDisposition } from './flags';
import { HttpMondayClient } from './monday/client';
import { tokenProviderFor } from './monday/graphql';
import { runReconcile } from './reconcile';
import type { Env } from './types';

const WORKER = 'contact-roles';

export default {
  // No HTTP surface: the Worker only runs on its cron trigger.
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },

  // The write mode is read once per run: `on` writes, `off` computes and logs only, and
  // `hold`/`unknown` skip the run without touching Monday.
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
    await runReconcile({ monday, config }, disposition === 'run' ? 'on' : 'off');
  },
} satisfies ExportedHandler<Env>;
