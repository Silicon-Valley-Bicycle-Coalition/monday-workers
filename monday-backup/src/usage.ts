import { sendFailureAlert } from './alert';
import { recordingProxy, type SkipContext } from './flags';

// Account-wide Monday API usage check, run from the hourly watchdog cron. Monday caps the whole
// account's API calls per day (Pro: 10,000, resetting at midnight UTC) across every token — every
// Worker's integration user, staff personal tokens and the hosted MCP alike — and from 2027 calls
// over the cap may fail with DAILY_LIMIT_EXCEEDED. This alerts once per threshold per UTC day, so
// an unusual day (a backfill, a bulk recompute) is visible long before it starts failing writes.
//
// The limit is account-wide, so exactly one deployment should run this (config.apiUsageAlerts);
// the sandbox and production Workers share one Monday account. Costs one API call per run.

const THRESHOLDS = [50, 80, 100]; // percent of the day's total limit, ascending
const USERS_NAMED = 3;

export interface DailyUsage {
  // `daily_limit.total`: the plan's base limit plus any purchased API add-on.
  limit: number;
  lastUpdated: string | null;
  byDay: { day: string; usage: number }[];
  // Each user's calls over Monday's whole reporting window (14 days), not today's. Keyed by name.
  byUser: Record<string, number>;
}

// Monday has no per-user figure for a single day, so each hourly check adds up how much each
// user's window total grew. Adding hourly growth rather than diffing against one morning baseline
// means an old day leaving the window (which shrinks a total, at a time Monday doesn't state) only
// understates that one hour.
export interface UsageTracking {
  day: string; // UTC day `today` covers
  since: string; // when counting began for that day: the first check, about 00:30 UTC
  totals: Record<string, number>; // window totals at the last check
  today: Record<string, number>; // calls per user since `since`
}

export interface UsageAlertStore {
  // The UTC day and threshold of the most recent usage alert, or null if none ever fired.
  lastUsageAlert(): Promise<{ day: string; level: number } | null>;
  recordUsageAlert(day: string, level: number): Promise<void>;
  usageTracking(): Promise<UsageTracking | null>;
  saveUsageTracking(tracking: UsageTracking): Promise<void>;
}

export interface UsageCheckDeps {
  fetchUsage: () => Promise<DailyUsage>;
  store: UsageAlertStore;
  slackWebhookUrl: string;
  now: () => Date;
  // Set unless the write switch is `on`: the alert is recorded as a skip line instead of sent and
  // not marked as sent, so it still fires once the switch is back on (same rule as the watchdog).
  dryRun?: SkipContext;
}

function nextTracking(last: UsageTracking | null, totals: Record<string, number>, now: Date): UsageTracking {
  const day = now.toISOString().slice(0, 10);
  if (last === null || last.day !== day) return { day, since: now.toISOString(), totals, today: {} };
  const today = { ...last.today };
  for (const [name, total] of Object.entries(totals)) {
    const grew = total - (last.totals[name] ?? 0);
    if (grew > 0) today[name] = (today[name] ?? 0) + grew;
  }
  return { day, since: last.since, totals, today };
}

function describeUsers({ since, today }: UsageTracking): string {
  const top = Object.entries(today)
    .sort(([, a], [, b]) => b - a)
    .slice(0, USERS_NAMED)
    .map(([name, calls]) => `${name} ${calls.toLocaleString('en-US')}`);
  return top.length === 0
    ? 'No per-user figures yet today; they build up from the next hourly check.'
    : `Most calls since ${since.slice(11, 16)} UTC: ${top.join('; ')}.`;
}

export async function runUsageCheck(deps: UsageCheckDeps): Promise<void> {
  const day = deps.now().toISOString().slice(0, 10);
  const usage = await deps.fetchUsage();
  // Every check, quiet ones too and under a dry run: only the Slack alert is gated.
  const tracking = nextTracking(await deps.store.usageTracking(), usage.byUser, deps.now());
  await deps.store.saveUsageTracking(tracking);
  // A day Monday hasn't reported yet (just after midnight UTC) has used nothing that counts.
  const used = usage.byDay.find((d) => d.day === day)?.usage ?? 0;
  const percent = (used / usage.limit) * 100;

  const level = THRESHOLDS.filter((t) => percent >= t).at(-1);
  if (level === undefined) return;

  const last = await deps.store.lastUsageAlert();
  if (last !== null && last.day === day && last.level >= level) return;

  const alerts = deps.dryRun
    ? recordingProxy({ sendFailureAlert }, 'Slack alert', { sendFailureAlert: undefined }, deps.dryRun)
    : { sendFailureAlert };
  await alerts.sendFailureAlert(
    deps.slackWebhookUrl,
    `Monday API usage passed ${level}% of the daily limit`,
    `${used.toLocaleString('en-US')} of ${usage.limit.toLocaleString('en-US')} calls used on ${day} UTC ` +
      `(${Math.round(percent)}%; Monday's figures as of ${usage.lastUpdated ?? 'unknown'}). ` +
      `${describeUsers(tracking)} The limit is account-wide and resets at midnight UTC.`,
  );
  if (!deps.dryRun) await deps.store.recordUsageAlert(day, level);
}
