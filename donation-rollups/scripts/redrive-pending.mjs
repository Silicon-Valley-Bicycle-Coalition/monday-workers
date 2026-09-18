#!/usr/bin/env node
// Re-drives recomputes for pending_recomputes rows the queue never finished — status 'queued'
// or 'received' with no write (queue messages that expired unconsumed, see README "Status and
// verification" §1), or 'failed'. It POSTs one synthetic webhook per distinct owner to the
// deployed Worker, so the pending row, queue message, recompute, and status update all happen
// on the same path a real Monday event takes; nothing here writes to D1 or Monday directly.
// Rows whose owner D1 doesn't know are sent individually and the Worker resolves them.
//
// Sends in chunks (a 5-owner canary first), waits for each chunk to settle in D1, aborts if a
// chunk's failure rate passes 20 % or nothing settles for 10 minutes. Progress lives in --state
// so an interrupted run resumes where it stopped (in-flight messages are waited on, not re-sent).
//
// First used 2026-09-17 to drain the 2,865 rows from the 09-03/09-09 floods: 1,363 messages for
// 1,349 owners + 14 unlinked rows, 0 failures, ~50 owners per 4 minutes at max_concurrency 1.
//
// Usage:
//   MONDAY_WEBHOOK_SECRET=... node scripts/redrive-pending.mjs \
//     --worker-url https://svbc-donation-rollups.svbc-account.workers.dev \
//     [--status queued,received]      which rows to re-drive (default queued,received; add failed to retry those)
//     [--older-than-min 60]           skip rows received in the last N minutes — the consumer may still own them
//     [--size 50] [--budget-min 480]  chunk size; stop starting new chunks after this long (re-run to continue)
//     [--dry-run]                     print the plan and exit
//     [--bookkeep]                    once everything has settled, run scripts/redrive-pending-bookkeeping.sql
//                                     with this run's start time, marking each recomputed owner's other rows written
//     [--database svbc-donation-rollups] [--state ./redrive-pending-state.json]
//
// D1 is read through `wrangler d1 execute --remote` with the local wrangler OAuth login, which
// goes stale roughly hourly; a failed query triggers `wrangler whoami` (which refreshes it) and
// one retry.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { planRedrive, chunkPlan, renderBookkeepingSql } from './redrive-pending-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argIdx = (name) => process.argv.indexOf(name);
const argValue = (name, dflt) => (argIdx(name) >= 0 ? process.argv[argIdx(name) + 1] : dflt);
const argNumber = (name, dflt) => Number(argValue(name, dflt));
const flag = (name) => argIdx(name) >= 0;

const secret = process.env.MONDAY_WEBHOOK_SECRET;
const workerUrl = argValue('--worker-url', null);
if (!secret || !workerUrl) {
  console.error('redrive-pending: MONDAY_WEBHOOK_SECRET and --worker-url are required');
  process.exit(1);
}
const statuses = argValue('--status', 'queued,received').split(',').map((s) => s.trim()).filter(Boolean);
const olderThanMin = argNumber('--older-than-min', 60);
const size = argNumber('--size', 50);
const budgetMs = argNumber('--budget-min', 480) * 60_000;
const database = argValue('--database', 'svbc-donation-rollups');
const statePath = argValue('--state', join(process.cwd(), 'redrive-pending-state.json'));
const dryRun = flag('--dry-run');
const bookkeep = flag('--bookkeep');

const url = `${workerUrl.replace(/\/$/, '')}/webhooks/monday/donations?secret=${encodeURIComponent(secret)}`;
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sqlList = (ids) => ids.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');

