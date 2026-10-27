import { sendFailureAlert } from './alert';

// Account-wide Monday API usage check, run from the hourly watchdog cron. Monday caps the whole
// account's API calls per day (Pro: 10,000, resetting at midnight UTC) across every token — every
// Worker's integration user, staff personal tokens and the hosted MCP alike — and from 2027 calls
// over the cap may fail with DAILY_LIMIT_EXCEEDED. This alerts once per threshold per UTC day, so
// an unusual day (a backfill, a bulk recompute) is visible long before it starts failing writes.
//
// The limit is account-wide, so exactly one deployment should run this (config.apiUsageAlerts);
// the sandbox and production Workers share one Monday account. Costs one API call per run.

const THRESHOLDS = [50, 80]; // percent of the day's total limit, ascending

export interface DailyUsage {
  // `daily_limit.total`: the plan's base limit plus any purchased API add-on.
  limit: number;
  lastUpdated: string | null;
  byDay: { day: string; usage: number }[];
}

export interface UsageAlertStore {
  // The UTC day and threshold of the most recent usage alert, or null if none ever fired.
  lastUsageAlert(): Promise<{ day: string; level: number } | null>;
  recordUsageAlert(day: string, level: number): Promise<void>;
}

export interface UsageCheckDeps {
  fetchUsage: () => Promise<DailyUsage>;
  store: UsageAlertStore;
  slackWebhookUrl: string;
  now: () => Date;
}

export async function runUsageCheck(deps: UsageCheckDeps): Promise<void> {
  const day = deps.now().toISOString().slice(0, 10);
  const usage = await deps.fetchUsage();
  // A day Monday hasn't reported yet (just after midnight UTC) has used nothing that counts.
  const used = usage.byDay.find((d) => d.day === day)?.usage ?? 0;
  const percent = (used / usage.limit) * 100;

  const level = THRESHOLDS.filter((t) => percent >= t).at(-1);
  if (level === undefined) return;

  const last = await deps.store.lastUsageAlert();
  if (last !== null && last.day === day && last.level >= level) return;

  await sendFailureAlert(
    deps.slackWebhookUrl,
    `Monday API usage passed ${level}% of the daily limit`,
    `${used.toLocaleString('en-US')} of ${usage.limit.toLocaleString('en-US')} calls used on ${day} UTC ` +
      `(${Math.round(percent)}%; Monday's figures as of ${usage.lastUpdated ?? 'unknown'}). ` +
      `The limit is account-wide and resets at midnight UTC; see platform_api daily_analytics by_user for who is using it.`,
  );
  await deps.store.recordUsageAlert(day, level);
}
