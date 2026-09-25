#!/usr/bin/env node
// Re-drives Funraise transactions whose Monday write never landed — `events` rows left 'failed'
// (dead-lettered after retries, see src/consumer/processDeadLetters.ts, or an enqueue that
// failed) or stranded at 'received'. Mirrors donation-rollups' scripts/redrive-pending.mjs:
// nothing here writes to D1 or Monday directly. Each row's stored (PII-stripped) payload is
// POSTed back to the deployed Worker as the envelope it arrived in, so the route's own
// duplicate-recovery path re-enqueues it and the consumer does the write exactly as it would
// for a Funraise redelivery. Fix the cause first (e.g. add the missing Status label on the
// Donations board) — otherwise the replay just dead-letters again.
//
// Usage (from funraise-sync/):
//   FUNRAISE_WEBHOOK_SECRET=... node scripts/redrive-failed.mjs \
//     --worker-url https://svbc-funraise-sync.<subdomain>.workers.dev \
//     [--env sandbox]               read the sandbox D1 (svbc-funraise-sync-sandbox) instead
//     [--status failed]             which rows (default failed; failed,received adds stranded rows)
//     [--older-than-min 60]         skip rows received in the last N minutes — the consumer may
//                                   still be retrying them (the backoff spans ~21 minutes)
//     [--pause-ms 2000]             wait between deliveries (the consumer runs one at a time)
//     [--dry-run]                   print the plan and exit
//
// The secret is sent in the X-Webhook-Secret header, never the URL. D1 is read with
// `wrangler d1 execute --remote` using the local wrangler login.

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRedrive, selectFailedSql } from './redrive-failed-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argIdx = (name) => process.argv.indexOf(name);
const argValue = (name, dflt) => (argIdx(name) >= 0 ? process.argv[argIdx(name) + 1] : dflt);
const flag = (name) => argIdx(name) >= 0;

const secret = process.env.FUNRAISE_WEBHOOK_SECRET;
const workerUrl = argValue('--worker-url', null);
const dryRun = flag('--dry-run');
if (!dryRun && (!secret || !workerUrl)) {
  console.error('redrive-failed: FUNRAISE_WEBHOOK_SECRET and --worker-url are required (or pass --dry-run)');
  process.exit(1);
}
const wranglerEnv = argValue('--env', null);
const database = wranglerEnv === 'sandbox' ? 'svbc-funraise-sync-sandbox' : 'svbc-funraise-sync';
const statuses = argValue('--status', 'failed').split(',').map((s) => s.trim()).filter(Boolean);
const olderThanMin = Number(argValue('--older-than-min', 60));
const pauseMs = Number(argValue('--pause-ms', 2000));
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function d1Rows(sql) {
  const args = ['wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql];
  if (wranglerEnv) args.push('--env', wranglerEnv);
  const out = execFileSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: join(HERE, '..') });
  return JSON.parse(out)[0].results;
}

const cutoff = new Date(Date.now() - olderThanMin * 60_000).toISOString();
const rows = d1Rows(selectFailedSql(statuses, cutoff));
const { deliveries, unreplayable } = planRedrive(rows);
log(`${rows.length} row(s) with status ${statuses.join('/')} received before ${cutoff} in ${database}: ${deliveries.length} replayable, ${unreplayable.length} not`);
for (const u of unreplayable) log(`  cannot replay ${u.entityId}: ${u.reason} — recover it from Funraise by hand`);
for (const d of deliveries) log(`  ${d.entityId}: ${d.error ?? '(no recorded error)'}`);
if (dryRun || deliveries.length === 0) process.exit(0);

const url = `${workerUrl.replace(/\/$/, '')}/webhooks/funraise/transaction`;
let ok = 0;
let failed = 0;
for (const d of deliveries) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret },
    body: JSON.stringify(d.envelope),
  });
  const body = await res.text();
  if (res.ok && !body.includes('"duplicate":true')) {
    ok++;
    log(`re-enqueued ${d.entityId}`);
  } else {
    failed++;
    log(`NOT re-enqueued ${d.entityId}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  await sleep(pauseMs);
}
log(`done: ${ok} re-enqueued, ${failed} not. Re-run with --dry-run in ~30 minutes to confirm nothing is left.`);
process.exit(failed > 0 ? 1 : 0);
