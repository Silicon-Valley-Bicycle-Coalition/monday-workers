#!/usr/bin/env node
// Re-drives mailchimp-sync syncs that dead-lettered (GL#37) — pending rows the DLQ consumer
// (src/consumer/deadLetters.ts) stamped "dead-lettered after retries: …". Modelled on
// funraise-sync's scripts/redrive-failed.mjs: nothing here writes to D1, Monday, or Mailchimp
// directly. Each row is POSTed back to the deployed Worker as a minimal webhook delivery on its
// normal route, which resets the row to 'received' and enqueues it; the consumer then re-reads
// the Donor (outbound) or the Mailchimp member (inbound) and writes exactly as it would for a
// real delivery. Fix the cause first — a rejected MAILCHIMP_API_KEY, a Monday outage — or the
// replay just dead-letters again.
//
// DRY RUN BY DEFAULT: prints the plan and exits. Pass --apply to send.
//
// Usage (from mailchimp-sync/):
//   node scripts/redrive-dead-lettered.mjs
//     [--env sandbox]                  read the sandbox D1 (svbc-mailchimp-sync-sandbox) instead
//     [--direction outbound|inbound|both]  default both
//     [--since 2026-09-01]             received_at >= (YYYY-MM-DD or ISO UTC timestamp)
//     [--until 2026-09-25]             received_at <
//     [--item 123,456]                 only these Monday Donor item ids (outbound) /
//                                      Mailchimp member ids — the subscriber hash (inbound)
//     [--pause-ms 2000]                wait between deliveries (the consumers run one at a time)
//     [--apply --worker-url https://svbc-mailchimp-sync[-sandbox].<subdomain>.workers.dev]
//
// --apply needs the route's shared secret for each direction it sends, from the environment:
// MONDAY_WEBHOOK_SECRET (outbound) and MAILCHIMP_WEBHOOK_SECRET (inbound) — the values set with
// `wrangler secret put` for the same --env. Both routes only accept the secret as ?secret=, so it
// is in the request URL (as on every real delivery); this script never prints that URL. Output
// names Donor item ids and Mailchimp member ids, never email addresses. D1 is read with
// `wrangler d1 execute --remote` using the local wrangler login.

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { directionInfo, parseBound, parseDirections, planRedrive, redactEmails, redriveUrl, selectDeadLetteredSql } from './redrive-dead-lettered-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argIdx = (name) => process.argv.indexOf(name);
const argValue = (name, dflt) => (argIdx(name) >= 0 ? process.argv[argIdx(name) + 1] : dflt);
const flag = (name) => argIdx(name) >= 0;
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const apply = flag('--apply');
const workerUrl = argValue('--worker-url', null);
const wranglerEnv = argValue('--env', null);
if (wranglerEnv !== null && wranglerEnv !== 'sandbox') {
  console.error('redrive-dead-lettered: --env must be "sandbox" or omitted (production)');
  process.exit(1);
}
const database = wranglerEnv === 'sandbox' ? 'svbc-mailchimp-sync-sandbox' : 'svbc-mailchimp-sync';
const directions = parseDirections(argValue('--direction', undefined));
const since = parseBound(argValue('--since', undefined));
const until = parseBound(argValue('--until', undefined));
const ids = (argValue('--item', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const pauseMs = Number(argValue('--pause-ms', 2000));

if (apply) {
  const missing = [];
  if (!workerUrl) missing.push('--worker-url');
  for (const d of directions) if (!process.env[directionInfo(d).secretEnv]) missing.push(directionInfo(d).secretEnv);
  if (missing.length > 0) {
    console.error(`redrive-dead-lettered: --apply needs ${missing.join(', ')} (or drop --apply for a dry run)`);
    process.exit(1);
  }
}

function d1Rows(sql) {
  const args = ['wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql];
  if (wranglerEnv) args.push('--env', wranglerEnv);
  const out = execFileSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: join(HERE, '..') });
  return JSON.parse(out)[0].results;
}

const deliveries = [];
for (const direction of directions) {
  const rows = d1Rows(selectDeadLetteredSql(direction, { since, until }));
  const planned = planRedrive(direction, rows, { ids });
  log(`${direction}: ${rows.length} dead-lettered row(s) in ${database}${since ? ` since ${since}` : ''}${until ? ` until ${until}` : ''}; ${planned.length} planned`);
  for (const d of planned) log(`  ${direction} ${d.id} (received ${d.receivedAt}): ${redactEmails(d.error) ?? '(no recorded error)'}`);
  deliveries.push(...planned);
}
if (!apply || deliveries.length === 0) {
  if (!apply) log('dry run — nothing sent. Re-run with --apply --worker-url … to re-enqueue.');
  process.exit(0);
}

let ok = 0;
let failed = 0;
for (const d of deliveries) {
  const secret = process.env[directionInfo(d.direction).secretEnv];
  let result;
  try {
    const res = await fetch(redriveUrl(workerUrl, d.path, secret), {
      method: 'POST',
      headers: { 'Content-Type': d.contentType },
      body: d.body,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    result = res.ok && json?.ok === true && !json.skipped ? null : `HTTP ${res.status} ${redactEmails(text.slice(0, 200))}`;
  } catch (err) {
    result = err instanceof Error ? err.message : String(err);
  }
  if (result === null) {
    ok++;
    log(`re-enqueued ${d.direction} ${d.id}`);
  } else {
    failed++;
    log(`NOT re-enqueued ${d.direction} ${d.id}: ${result}`);
  }
  await sleep(pauseMs);
}
log(`done: ${ok} re-enqueued, ${failed} not. Re-run without --apply in ~30 minutes (the retry backoff spans ~21) to confirm nothing dead-lettered again.`);
process.exit(failed > 0 ? 1 : 0);