function d1(sql) {
  const run = () => {
    const out = execFileSync('npx', ['wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: join(HERE, '..') });
    return JSON.parse(out);
  };
  try { return run(); } catch (err) {
    log(`d1 query failed, refreshing the wrangler login and retrying once: ${String(err.stderr ?? err).slice(0, 200)}`);
    try { execFileSync('npx', ['wrangler', 'whoami'], { stdio: 'ignore', cwd: join(HERE, '..') }); } catch { /* the retry decides */ }
    return run();
  }
}
const d1Rows = (sql) => d1(sql)[0].results;

// --- plan ---------------------------------------------------------------------------------
const cutoff = new Date(Date.now() - olderThanMin * 60_000).toISOString();
const rows = d1Rows(
  `SELECT p.donation_item_id, p.donation_board_id, p.received_at, l.owner_item_id, g.owner_item_id AS gift_owner
   FROM pending_recomputes p
   LEFT JOIN donation_links l ON l.donation_item_id = p.donation_item_id
   LEFT JOIN gifts g ON g.monday_item_id = p.donation_item_id
   WHERE p.status IN (${sqlList(statuses)}) AND p.received_at < '${cutoff}'
   ORDER BY p.received_at`);
const plan = planRedrive(rows);
log(`plan: ${plan.rows} rows at [${statuses.join(', ')}] received before ${cutoff} → ${plan.messages.length} messages (${plan.owners} owners + ${plan.unlinked} unlinked)`);
if (plan.messages.length === 0) { log('nothing to re-drive'); process.exit(0); }
if (dryRun) {
  for (const m of plan.messages.slice(0, 10)) log(`  ${m.donationItemId} (board ${m.donationBoardId}) → owner ${m.ownerItemId ?? 'unknown'}`);
  if (plan.messages.length > 10) log(`  … ${plan.messages.length - 10} more`);
  process.exit(0);
}

// --- state --------------------------------------------------------------------------------
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { startedAt: new Date().toISOString(), sent: [], done: [], failed: [] };
const save = () => writeFileSync(statePath, JSON.stringify(state));
save();
const doneSet = new Set(state.done);
const sentSet = new Set(state.sent);
if (state.done.length > 0) log(`resuming: ${state.done.length} done, ${state.sent.length - state.done.length} in flight (state ${statePath}, started ${state.startedAt})`);

// Wait until none of `ids` is received/queued. Returns { written, failed }.
async function settle(ids, label) {
  let lastPending = -1, stallSince = Date.now();
  for (;;) {
    await sleep(20_000);
    const counts = Object.fromEntries(d1Rows(
      `SELECT status, count(*) n FROM pending_recomputes WHERE donation_item_id IN (${sqlList(ids)}) GROUP BY status`,
    ).map((r) => [r.status, r.n]));
    const pending = (counts.received ?? 0) + (counts.queued ?? 0);
    const failed = counts.failed ?? 0;
    if (pending !== lastPending) { lastPending = pending; stallSince = Date.now(); }
    log(`${label}: written=${counts.written ?? 0} failed=${failed} pending=${pending}`);
    if (pending === 0) {
      if (failed > 0) {
        const errs = d1Rows(`SELECT donation_item_id, error FROM pending_recomputes WHERE status='failed' AND donation_item_id IN (${sqlList(ids)}) LIMIT 5`);
        for (const e of errs) log(`  failed ${e.donation_item_id}: ${String(e.error).slice(0, 200)}`);
        state.failed.push(...errs.map((e) => e.donation_item_id));
      }
      return { written: counts.written ?? 0, failed };
    }
    if (Date.now() - stallSince > 10 * 60_000) { log(`ABORT: ${label} stalled for 10 minutes with ${pending} pending`); save(); process.exit(4); }
  }
}
const abortIfBad = (r, n, label) => {
  if (r.failed / n > 0.2) { log(`ABORT: ${label} failure rate ${r.failed}/${n} — fix the cause, then re-run to continue`); save(); process.exit(3); }
};

// --- send ---------------------------------------------------------------------------------
const t0 = Date.now();
const inflight = state.sent.filter((id) => !doneSet.has(id));
if (inflight.length > 0) {
  const r = await settle(inflight, 'in-flight from the previous run');
  state.done.push(...inflight); save();
  abortIfBad(r, inflight.length, 'in-flight');
}
const todo = plan.messages.filter((m) => !doneSet.has(m.donationItemId) && !sentSet.has(m.donationItemId));
const chunks = chunkPlan(todo, size, state.done.length === 0 ? 5 : 0);
for (const [n, chunk] of chunks.entries()) {
  if (Date.now() - t0 > budgetMs) { log(`budget reached; ${todo.length - chunks.slice(0, n).flat().length} messages left — re-run to continue`); process.exit(0); }
  for (const m of chunk) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { type: 'update_column_value', pulseId: Number(m.donationItemId), boardId: Number(m.donationBoardId) } }),
    });
    if (res.status !== 200) { log(`ABORT: webhook POST for ${m.donationItemId} returned ${res.status} ${await res.text()}`); save(); process.exit(2); }
    state.sent.push(m.donationItemId); save();
    await sleep(150);
  }
  const label = `chunk ${n + 1}/${chunks.length}`;
  log(`${label}: posted ${chunk.length} (${state.sent.length}/${plan.messages.length} sent overall)`);
  const r = await settle(chunk.map((m) => m.donationItemId), label);
  state.done.push(...chunk.map((m) => m.donationItemId)); save();
  abortIfBad(r, chunk.length, label);
}
log(`DONE: ${state.done.length} messages settled, ${state.failed.length} failed, this run ${Math.round((Date.now() - t0) / 60000)} min`);

// --- bookkeeping --------------------------------------------------------------------------
if (bookkeep) {
  const sql = renderBookkeepingSql(readFileSync(join(HERE, 'redrive-pending-bookkeeping.sql'), 'utf8'), state.startedAt);
  const results = d1(sql);
  const [links, ledger, counts, leftover] = results;
  log(`bookkeeping: ${links.meta?.changes ?? '?'} rows marked written via donation_links, ${ledger.meta?.changes ?? '?'} via gifts`);
  for (const r of counts.results) log(`  ${r.status}: ${r.n} (oldest ${r.oldest}, newest write ${r.newest_write})`);
  for (const r of leftover.results) log(`  still ${r.status ?? 'pending'}: ${JSON.stringify(r)}`);
} else {
  log(`next: mark each recomputed owner's other rows written — re-run with --bookkeep (uses start time ${state.startedAt}), or apply scripts/redrive-pending-bookkeeping.sql by hand`);
}
