#!/usr/bin/env node
// Operator CLI for the write switch (docs/superpowers/specs/2026-10-26-write-switch-design.md).
//
//   node scripts/flags.mjs <worker|all> writes <on|hold|off> --env <production|sandbox>
//   node scripts/flags.mjs <worker|all> log <debug|normal>   --env <production|sandbox>
//   node scripts/flags.mjs status    --env <production|sandbox>
//   node scripts/flags.mjs retention --env <production|sandbox>
//
// Order matters: KV is written first, then the Worker's main queues are paused (hold) or resumed
// (on/off), so a consumer never sees a delivered message while KV still says `hold`. DLQs are
// never paused. The FLAGS namespace ids are read from member-portal/wrangler.jsonc.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IN_SCOPE, flagsIds } from './check-worker-flags.mjs';

const ENVS = ['production', 'sandbox'];
const MODES = ['on', 'hold', 'off'];
const LOG_LEVELS = ['debug', 'normal'];
const RETENTION_SECS = 1209600; // 14 days
const WRANGLER_SOURCE = 'member-portal/wrangler.jsonc';
const USAGE = `usage:
  flags.mjs <worker|all> writes <on|hold|off> --env <production|sandbox>
  flags.mjs <worker|all> log <debug|normal> --env <production|sandbox>
  flags.mjs status --env <production|sandbox>
  flags.mjs retention --env <production|sandbox>`;

// Main queues per Worker (production names).
const QUEUES = {
  'benevity-import': ['benevity-import-writes'],
  'bp-feedback-notify': [],
  'donation-rollups': ['donation-rollups-recompute'],
  'email-log': ['email-log-writes'],
  'eventbrite-sync': ['eventbrite-sync-writes'],
  'funraise-sync': ['funraise-sync-writes'],
  'mailchimp-sync': ['mailchimp-sync-outbound', 'mailchimp-sync-inbound'],
  'member-portal': ['member-portal-change-requests', 'member-portal-letter-emails'],
  'monday-backup': [],
  'people-reclassification': [],
  'quickbooks-sync': ['quickbooks-sync-writes'],
};

export const queuesFor = (worker, env) =>
  (QUEUES[worker] ?? []).map((queue) => (env === 'sandbox' ? `${queue}-sandbox` : queue));
export const dlqsFor = (worker, env) => queuesFor(worker, env).map((queue) => `${queue}-dlq`);

// KV first, then pause (hold) or resume (on/off) every main queue.
export function planWrites(worker, mode, env) {
  const kind = mode === 'hold' ? 'pause' : 'resume';
  return [
    { kind: 'kv-put', target: `${worker}:writes`, value: mode },
    ...queuesFor(worker, env).map((queue) => ({ kind, target: queue })),
  ];
}

export function planRetention(workers, env) {
  return workers.flatMap((worker) =>
    [...queuesFor(worker, env), ...dlqsFor(worker, env)]
      .map((queue) => ['queues', 'update', queue, '--message-retention-period-secs', String(RETENTION_SECS)]));
}

export function parseArgs(argv) {
  const args = [...argv];
  let env = null;
  const envAt = args.indexOf('--env');
  if (envAt !== -1) {
    env = args[envAt + 1] ?? null;
    args.splice(envAt, 2);
  }
  if (!ENVS.includes(env)) throw new Error(`--env is required and must be production or sandbox\n${USAGE}`);

  const [first, key, value, ...rest] = args;
  if ((first === 'status' || first === 'retention') && args.length === 1) return { command: first, env };
  if (rest.length > 0 || value === undefined) throw new Error(`usage error\n${USAGE}`);
  if (first !== 'all' && !IN_SCOPE.includes(first)) throw new Error(`unknown worker "${first}" (expected all or one of ${IN_SCOPE.join(', ')})`);
  if (key === 'writes' && !MODES.includes(value)) throw new Error('writes mode must be on|hold|off');
  if (key === 'log' && !LOG_LEVELS.includes(value)) throw new Error('log level must be debug|normal');
  if (key !== 'writes' && key !== 'log') throw new Error(`usage error\n${USAGE}`);
  return { command: 'set', workers: first === 'all' ? [...IN_SCOPE] : [first], key, value, env };
}

function namespaceId(ids, env) {
  const id = ids[env];
  if (!id || id.startsWith('REPLACE_WITH')) {
    throw new Error(`FLAGS namespace id for ${env} is a placeholder — create the namespace and fill it in ${WRANGLER_SOURCE} first`);
  }
  return id;
}

