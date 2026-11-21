#!/usr/bin/env node
// Operator CLI for the write switch (docs/superpowers/specs/2026-10-26-write-switch-design.md).
//
//   node scripts/flags.mjs <worker|all> writes <on|hold|off> --env <production|sandbox>
//   node scripts/flags.mjs <worker|all> log <debug|normal>   --env <production|sandbox>
//   node scripts/flags.mjs status    --env <production|sandbox>
//   node scripts/flags.mjs retention --env <production|sandbox>
//
// Order matters: KV is written first, then the Worker's main queues are paused (hold) or resumed
// (on/off), so a consumer never sees a delivered message while KV still says `hold`. Before a
// resume for `on` it waits out the KV edge cache (RESUME_WAIT_MS), so a consumer reading a cached
// `hold` doesn't bounce the first resumed batch back into retries. DLQs are never paused. The FLAGS
// namespace ids are read from member-portal/wrangler.jsonc; wrangler runs from member-portal/, so
// its pinned local wrangler is the one used.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IN_SCOPE, flagsIds, stripJsonc } from './check-worker-flags.mjs';

const ENVS = ['production', 'sandbox'];
const MODES = ['on', 'hold', 'off'];
const LOG_LEVELS = ['debug', 'normal'];
const RETENTION_SECS = 1209600; // 14 days
const WRANGLER_SOURCE = 'member-portal/wrangler.jsonc';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WRANGLER_CWD = join(ROOT, 'member-portal');
// Twice the FLAGS reads' cacheTtl (30 s): a flip has reached every warm location by then.
export const RESUME_WAIT_MS = 60_000;
export const WRANGLER_TIMEOUT_MS = 120_000;
const USAGE = `usage:
  flags.mjs <worker|all> writes <on|hold|off> --env <production|sandbox>
  flags.mjs <worker|all> log <debug|normal> --env <production|sandbox>
  flags.mjs status --env <production|sandbox>
  flags.mjs retention --env <production|sandbox>`;

