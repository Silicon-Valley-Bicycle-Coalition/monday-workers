// SVBC's own syncs, from the snapshot sync-watchdog writes at the end of each hourly run. Nothing
// here calls the Cloudflare API: the watchdog holds that token, this Worker only reads KV.

import type { SyncSpec } from './config';

// Redeclared from sync-watchdog/src/run.ts (WatchdogSnapshot): Workers don't import across
// directories. Keep the two in step.
export interface WatchdogSnapshot {
  runAt: string;
  subjects: { subject: string; status: 'ok' | 'bad' | 'check-failed'; detail?: string }[];
}
const SNAPSHOT_KEY = 'snapshot:latest';

export type SyncState = 'running' | 'not-running' | 'paused' | 'backed-up' | 'unknown';
export interface SyncRow { label: string; description: string; state: SyncState; details: string[]; lastRunAt: string | null }
export interface SyncSection { runAt: string | null; stale: boolean; rows: SyncRow[] }

const NO_RUN_SINCE = /^no run since (\S+)$/;

export function rollUp(spec: SyncSpec, snapshot: WatchdogSnapshot): SyncRow {
  const queueSubjects = spec.queues.map((q) => `queue:${q}`);
  const mine = snapshot.subjects.filter(
    (s) => s.subject.startsWith(`cron:${spec.worker}:`) || s.subject === `writes:${spec.worker}` || queueSubjects.includes(s.subject),
  );
  const badOf = (prefix: string) => mine.filter((s) => s.status === 'bad' && s.subject.startsWith(prefix));
  const badCrons = badOf('cron:');
  const missing = mine.length === 0 || queueSubjects.some((q) => !mine.some((s) => s.subject === q));

  let state: SyncState;
  if (badCrons.length > 0) state = 'not-running';
  else if (badOf('queue:').length > 0) state = 'backed-up';
  else if (badOf('writes:').length > 0) state = 'paused';
  else if (missing || mine.some((s) => s.status === 'check-failed')) state = 'unknown';
  else state = 'running';

  const lastRunAt = badCrons.map((s) => NO_RUN_SINCE.exec(s.detail ?? '')?.[1]).find((iso) => iso !== undefined) ?? null;
  return {
    label: spec.label,
    description: spec.description,
    state,
    details: mine.filter((s) => s.status !== 'ok').map((s) => s.detail ?? s.status),
    lastRunAt,
  };
}

function parse(raw: string | null): WatchdogSnapshot | null {
  if (raw === null) return null;
  try {
    const s = JSON.parse(raw) as Partial<WatchdogSnapshot>;
    if (typeof s.runAt !== 'string' || Number.isNaN(Date.parse(s.runAt)) || !Array.isArray(s.subjects)) return null;
    return s as WatchdogSnapshot;
  } catch {
    return null;
  }
}

export async function syncSection(kv: KVNamespace, syncs: SyncSpec[], maxAgeHours: number, now: Date): Promise<SyncSection> {
  let raw: string | null = null;
  try {
    raw = await kv.get(SNAPSHOT_KEY);
  } catch (err) {
    console.error(`status-page: snapshot read failed: ${err instanceof Error ? err.name : 'unknown'}`);
  }
  const snapshot = parse(raw);
  const stale = snapshot === null || now.getTime() - Date.parse(snapshot.runAt) > maxAgeHours * 3_600_000;
  if (stale) {
    // Never show the last known good state from a watchdog that has stopped reporting.
    const runAt = snapshot?.runAt ?? null;
    return {
      runAt,
      stale: true,
      rows: syncs.map((s) => ({ label: s.label, description: s.description, state: 'unknown', details: [], lastRunAt: null })),
    };
  }
  return { runAt: snapshot.runAt, stale: false, rows: syncs.map((s) => rollUp(s, snapshot)) };
}
