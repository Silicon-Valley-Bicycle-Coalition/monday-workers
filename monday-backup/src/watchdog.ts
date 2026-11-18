import { sendFailureAlert } from './alert';
import { recordingProxy, type SkipContext } from './flags';

// Independent staleness check (issue GL#29), on its own hourly cron so it runs apart from the backup:
// a run that dies without reaching its own catch can't report itself, so only something outside it
// can notice. It still shares this Worker's
// deploy, D1 and Slack secret — an external heartbeat monitor is the next step if that matters.

const STUCK_RUN_MS = 12 * 60 * 60 * 1000; // a complete run takes about an hour; this leaves room for a bad night
const STALE_SNAPSHOT_MS = 36 * 60 * 60 * 1000; // one missed nightly run, plus slack
const STALE_ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;

export interface WatchdogStore {
  // Marks every 'running' row started before `cutoffUtc` as 'abandoned' and returns them.
  abandonStaleRuns(cutoffUtc: string, finishedAtUtc: string): Promise<{ id: number; startedAt: string }[]>;
  // finished_at of the latest complete snapshot ('success'), or null. A partial run doesn't count:
  // holding 19 of 262 boards is not a healthy backup, and it alerts on its own anyway.
  lastSnapshotAt(): Promise<string | null>;
  // Records the first time the watchdog ran and returns it (unchanged on later calls).
  armWatchdog(nowUtc: string): Promise<string>;
  lastStaleAlertAt(): Promise<string | null>;
  recordStaleAlert(nowUtc: string): Promise<void>;
}

export interface WatchdogDeps {
  store: WatchdogStore;
  slackWebhookUrl: string;
  now: () => Date;
  // Set unless the write switch is `on`: Slack alerts are then recorded as skip lines instead of
  // sent, and a suppressed stale-snapshot alert is not marked as sent (so it still fires once the
  // switch is back on, rather than waiting out the 24h throttle). D1 bookkeeping stays live.
  dryRun?: SkipContext;
}

export async function runWatchdog(deps: WatchdogDeps): Promise<void> {
  const alerts = deps.dryRun
    ? recordingProxy({ sendFailureAlert }, 'Slack alert', { sendFailureAlert: undefined }, deps.dryRun)
    : { sendFailureAlert };
  const now = deps.now();
  const nowUtc = now.toISOString();

  const abandoned = await deps.store.abandonStaleRuns(new Date(now.getTime() - STUCK_RUN_MS).toISOString(), nowUtc);
  if (abandoned.length > 0) {
    const which = abandoned.map((r) => `run ${r.id} (started ${r.startedAt})`).join(', ');
    await alerts.sendFailureAlert(
      deps.slackWebhookUrl,
      `${abandoned.length} backup run(s) never finished — the Workflow died or hung, so no snapshot was recorded`,
      which,
    );
  }

  const armedAt = await deps.store.armWatchdog(nowUtc);
  const lastSnapshot = await deps.store.lastSnapshotAt();
  const reference = lastSnapshot ?? armedAt;
  if (now.getTime() - Date.parse(reference) <= STALE_SNAPSHOT_MS) return;

  const lastAlert = await deps.store.lastStaleAlertAt();
  if (lastAlert !== null && now.getTime() - Date.parse(lastAlert) < STALE_ALERT_REPEAT_MS) return;

  const detail =
    lastSnapshot === null
      ? `No complete snapshot yet (watchdog armed ${armedAt}).`
      : `Last complete snapshot finished ${lastSnapshot}.`;
  await alerts.sendFailureAlert(deps.slackWebhookUrl, 'no complete snapshot in over 36 hours', detail);
  if (!deps.dryRun) await deps.store.recordStaleAlert(nowUtc);
}
