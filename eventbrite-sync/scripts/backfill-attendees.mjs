#!/usr/bin/env node
// Feeds one Eventbrite event and its attendees through the deployed Worker's attendee route as if
// Eventbrite had delivered them — the one-off to seed the Events and Event Registrations boards for an
// event that existed before the attendee webhook, and the re-drive after a dead-letter. Like
// backfill-orders.mjs nothing here writes to D1 or Monday: each delivery is a pointer the
// consumer fetches and writes itself, and adopt-before-create makes a re-run a no-op.
//
// Usage (from eventbrite-sync/):
//   EVENTBRITE_PRIVATE_TOKEN=... EVENTBRITE_WEBHOOK_SECRET=... node scripts/backfill-attendees.mjs \
//     --event-id <eventbrite event id> \
//     --worker-url https://svbc-eventbrite-sync.<subdomain>.workers.dev \
//     [--env sandbox]        read config/sandbox.json's API base; the Worker URL must be a -sandbox Worker
//     [--pause-ms 2000]      wait between deliveries (the consumer runs one at a time)
//     [--dry-run]            list the plan without posting anything
//
// The token only lists the event's attendees (read-only; only ids are kept). The secret goes in
// the X-Webhook-Secret header, never the URL.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAttendeesUrl, parseAttendeesPage, planAttendeeBackfill, readArg, checkTarget, sendDelivery } from './backfill-orders-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argValue = (name, dflt) => readArg(process.argv, name, dflt);

const token = process.env.EVENTBRITE_PRIVATE_TOKEN;
const secret = process.env.EVENTBRITE_WEBHOOK_SECRET;
const eventId = argValue('--event-id', null);
const workerUrl = argValue('--worker-url', null);
const dryRun = process.argv.includes('--dry-run');
const pauseMs = Number(argValue('--pause-ms', 2000));
const wranglerEnv = argValue('--env', null);
if (!token || !eventId) {
  console.error('backfill-attendees: EVENTBRITE_PRIVATE_TOKEN and --event-id are required');
  process.exit(1);
}
if (!dryRun && (!secret || !workerUrl)) {
  console.error('backfill-attendees: EVENTBRITE_WEBHOOK_SECRET and --worker-url are required (or pass --dry-run)');
  process.exit(1);
}
try {
  checkTarget(wranglerEnv, workerUrl);
} catch (err) {
  console.error(`backfill-attendees: ${err.message}`);
  process.exit(1);
}
const configFile = wranglerEnv === 'sandbox' ? 'sandbox.json' : 'svbc.json';
const { eventbrite } = JSON.parse(readFileSync(join(HERE, '..', 'config', configFile), 'utf8'));
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const attendees = [];
let continuation = null;
let pages = 0;
do {
  const res = await fetch(listAttendeesUrl(eventbrite.apiUrl, eventId, { continuation }), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    console.error(`backfill-attendees: listing attendees for event ${eventId} failed with HTTP ${res.status}`);
    process.exit(1);
  }
  const page = parseAttendeesPage(await res.json());
  attendees.push(...page.attendees);
  continuation = page.continuation;
  pages++;
} while (continuation !== null);

const { deliveries, skipped } = planAttendeeBackfill(attendees, { apiUrl: eventbrite.apiUrl, eventId });
log(`event ${eventId}: ${attendees.length} attendee(s) over ${pages} page(s) — ${deliveries.length} delivery(ies) incl. the event, ${skipped.length} skipped`);
for (const s of skipped) log(`  skip ${s.attendeeId}: ${s.reason}`);
for (const d of deliveries) log(`  ${d.label}: ${d.delivery.config.action} ${d.delivery.api_url}`);
if (dryRun) process.exit(0);

const url = `${workerUrl.replace(/\/$/, '')}/webhooks/eventbrite/attendee`;
let ok = 0;
let failed = 0;
for (const d of deliveries) {
  const res = await sendDelivery(fetch, url, secret, d.delivery);
  if (res.ok) {
    ok++;
    log(`enqueued ${d.label}`);
  } else {
    failed++;
    log(`NOT enqueued ${d.label}: HTTP ${res.status} ${res.body.slice(0, 200)}`);
  }
  await sleep(pauseMs);
}
log(`done: ${ok} enqueued, ${failed} not. Check the Events and Event Registrations boards in ~30 minutes.`);
process.exit(failed > 0 ? 1 : 0);
