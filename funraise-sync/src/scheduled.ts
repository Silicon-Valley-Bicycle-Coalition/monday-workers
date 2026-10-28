import { runDisposition, type WriteMode } from './flags';

// The two cron triggers in wrangler.jsonc. Cloudflare invokes scheduled() once per matching
// trigger with controller.cron set to it (at 09:00 both fire, as two invocations), so each job
// runs only on its own schedule and a mis-edited trigger can't fire the wrong job.
export const POLL_CRON = '0 * * * *';
export const PURGE_CRON = '0 9 * * *';

export interface ScheduledHandlers {
  // Called for `run` (live deps) or `dry-run` (src/writeSwitch.ts pollDepsFor), never for `skip`.
  poll: (disposition: 'run' | 'dry-run') => Promise<void>;
  purge: () => Promise<void>;
  pollEnabled: boolean;
  apiKeyPresent: boolean;
  // Read once for this cron run (flags.ts readWriteMode). Gates the poll only: the purge is a D1
  // retention pass, an operational write that runs in every mode.
  writeMode: WriteMode;
}

export async function dispatchScheduled(cron: string, handlers: ScheduledHandlers): Promise<void> {
  switch (cron) {
    case POLL_CRON: {
      if (!handlers.pollEnabled) {
        console.warn('funraise-sync scheduled: subscriptions poll is disabled in config (subscriptionsPoll.enabled); skipping');
        return;
      }
      if (!handlers.apiKeyPresent) {
        console.warn('funraise-sync scheduled: FUNRAISE_API_KEY is not set; skipping the subscriptions poll');
        return;
      }
      const disposition = runDisposition(handlers.writeMode);
      if (disposition === 'skip') {
        // `hold` or an unreadable switch: no Funraise read, no cursor move, so the first run back
        // under `on` walks everything changed since.
        console.warn(`funraise-sync scheduled: write mode is "${handlers.writeMode}"; skipping the subscriptions poll, cursor unchanged`);
        return;
      }
      await handlers.poll(disposition);
      return;
    }
    case PURGE_CRON:
      await handlers.purge();
      return;
    default:
      console.error(`funraise-sync scheduled: no job is bound to cron trigger "${cron}"; nothing run`);
  }
}
