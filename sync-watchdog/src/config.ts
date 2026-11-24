// What the watchdog watches, per environment (config/svbc.json, config/sandbox.json).
// config/coverage.test.ts keeps svbc.json in step with every Worker's wrangler.jsonc.

import { cronMatcher } from './cron';

export interface CronWatch {
  cron: string;
  maxGapHours: number;
}

export interface WatchedWorker {
  script: string;
  // The write switch this Worker should be on; null for a Worker without one.
  expectedWrites: 'on' | 'off' | null;
  crons: CronWatch[];
}

export interface QueueWatch {
  name: string;
  maxBacklogAgeHours: number;
}

export interface WatchdogConfig {
  accountId: string;
  selfScript: string; // this Worker's own script: proves Cloudflare's run data is arriving
  watched: Record<string, WatchedWorker>; // key: Worker directory name
  notLive: Record<string, string>; // key: directory name, value: reason
  queues: QueueWatch[];
}

type Json = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`sync-watchdog config: ${message}`);
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function validateConfig(raw: unknown): WatchdogConfig {
  if (!isObject(raw)) fail('not an object');
  if (typeof raw.accountId !== 'string' || raw.accountId === '') fail('accountId is required');
  if (typeof raw.selfScript !== 'string' || raw.selfScript === '') fail('selfScript is required');
  if (!isObject(raw.watched)) fail('watched must be an object');
  if (!isObject(raw.notLive)) fail('notLive must be an object');
  if (!Array.isArray(raw.queues)) fail('queues must be an array');

  for (const [dir, w] of Object.entries(raw.watched)) {
    if (dir in raw.notLive) fail(`${dir} is in both watched and notLive`);
    if (!isObject(w) || typeof w.script !== 'string' || w.script === '') fail(`${dir}: script is required`);
    if (!(w.expectedWrites === 'on' || w.expectedWrites === 'off' || w.expectedWrites === null)) {
      fail(`${dir}: expectedWrites must be "on", "off" or null`);
    }
    if (!Array.isArray(w.crons)) fail(`${dir}: crons must be an array`);
    for (const c of w.crons as unknown[]) {
      if (!isObject(c) || typeof c.cron !== 'string') fail(`${dir}: each cron needs an expression`);
      try {
        cronMatcher(c.cron);
      } catch (err) {
        fail(`${dir}: ${err instanceof Error ? err.message : err}`);
      }
      if (!positive(c.maxGapHours)) fail(`${dir} ${c.cron}: maxGapHours must be a positive number`);
    }
  }
  for (const [dir, reason] of Object.entries(raw.notLive)) {
    if (typeof reason !== 'string' || reason === '') fail(`notLive ${dir}: a reason is required`);
  }
  for (const q of raw.queues as unknown[]) {
    if (!isObject(q) || typeof q.name !== 'string' || q.name === '') fail('each queue needs a name');
    if (!positive(q.maxBacklogAgeHours)) fail(`${q.name}: maxBacklogAgeHours must be a positive number`);
  }
  return raw as unknown as WatchdogConfig;
}
