// The two cron triggers in wrangler.jsonc. Cloudflare invokes scheduled() once per matching
// trigger with controller.cron set to it (at 09:00 both fire, as two invocations), so each job
// runs only on its own schedule and a mis-edited trigger can't fire the wrong job.
export const POLL_CRON = '0 * * * *';
export const PURGE_CRON = '0 9 * * *';

export interface ScheduledHandlers {
  poll: () => Promise<void>;
  purge: () => Promise<void>;
  pollEnabled: boolean;
  apiKeyPresent: boolean;
}

export async function dispatchScheduled(cron: string, handlers: ScheduledHandlers): Promise<void> {
  switch (cron) {
    case POLL_CRON:
      if (!handlers.pollEnabled) {
        console.warn('funraise-sync scheduled: subscriptions poll is disabled in config (subscriptionsPoll.enabled); skipping');
        return;
      }
      if (!handlers.apiKeyPresent) {
        console.warn('funraise-sync scheduled: FUNRAISE_API_KEY is not set; skipping the subscriptions poll');
        return;
      }
      await handlers.poll();
      return;
    case PURGE_CRON:
      await handlers.purge();
      return;
    default:
      console.error(`funraise-sync scheduled: no job is bound to cron trigger "${cron}"; nothing run`);
  }
}
