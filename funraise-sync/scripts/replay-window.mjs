#!/usr/bin/env node
// Replays the Funraise deliveries one Worker stored into another, for the cutover handoff
// (svbc-monday-migration#48, docs/23 step 5): after Funraise's webhook moves from the sandbox
// Worker to production, every delivery the sandbox Worker took since the final extract started is
// POSTed to the production Worker, which writes it through the normal path. Adopt-before-create
// updates a gift the import already carried and creates one it didn't, so an overlapping window is
// safe. Nothing here writes to D1 or Monday directly.
//
// Unlike redrive-failed.mjs this selects by time, not by status: the gap's deliveries are
// `written` in the sandbox ledger. It also never replays Funraise's Test-button transaction (id
// -1) and treats a `duplicate` answer as success, so it is safe to re-run.
//
// Usage (from funraise-sync/):
//   FUNRAISE_WEBHOOK_SECRET=<the PRODUCTION Worker's secret> node scripts/replay-window.mjs \
//     --since 2026-10-09T17:30:00.000Z \
//     --worker-url https://svbc-funraise-sync.<subdomain>.workers.dev \
//     [--until 2026-10-10T20:00:00.000Z]   exclusive upper bound (default: no bound)
//     [--source-env sandbox|production]    whose D1 to read (default sandbox)
//     [--pause-ms 2000]                    wait between deliveries (the consumer runs one at a time)
//     [--dry-run]                          print the plan and exit; needs no secret or --worker-url
//
// --since is when the final extract (docs/23 step 3.3) STARTED, not when it finished: a gift
// Funraise took while it ran may or may not be in it, and the overlap is harmless. The source D1
// is read with `wrangler d1 execute --remote` using the local wrangler login. Run the
// subscriptions bootstrap walk first, so replayed installments find their Recurring Gift in the
// ledger instead of fetching it from Funraise.

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRedrive, selectWindowSql, classifyReplayResponse, describeWranglerFailure } from './replay-window-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argIdx = (name) => process.argv.indexOf(name);
const argValue = (name, dflt) => (argIdx(name) >= 0 ? process.argv[argIdx(name) + 1] : dflt);
const flag = (name) => argIdx(name) >= 0;

const secret = process.env.FUNRAISE_WEBHOOK_SECRET;
const workerUrl = argValue('--worker-url', null);
const dryRun = flag('--dry-run');
const since = argValue('--since', null);
const until = argValue('--until', null);
if (since === null) {
  console.error('replay-window: --since <ISO UTC timestamp> is required');
  process.exit(1);
}
if (!dryRun && (!secret || !workerUrl)) {
  console.error('replay-window: FUNRAISE_WEBHOOK_SECRET (the target Worker\'s) and --worker-url are required (or pass --dry-run)');
  process.exit(1);
}
const sourceEnv = argValue('--source-env', 'sandbox');
if (sourceEnv !== 'sandbox' && sourceEnv !== 'production') {
  console.error('replay-window: --source-env must be sandbox or production');
  process.exit(1);
}
const database = sourceEnv === 'sandbox' ? 'svbc-funraise-sync-sandbox' : 'svbc-funraise-sync';
const pauseMs = Number(argValue('--pause-ms', 2000));
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function d1Rows(sql) {
  const args = ['wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql];
  if (sourceEnv === 'sandbox') args.push('--env', 'sandbox');
  try {
    const out = execFileSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: join(HERE, '..') });
    return JSON.parse(out)[0].results;
  } catch (err) {
    console.error(`replay-window: could not read ${database}: ${describeWranglerFailure(err)}`);
    process.exit(1);
  }
}

let sql;
try {
  sql = selectWindowSql(since, until);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const rows = d1Rows(sql);
const { deliveries, unreplayable } = planRedrive(rows);
const byStatus = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
log(
  `${rows.length} transaction(s) received in ${database} from ${since}${until ? ` to ${until}` : ''}: ` +
    `${deliveries.length} replayable, ${unreplayable.length} not (by sandbox status: ${JSON.stringify(byStatus)})`
);
for (const u of unreplayable) log(`  cannot replay ${u.entityId}: ${u.reason} — recover it from Funraise by hand`);
for (const d of deliveries) log(`  ${d.entityId}`);
if (dryRun || deliveries.length === 0) process.exit(unreplayable.length > 0 ? 2 : 0);

const url = `${workerUrl.replace(/\/$/, '')}/webhooks/funraise/transaction`;
const counts = { enqueued: 0, duplicate: 0, failed: 0 };
for (const d of deliveries) {
  let outcome;
  let detail = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret },
      body: JSON.stringify(d.envelope),
    });
    const body = await res.text();
    outcome = classifyReplayResponse(res.status, body);
    detail = `HTTP ${res.status} ${body.slice(0, 200)}`;
  } catch (err) {
    outcome = 'failed';
    detail = `network error: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (outcome === 'auth') {
    log(`STOPPED at ${d.entityId}: the target Worker rejected the secret (${detail}). Nothing further was sent.`);
    process.exit(1);
  }
  counts[outcome]++;
  log(outcome === 'failed' ? `NOT replayed ${d.entityId}: ${detail}` : `${outcome} ${d.entityId}`);
  await sleep(pauseMs);
}
log(
  `done: ${counts.enqueued} enqueued, ${counts.duplicate} already present, ${counts.failed} failed, ` +
    `${unreplayable.length} not replayable. Re-running is safe. Then run the post-repoint window check (docs/23 step 5).`
);
process.exit(counts.failed > 0 ? 1 : unreplayable.length > 0 ? 2 : 0);
