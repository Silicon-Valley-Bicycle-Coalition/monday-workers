// The four checks. Each returns one result per subject; an error reading a subject's state makes
// that subject 'check-failed' (logged by src/run.ts, state left alone), never healthy.

import type { CloudflareApi, CronRun } from './cloudflare';
import type { WatchdogConfig } from './config';
import { lastRuns } from './cron';
import type { Health, SubjectState } from './state';

export interface SubjectResult {
  subject: string;
  health: Health | 'check-failed';
  error?: string;
}

const HOUR_MS = 3_600_000;
// Two of the watchdog's own hourly runs: one may be missing from the data.
const STALE_DATA_HOURS = 2;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// cron:<worker>:<cron> — one subject per schedule, so a dead daily job can't hide behind a live
// hourly one. A subject is judged from max(last run, armedAt): a Worker that just went live, or
// a cron the watchdog has only just seen, gets its full gap before it can alert.
export async function cronSubjects(
  cfg: WatchdogConfig,
  api: CloudflareApi,
  states: Map<string, SubjectState>,
  now: Date,
): Promise<SubjectResult[]> {
  const workers = Object.entries(cfg.watched).filter(([, w]) => w.crons.length > 0);
  if (workers.length === 0) return [];
  const subjectOf = (worker: string, cron: string) => `cron:${worker}:${cron}`;

  let runs: CronRun[];
  try {
    // Only the window that decides health.
    const lookback = Math.max(...workers.flatMap(([, w]) => w.crons.map((c) => c.maxGapHours)));
    runs = await api.cronRuns([...workers.map(([, w]) => w.script), cfg.selfScript], new Date(now.getTime() - lookback * HOUR_MS));
    // The watchdog ran an hour ago, so data with no recent run at all is missing data, and says
    // nothing about the Workers.
    const newest = runs.reduce((max, r) => Math.max(max, r.at.getTime()), 0);
    if (now.getTime() - newest > STALE_DATA_HOURS * HOUR_MS) {
      throw new Error(
        `Cloudflare reports no cron runs of any watched Worker, or of this one, in the last ${STALE_DATA_HOURS} h; its data is missing or late`,
      );
    }
  } catch (err) {
    return workers.flatMap(([worker, w]) =>
      w.crons.map(({ cron }): SubjectResult => ({ subject: subjectOf(worker, cron), health: 'check-failed', error: errorText(err) })),
    );
  }

  return workers.flatMap(([worker, w]) => {
    const last = lastRuns(w.crons, runs.filter((r) => r.script === w.script));
    return w.crons.map(({ cron, maxGapHours }): SubjectResult => {
      const subject = subjectOf(worker, cron);
      const lastRun = last.get(cron);
      const armedAt = Date.parse(states.get(subject)?.armedAt ?? now.toISOString());
      const reference = Math.max(lastRun?.getTime() ?? 0, armedAt);
      if (now.getTime() - reference <= maxGapHours * HOUR_MS) return { subject, health: { ok: true } };
      const detail = lastRun ? `no run since ${lastRun.toISOString()}` : `no run in the last ${maxGapHours} h`;
      return { subject, health: { ok: false, detail } };
    });
  });
}

// writes:<worker> — a missing key reads as `off`, the repo's write-switch convention.
export async function writeSwitchSubjects(cfg: WatchdogConfig, flags: KVNamespace): Promise<SubjectResult[]> {
  const jobs = Object.entries(cfg.watched)
    .filter(([, w]) => w.expectedWrites !== null)
    .map(async ([worker, w]): Promise<SubjectResult> => {
      const subject = `writes:${worker}`;
      try {
        const value = (await flags.get(`${worker}:writes`, { cacheTtl: 30 })) ?? 'off';
        return value === w.expectedWrites
          ? { subject, health: { ok: true } }
          : { subject, health: { ok: false, detail: `writes are ${value}, expected ${w.expectedWrites}` } };
      } catch (err) {
        return { subject, health: 'check-failed', error: errorText(err) };
      }
    });
  return Promise.all(jobs);
}

// queue:<name> — a backlog whose oldest message is older than the threshold isn't draining.
export async function queueSubjects(cfg: WatchdogConfig, api: CloudflareApi): Promise<SubjectResult[]> {
  const jobs = cfg.queues.map(async ({ name, maxBacklogAgeHours }): Promise<SubjectResult> => {
    const subject = `queue:${name}`;
    try {
      const { count, oldestAgeHours } = await api.queueBacklog(name);
      if (count === 0 || oldestAgeHours === null || oldestAgeHours <= maxBacklogAgeHours) return { subject, health: { ok: true } };
      return { subject, health: { ok: false, detail: `${count} messages waiting, oldest ${oldestAgeHours.toFixed(1)} h` } };
    } catch (err) {
      return { subject, health: 'check-failed', error: errorText(err) };
    }
  });
  return Promise.all(jobs);
}

// domains:<zone> — one subject for the zone, so a new route (which has no subject of its own yet)
// still alerts. The detail lists every difference, sorted, so it only changes when the zone does;
// src/run.ts re-posts when it changes. A route runs before a Custom Domain on the same hostname
// (developers.cloudflare.com/workers/configuration/routing/custom-domains/#interaction-with-routes),
// so an unexpected route can take over a production hostname without touching its domain.
export async function domainSubjects(cfg: WatchdogConfig, api: CloudflareApi): Promise<SubjectResult[]> {
  const d = cfg.domains;
  if (!d) return [];
  const subject = `domains:${d.zone}`;
  try {
    const domains = await api.customDomains(d.zone);
    const diffs: string[] = [];
    const seen = new Map(domains.map((x) => [x.hostname, x.service]));
    for (const [host, script] of Object.entries(d.customDomains)) {
      const actual = seen.get(host);
      if (actual === undefined) diffs.push(`custom domain ${host} missing (expected ${script})`);
      else if (actual !== script) diffs.push(`custom domain ${host} -> ${actual} (expected ${script})`);
    }
    for (const [host, service] of seen) {
      if (host in d.customDomains) continue;
      const pending = d.pending[host];
      if (pending === undefined) diffs.push(`unexpected custom domain ${host} -> ${service}`);
      else if (pending.script !== service) diffs.push(`custom domain ${host} -> ${service} (expected ${pending.script})`);
    }
    // The zone id comes from the listing, so the token needs no Zone Read.
    const zoneId = domains[0]?.zoneId;
    if (zoneId === undefined) {
      diffs.push('zone routes not checked: no Custom Domains to take the zone id from');
    } else {
      const routes = await api.zoneRoutes(zoneId);
      const actual = new Map(routes.map((r) => [r.pattern, r.script]));
      const name = (s: string | null) => s ?? 'no Worker';
      for (const [pattern, script] of Object.entries(d.routes)) {
        if (!actual.has(pattern)) diffs.push(`route ${pattern} missing (expected ${name(script)})`);
        else if (actual.get(pattern) !== script) diffs.push(`route ${pattern} -> ${name(actual.get(pattern)!)} (expected ${name(script)})`);
      }
      for (const [pattern, script] of actual) {
        if (!(pattern in d.routes)) diffs.push(`unexpected route ${pattern} -> ${name(script)}`);
      }
    }
    return [{ subject, health: diffs.length === 0 ? { ok: true } : { ok: false, detail: diffs.sort().join('; ') } }];
  } catch (err) {
    return [{ subject, health: 'check-failed', error: errorText(err) }];
  }
}
