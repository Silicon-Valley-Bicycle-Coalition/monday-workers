import type { RunRow, RunTrigger } from './db/ledger';
import type { ReclassificationConfig } from './types';

// The daily cron decides whether today owes a pass. Three reasons, checked in order:
//   quarterly    — the first day of a quarter month (config run.quarterlyMonths) with no pass
//                  started yet that month;
//   threshold    — the live board is at or over run.liveTriggerPct of the ceiling and no pass
//                  has run in the last 7 days (a pass that could not bring it under the line
//                  must not re-run every day);
//   continuation — the last pass finished with work remaining (capped by maxMovesPerRun or a
//                  mid-run stop) and was not started today.
// The cron is daily rather than quarterly so the threshold check runs on live counts; the pass
// itself is what's quarterly. One board-schema read a day is the cost.

export interface CronInput {
  todayISO: string;                 // the date in the config's time zone
  liveItemsCount: number;
  liveItemsLimit: number;
  // Most recent run of any trigger, dry or live, except an operator's HTTP dry-run preview or a
  // single-person move: neither may stop a continuation or use up a quarterly or threshold pass.
  // Cron dry runs (write switch off) do count, so an `off` quarter isn't re-run every day.
  lastRun: RunRow | null;
  config: ReclassificationConfig;
}

export interface CronDecision { trigger: RunTrigger; runId: string }

const DAY_MS = 86_400_000;

export function decideCron(input: CronInput): CronDecision | null {
  const { todayISO, config, lastRun } = input;
  const [year, month, day] = todayISO.split('-').map(Number) as [number, number, number];
  const lastStartedISO = lastRun?.startedAt.slice(0, 10) ?? null;
  const daysSinceLast = lastStartedISO === null ? Infinity : (Date.parse(todayISO) - Date.parse(lastStartedISO)) / DAY_MS;

  if (config.run.quarterlyMonths.includes(month) && day === 1) {
    const monthKey = todayISO.slice(0, 7);
    if (!(lastRun?.trigger === 'quarterly' && lastRun.startedAt.startsWith(monthKey))) {
      return { trigger: 'quarterly', runId: `${todayISO}-quarterly` };
    }
  }
  // Day 1 of a quarter was missed (the Worker was down, or deployed mid-quarter): catch up within
  // the month rather than wait three months — same run id scheme, keyed on the month.
  if (config.run.quarterlyMonths.includes(month) && !(lastRun !== null && lastRun.startedAt.startsWith(`${year}-${String(month).padStart(2, '0')}`))) {
    return { trigger: 'quarterly', runId: `${todayISO}-quarterly` };
  }
  const pct = (input.liveItemsCount / input.liveItemsLimit) * 100;
  if (pct >= config.thresholds.liveTriggerPct && daysSinceLast >= 7) {
    return { trigger: 'threshold', runId: `${todayISO}-threshold` };
  }
  const remaining = remainingOf(lastRun);
  if (lastRun !== null && lastRun.status === 'ok' && !lastRun.dryRun && remaining > 0 && lastStartedISO !== todayISO) {
    return { trigger: 'continuation', runId: `${todayISO}-continuation` };
  }
  return null;
}

function remainingOf(run: RunRow | null): number {
  const summary = run?.summary;
  if (typeof summary !== 'object' || summary === null) return 0;
  const remaining = (summary as { remaining?: unknown }).remaining;
  return typeof remaining === 'number' ? remaining : 0;
}