const stepArgs = (step, id) =>
  step.kind === 'kv-put' ? ['kv', 'key', 'put', '--namespace-id', id, '--remote', step.target, step.value]
    : ['queues', step.kind === 'pause' ? 'pause-delivery' : 'resume-delivery', step.target];

// Runs `set` commands worker by worker, stopping at the first failure.
export async function applyCommand({ workers, key, value, env }, ids, runner) {
  const id = namespaceId(ids, env);
  const done = [];
  for (const worker of workers) {
    const steps = key === 'writes'
      ? planWrites(worker, value, env)
      : [{ kind: 'kv-put', target: `${worker}:log`, value }];
    let kvWritten = false;
    for (const step of steps) {
      const result = await runner(stepArgs(step, id));
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        const mismatch = kvWritten
          ? ` ${worker}:${key} is now ${value} but ${step.kind} of ${step.target} failed, so KV and the queue disagree — fix and rerun, then check \`flags.mjs status --env ${env}\`.`
          : '';
        return {
          ok: false,
          done,
          message: `${worker}: ${step.kind} ${step.target} failed (${detail}).${mismatch}${done.length ? ` Done before the failure: ${done.join(', ')}.` : ''}`,
        };
      }
      if (step.kind === 'kv-put') kvWritten = true;
    }
    done.push(worker);
  }
  return { ok: true, done, message: `${key} ${value} applied to ${done.join(', ')} (${env})` };
}

const parseBool = (text, label) => {
  const match = new RegExp(`${label}\\W{0,5}(true|false|yes|no)\\b`, 'i').exec(text);
  return match ? /^(true|yes)$/i.test(match[1]) : null;
};

export function parseQueueInfo(text) {
  const backlog = /backlog\D{0,20}(\d+)/i.exec(text);
  return { paused: parseBool(text, 'paused'), backlog: backlog ? Number(backlog[1]) : null };
}

export async function readStatus(workers, ids, env, runner) {
  const id = namespaceId(ids, env);
  const getKey = async (key) => {
    const result = await runner(['kv', 'key', 'get', '--namespace-id', id, '--remote', key]);
    if (result.code === 0) return result.stdout.trim();
    return /not found/i.test(`${result.stdout} ${result.stderr}`) ? null : '?';
  };
  const rows = [];
  for (const worker of workers) {
    const raw = await getKey(`${worker}:writes`);
    const mode = raw === '?' ? '?' : MODES.includes(raw) ? raw : 'off';
    const log = (await getKey(`${worker}:log`)) === 'debug' ? 'debug' : 'normal';
    const queues = [];
    for (const queue of queuesFor(worker, env)) {
      const info = await runner(['queues', 'info', queue]);
      queues.push({ queue, ...(info.code === 0 ? parseQueueInfo(info.stdout) : { paused: null, backlog: null }) });
    }
    const mismatch = (mode === 'on' || mode === 'off') ? queues.some((q) => q.paused === true)
      : mode === 'hold' ? queues.some((q) => q.paused === false) : false;
    rows.push({ worker, mode, log, queues, mismatch });
  }
  return rows;
}

export function formatStatus(rows) {
  const width = Math.max(...rows.map((r) => r.worker.length));
  return rows.map((row) => {
    const queues = row.queues
      .map((q) => `${q.queue} (${q.paused === null ? '?' : q.paused ? 'paused' : 'delivering'}, backlog ${q.backlog ?? '?'})`)
      .join('; ') || 'no queues';
    return `${row.worker.padEnd(width)}  writes=${row.mode.padEnd(4)}  log=${row.log.padEnd(6)}  ${queues}${row.mismatch ? '  MISMATCH' : ''}`;
  }).join('\n');
}

// Real runner: shells out to `npx wrangler …` and never throws.
export function wranglerRunner(args) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['wrangler', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function main(argv, runner = wranglerRunner) {
  const parsed = parseArgs(argv);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ids = flagsIds(readFileSync(join(root, WRANGLER_SOURCE), 'utf8'));

  if (parsed.command === 'retention') {
    let failed = 0;
    for (const args of planRetention(IN_SCOPE, parsed.env)) {
      const result = await runner(args);
      console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${args[2]}`);
      if (result.code !== 0) failed++;
    }
    return failed ? 1 : 0;
  }
  if (parsed.command === 'status') {
    console.log(formatStatus(await readStatus(IN_SCOPE, ids, parsed.env, runner)));
    return 0;
  }
  const result = await applyCommand(parsed, ids, runner);
  (result.ok ? console.log : console.error)(result.message);
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