// Main queues per Worker (production names).
export const QUEUES = {
  'benevity-import': ['benevity-import-writes'],
  'bp-feedback-notify': [],
  'contact-roles': [],
  'donation-rollups': ['donation-rollups-recompute'],
  'dtd-sync': [], // cron-only: no queues to pause; the write switch is the dtd-sync-writes flag
  'eventbrite-sync': ['eventbrite-sync-writes'],
  'funraise-sync': ['funraise-sync-writes'],
  'impact-attribution': [], // cron-only: no queues to pause
  'mailchimp-sync': ['mailchimp-sync-outbound', 'mailchimp-sync-inbound'],
  'member-portal': ['member-portal-change-requests', 'member-portal-letter-emails'],
  'monday-backup': [],
  'nearby-search': ['nearby-search-writes'],
  'people-reclassification': [],
  'quickbooks-sync': ['quickbooks-sync-writes'],
  'report-digests': [],
  'zoom-phone-sync': ['zoom-phone-sync-writes'],
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

// The Cloudflare account the Workers deploy to (member-portal's `account_id`).
export function accountIdIn(wranglerText) {
  const id = JSON.parse(stripJsonc(wranglerText)).account_id;
  if (!id) throw new Error(`no account_id in ${WRANGLER_SOURCE}`);
  return id;
}

const stepArgs = (step, id) =>
  step.kind === 'kv-put' ? ['kv', 'key', 'put', '--namespace-id', id, '--remote', step.target, step.value]
    : ['queues', step.kind === 'pause' ? 'pause-delivery' : 'resume-delivery', step.target];

// A wrangler reply that means the queue isn't there. It is a failure, never a skip: the Worker's
// queues exist once it has been deployed, and the runbook creates them before any key is set.
const QUEUE_MISSING = /not found|does not exist|no such queue/i;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a `set` command for every Worker in turn. A Worker whose step fails stops there (the rest of
 * its steps are not run), but the next Worker still runs; the result lists every failure. Options:
 * `sleep` and `resumeWaitMs` (tests pass 0) and `log` for the wait notice.
 */
export async function applyCommand({ workers, key, value, env }, ids, runner, { sleep = defaultSleep, resumeWaitMs = RESUME_WAIT_MS, log = console.log } = {}) {
  const id = namespaceId(ids, env);
  const done = [];
  const failures = [];
  for (const worker of workers) {
    const steps = key === 'writes'
      ? planWrites(worker, value, env)
      : [{ kind: 'kv-put', target: `${worker}:log`, value }];
    let kvWritten = false;
    let waited = false;
    let failed = false;
    for (const step of steps) {
      if (step.kind === 'resume' && value === 'on' && kvWritten && !waited) {
        log(`${worker}: waiting ${Math.round(resumeWaitMs / 1000)} s for ${worker}:writes on to reach every KV cache before resuming its queues`);
        await sleep(resumeWaitMs);
        waited = true;
      }
      const result = await runner(stepArgs(step, id));
      const output = `${result.stdout ?? ''} ${result.stderr ?? ''}`;
      const queueMissing = step.kind !== 'kv-put' && QUEUE_MISSING.test(output);
      if (result.code !== 0 || queueMissing) {
        const detail = (result.stderr || result.stdout || '').trim();
        const cause = queueMissing ? `queue ${step.target} does not exist — create it (deploy the Worker) first` : detail;
        const mismatch = kvWritten
          ? ` ${worker}:${key} is now ${value} but ${step.kind} of ${step.target} failed, so KV and the queue disagree — fix and rerun, then check \`flags.mjs status --env ${env}\`.`
          : '';
        failures.push({ worker, step: step.kind, target: step.target, message: `${worker}: ${step.kind} ${step.target} failed (${cause}).${mismatch}` });
        failed = true;
        break;
      }
      if (step.kind === 'kv-put') kvWritten = true;
    }
    if (!failed) done.push(worker);
  }
  if (failures.length === 0) return { ok: true, done, failures, message: `${key} ${value} applied to ${done.join(', ')} (${env})` };
  return {
    ok: false,
    done,
    failures,
    message: [
      `${failures.length} of ${workers.length} Worker${workers.length === 1 ? '' : 's'} failed:`,
      ...failures.map((f) => `  ${f.message}`),
      done.length ? `Applied: ${done.join(', ')}.` : 'Applied to none.',
    ].join('\n'),
  };
}

// Queue state comes from the Cloudflare API, not wrangler: `wrangler queues info` (4.x) prints
// neither the paused flag nor the backlog. Paused is the queue's `settings.delivery_paused` from the
// queues list; backlog is the latest `queueBacklogAdaptiveGroups` sample in the last BACKLOG_WINDOW_MS.
// The analytics dataset records no row for an idle queue, so "no sample" reads as 0 and is flagged.
// Auth reuses wrangler's own login (`wrangler auth token --json`).
const API = 'https://api.cloudflare.com/client/v4';
export const BACKLOG_WINDOW_MS = 15 * 60_000;

// One query per status run for every queue (per-queue queries got rate-limited part-way through):
// rows come newest first, so the first row seen for a queue is its latest sample.
const BACKLOG_QUERY = `query Backlog($account: string!, $queueIds: [string!], $since: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    queueBacklogAdaptiveGroups(limit: 10000, filter: { queueId_in: $queueIds, datetime_geq: $since }, orderBy: [datetimeMinute_DESC]) {
      avg { messages }
      dimensions { queueId datetimeMinute }
    }
  } }
}`;

/**
 * Returns `(queueName) => Promise<{ paused, backlog, sampled }>` for one status run: one token, one
 * queues list, one GraphQL call for every queue's backlog. Anything it can't read comes back as null (`?`).
 * `fetchImpl` and `now` are for tests.
 */
export function apiQueueState({ runner, accountId, fetchImpl = fetch, now = () => Date.now() }) {
  let listing = null;
  const load = async () => {
    const auth = await runner(['auth', 'token', '--json']);
    if (auth.code !== 0) throw new Error(`wrangler auth token failed: ${(auth.stderr || auth.stdout).trim()}`);
    const { token } = JSON.parse(auth.stdout);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const queues = new Map();
    for (let page = 1, pages = 1; page <= pages; page++) {
      const res = await fetchImpl(`${API}/accounts/${accountId}/queues?per_page=100&page=${page}`, { headers });
      const body = await res.json();
      if (!body.success) throw new Error(`queues list failed: ${JSON.stringify(body.errors)}`);
      for (const q of body.result) queues.set(q.queue_name, q);
      pages = body.result_info?.total_pages ?? 1;
    }
    const variables = { account: accountId, queueIds: [...queues.values()].map((q) => q.queue_id), since: new Date(now() - BACKLOG_WINDOW_MS).toISOString() };
    const res = await fetchImpl(`${API}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query: BACKLOG_QUERY, variables }) });
    const body = await res.json();
    const groups = body.errors ? null : body.data?.viewer?.accounts?.[0]?.queueBacklogAdaptiveGroups;
    // null: the backlog couldn't be read at all (every queue shows `?`).
    let backlogs = null;
    if (Array.isArray(groups)) {
      backlogs = new Map();
      for (const g of groups) if (!backlogs.has(g.dimensions.queueId)) backlogs.set(g.dimensions.queueId, Math.round(g.avg.messages));
    }
    return { queues, backlogs };
  };
  return async (name) => {
    try {
      listing ??= load();
      const { queues, backlogs } = await listing;
      const queue = queues.get(name);
      if (!queue) return { paused: null, backlog: null, sampled: false, missing: true };
      const paused = queue.settings?.delivery_paused === true;
      if (backlogs === null) return { paused, backlog: null, sampled: false };
      return backlogs.has(queue.queue_id) ? { paused, backlog: backlogs.get(queue.queue_id), sampled: true } : { paused, backlog: 0, sampled: false };
    } catch {
      listing = null;
      return { paused: null, backlog: null, sampled: false };
    }
  };
}

export async function readStatus(workers, ids, env, runner, queueState) {
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
    const rawLog = await getKey(`${worker}:log`);
    const log = rawLog === '?' ? '?' : rawLog === 'debug' ? 'debug' : 'normal';
    const queues = [];
    for (const queue of queuesFor(worker, env)) {
      queues.push({ queue, ...(await queueState(queue)) });
    }
    const mismatch = (mode === 'on' || mode === 'off') ? queues.some((q) => q.paused === true)
      : mode === 'hold' ? queues.some((q) => q.paused === false) : false;
    rows.push({ worker, mode, log, queues, mismatch });
  }
  return rows;
}

// True when every row agrees with its queues and every value was read: `status` exits non-zero
// on a MISMATCH or any `?`.
export function statusOk(rows) {
  return rows.every((row) => !row.mismatch && row.mode !== '?' && row.log !== '?'
    && row.queues.every((q) => q.paused !== null && q.backlog !== null));
}

export function formatStatus(rows) {
  const width = Math.max(...rows.map((r) => r.worker.length));
  return rows.map((row) => {
    const queues = row.queues
      .map((q) => `${q.queue} (${q.missing ? 'missing' : q.paused === null ? '?' : q.paused ? 'paused' : 'delivering'}, backlog ${q.backlog ?? '?'}${q.backlog !== null && q.sampled === false ? ' (no recent sample)' : ''})`)
      .join('; ') || 'no queues';
    return `${row.worker.padEnd(width)}  writes=${row.mode.padEnd(4)}  log=${row.log.padEnd(6)}  ${queues}${row.mismatch ? '  MISMATCH' : ''}`;
  }).join('\n');
}

// Real runner: shells out to `npx wrangler …` from member-portal/ (its pinned wrangler) and never
// throws. A call that runs past `timeoutMs` is killed and reported as code 1, "timed out".
// `command` is for tests.
export function wranglerRunner(args, { cwd = WRANGLER_CWD, timeoutMs = WRANGLER_TIMEOUT_MS, command = ['npx', 'wrangler'] } = {}) {
  return new Promise((resolve) => {
    const [bin, ...pre] = command;
    const child = spawn(bin, [...pre, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: 1, stdout, stderr: `${stderr}wrangler ${args.join(' ')} timed out after ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ code: 1, stdout, stderr: String(error) }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

export async function main(argv, runner = wranglerRunner, options = {}) {
  const parsed = parseArgs(argv);
  const wranglerText = readFileSync(join(ROOT, WRANGLER_SOURCE), 'utf8');
  const ids = flagsIds(wranglerText);

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
    const queueState = options.queueState ?? apiQueueState({ runner, accountId: accountIdIn(wranglerText) });
    const rows = await readStatus(IN_SCOPE, ids, parsed.env, runner, queueState);
    console.log(formatStatus(rows));
    if (statusOk(rows)) return 0;
    console.error('status: a MISMATCH or an unread value (?) — see the rows above');
    return 1;
  }
  const result = await applyCommand(parsed, ids, runner, options);
  (result.ok ? console.log : console.error)(result.message);
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
