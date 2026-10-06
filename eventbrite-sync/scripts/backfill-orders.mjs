#!/usr/bin/env node
// Feeds one Eventbrite event's orders through the deployed Worker as if Eventbrite had delivered
// them — the one-off export for Bike Summit 2026 (ticket sales ran through the 2026-10-09
// cutover, before this Worker's webhook existed), and the re-drive after a dead-letter. Nothing
// here writes to D1 or Monday directly: each order is POSTed to the webhook route as the
// documented delivery shape, so the consumer fetches it from Eventbrite and writes it exactly as
// it would a live one, and adopt-before-create (the Eventbrite Order ID column) makes a re-run
// a no-op. Fix the cause of a dead-letter first (the missing column, the Refunded label).
//
// Usage (from eventbrite-sync/):
//   EVENTBRITE_PRIVATE_TOKEN=... EVENTBRITE_WEBHOOK_SECRET=... node scripts/backfill-orders.mjs \
//     --event-id <eventbrite event id> \
//     --worker-url https://svbc-eventbrite-sync.<subdomain>.workers.dev \
//     [--env sandbox]                  read config/sandbox.json's API base instead of svbc.json's
//     [--changed-since 2026-10-09T00:00:00Z]   only orders changed on or after this time
//     [--pause-ms 2000]                wait between deliveries (the consumer runs one at a time)
//     [--dry-run]                      list the plan without posting anything
//
// The token is used only to list the event's orders (read-only); the secret goes in the
// X-Webhook-Secret header, never the URL. The event id is on the event's Eventbrite manage page
// URL (…/myevent?eid=<id>) or via GET /v3/organizations/{org}/events/.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOrdersUrl, parseOrdersPage, planBackfill } from './backfill-orders-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argIdx = (name) => process.argv.indexOf(name);
const argValue = (name, dflt) => (argIdx(name) >= 0 ? process.argv[argIdx(name) + 1] : dflt);
const flag = (name) => argIdx(name) >= 0;

const token = process.env.EVENTBRITE_PRIVATE_TOKEN;
const secret = process.env.EVENTBRITE_WEBHOOK_SECRET;
const eventId = argValue('--event-id', null);
const workerUrl = argValue('--worker-url', null);
const dryRun = flag('--dry-run');
const changedSince = argValue('--changed-since', null);
const pauseMs = Number(argValue('--pause-ms', 2000));
const wranglerEnv = argValue('--env', null);
if (!token || !eventId) {
  console.error('backfill-orders: EVENTBRITE_PRIVATE_TOKEN and --event-id are required');
  process.exit(1);
}
if (!dryRun && (!secret || !workerUrl)) {
  console.error('backfill-orders: EVENTBRITE_WEBHOOK_SECRET and --worker-url are required (or pass --dry-run)');
  process.exit(1);
}
const configFile = wranglerEnv === 'sandbox' ? 'sandbox.json' : 'svbc.json';
const { eventbrite } = JSON.parse(readFileSync(join(HERE, '..', 'config', configFile), 'utf8'));
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// List every page. Read-only against Eventbrite; nothing personal is printed (ids and statuses).
const orders = [];
let continuation = null;
let pages = 0;
do {
  const res = await fetch(listOrdersUrl(eventbrite.apiUrl, eventId, { continuation, changedSince }), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    console.error(`backfill-orders: listing orders for event ${eventId} failed with HTTP ${res.status}`);
    process.exit(1);
  }
  const page = parseOrdersPage(await res.json());
  orders.push(...page.orders);
  continuation = page.continuation;
  pages++;
} while (continuation !== null);

const { deliveries, skipped } = planBackfill(orders, { apiUrl: eventbrite.apiUrl });
log(`event ${eventId}: ${orders.length} order(s) over ${pages} page(s) — ${deliveries.length} to deliver, ${skipped.length} not giving`);
for (const s of skipped) log(`  skip ${s.orderId}: ${s.reason}`);
for (const d of deliveries) log(`  ${d.orderId}: ${d.status}`);
if (dryRun || deliveries.length === 0) process.exit(0);

const url = `${workerUrl.replace(/\/$/, '')}/webhooks/eventbrite/order`;
let ok = 0;
let failed = 0;
for (const d of deliveries) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret },
    body: JSON.stringify(d.delivery),
  });
  const body = await res.text();
  if (res.ok && body.includes('"ok":true') && !body.includes('"ignored"')) {
    ok++;
    log(`enqueued ${d.orderId}`);
  } else {
    failed++;
    log(`NOT enqueued ${d.orderId}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  await sleep(pauseMs);
}
log(`done: ${ok} enqueued, ${failed} not. Check the Donations board and \`select order_id, status, error from orders where event_id = '${eventId}'\` on the Worker's D1 in ~30 minutes.`);
process.exit(failed > 0 ? 1 : 0);
