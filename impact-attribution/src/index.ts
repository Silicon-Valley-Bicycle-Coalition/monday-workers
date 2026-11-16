import { environmentOf } from './environment';
import { readLogLevel, readWriteMode, runDisposition } from './flags';
import type { Env } from './types';

const WORKER = 'impact-attribution';

export default {
  // No HTTP surface: the Worker only runs on its nightly cron.
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },

  // The write mode is read once per run: `on` writes, `off` refreshes the match history and logs
  // what it would propose, and `hold`/`unknown` skip the run without touching Monday or D1.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const mode = await readWriteMode(env, WORKER);
    if (runDisposition(mode) === 'skip') {
      console.log(JSON.stringify({
        writeSwitch: 'skipped', worker: WORKER, environment: environmentOf(env), mode, logLevel: await readLogLevel(env, WORKER),
        operation: 'cron', reason: 'write mode is not on or off',
      }));
      return;
    }
    // The proposal run is wired in Task 5 of the plan.
  },
} satisfies ExportedHandler<Env>;
