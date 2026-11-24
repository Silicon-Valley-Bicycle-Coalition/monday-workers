// Which cron fired? Cloudflare's invocation data says a Worker ran from a cron at a given minute, not
// which expression it was, so runs are matched to expressions by time.

import type { CronWatch } from './config';

// Runs can start a little after their scheduled minute (live 2026-11-23: 14:21 for a 14:20 cron).
const LATE_MINUTES = 2;
const MINUTE_MS = 60_000;

// One field: `*`, `*/n`, `a`, `a-b`, and comma lists of those.
function field(text: string, min: number, max: number, cron: string): Set<number> {
  const bad = (): never => {
    throw new Error(`unsupported cron "${cron}": field "${text}"`);
  };
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part) ?? bad();
    const from = m[1] === undefined ? min : Number(m[1]);
    const to = m[1] === undefined ? max : m[2] === undefined ? from : Number(m[2]);
    const step = m[3] === undefined ? 1 : Number(m[3]);
    // `a/n` is left out: no Worker uses it, and it isn't clear Cloudflare reads it as `a-max/n`.
    const bareStep = m[3] !== undefined && m[1] !== undefined && m[2] === undefined;
    if (from < min || to > max || from > to || step < 1 || bareStep) bad();
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

// True at the minutes (UTC) the expression fires. Throws on syntax it doesn't read (names, L, W, #),
// so config validation rejects it rather than the watchdog guessing.
export function cronMatcher(cron: string): (at: Date) => boolean {
  const parts = cron.split(' ');
  if (parts.length !== 5) throw new Error(`unsupported cron "${cron}": expected five fields`);
  const [minute, hour, dayOfMonth, month, weekday] = [
    field(parts[0]!, 0, 59, cron),
    field(parts[1]!, 0, 23, cron),
    field(parts[2]!, 1, 31, cron),
    field(parts[3]!, 1, 12, cron),
    field(parts[4]!, 1, 7, cron), // Cloudflare: 1 = Sunday … 7 = Saturday
  ];
  if (parts[2] !== '*' && parts[4] !== '*') {
    throw new Error(`unsupported cron "${cron}": both a day of month and a weekday`);
  }
  return (at) =>
    minute.has(at.getUTCMinutes()) &&
    hour.has(at.getUTCHours()) &&
    dayOfMonth.has(at.getUTCDate()) &&
    month.has(at.getUTCMonth() + 1) &&
    weekday.has(at.getUTCDay() + 1);
}

// The newest scheduled minute each cron of one Worker is known to have run. A minute shared by k
// crons shows k runs when all of them fired; with fewer, the shortest-gap crons are credited first,
// so a dead daily job can't hide behind a live hourly one.
export function lastRuns(crons: CronWatch[], runs: { at: Date; count: number }[]): Map<string, Date> {
  const matchers = [...crons]
    .sort((a, b) => a.maxGapHours - b.maxGapHours)
    .map(({ cron }) => ({ cron, matches: cronMatcher(cron) }));

  const occurrences = new Map<number, { crons: string[]; count: number }>();
  for (const { at, count } of runs) {
    for (let late = 0; late <= LATE_MINUTES; late++) {
      const scheduled = at.getTime() - late * MINUTE_MS;
      const due = matchers.filter((m) => m.matches(new Date(scheduled))).map((m) => m.cron);
      if (due.length === 0) continue;
      const seen = occurrences.get(scheduled) ?? { crons: due, count: 0 };
      occurrences.set(scheduled, { crons: due, count: seen.count + count });
      break;
    }
  }

  const last = new Map<string, Date>();
  for (const [scheduled, { crons: due, count }] of occurrences) {
    for (const cron of due.slice(0, count)) {
      if (scheduled > (last.get(cron)?.getTime() ?? 0)) last.set(cron, new Date(scheduled));
    }
  }
  return last;
}
