import { sendFailureAlert } from './alert';

// Independent staleness check (issue #29), on its own hourly cron so it runs in a separate
// invocation from the backup: a backup the runtime kills for CPU or wall time never reaches its
// own catch, so only something outside that invocation can notice. It still shares this Worker's
// deploy, D1 and Slack secret — an external heartbeat monitor is the next step if that matters.

const STUCK_RUN_MS = 60 * 60 * 1000; // no run can legitimately outlive the 15-minute cron cap
const STALE_SNAPSHOT_MS = 36 * 60 * 60 * 1000; // one missed nightly run, plus slack
const STALE_ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;

export interface WatchdogStore {
  // Marks every 'running' row started before `cutoffUtc` as 'abandoned' and returns them.
  abandonStaleRuns(cutoffUtc: string, finishedAtUtc: string): Promise<{ id: number; startedAt: string }[]>;
  // finished_at of the latest run that wrote a snapshot ('success' or 'partial'), or null.
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
}

export async function runWatchdog(deps: WatchdogDeps): Promise<void> {
  const now = deps.now();
  const nowUtc = now.toISOString();

  const abandoned = await deps.store.abandonStaleRuns(new Date(now.getTime() - STUCK_RUN_MS).toISOString(), nowUtc);
  if (abandoned.length > 0) {
    const which = abandoned.map((r) => `run ${r.id} (started ${r.startedAt})`).join(', ');
    await sendFailureAlert(
      deps.slackWebhookUrl,
      `${abandoned.length} backup run(s) never finished — likely killed by the Workers CPU or wall-time limit, so no snapshot was recorded`,
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
      ? `No snapshot has ever succeeded (watchdog armed ${armedAt}).`
      : `Last snapshot finished ${lastSnapshot}.`;
  await sendFailureAlert(deps.slackWebhookUrl, 'no successful snapshot in over 36 hours', detail);
  await deps.store.recordStaleAlert(nowUtc);
}
