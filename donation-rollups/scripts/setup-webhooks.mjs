#!/usr/bin/env node
// Subscribes this Worker's webhooks on every board it watches: the Donations boards in
// config.donationRollups.donationBoards, the Event Registrations boards, and the Affiliations board
// once employer sync is on. Optionally deletes ALL webhooks from boards being retired first.
// Monday webhooks are board-scoped, so any board change (sandbox rebuild, production cutover, a
// board added later) needs this re-run. The shared secret rides in the URL query (?secret=...)
// and must match the Worker's MONDAY_WEBHOOK_SECRET.
//
// Usage, preferred (GL#110): through the monday-auth broker, so the Staff sync app owns the webhooks
// and Monday signs every delivery with its Signing Secret. Needs WEBHOOKS_ENABLED on the broker
// for that deploy (monday-auth/README.md "Re-registering webhooks"):
//   MONDAY_AUTH_URL=https://svbc-monday-auth.svbc-account.workers.dev START_KEY=... WEBHOOK_SECRET=... \
//     node scripts/setup-webhooks.mjs --worker-url https://svbc-donation-rollups.svbc-account.workers.dev \
//     [--config config/sandbox.json]   # which config's boards to subscribe (default config/svbc.json)
//     [--prune 111,222,333]           # delete every webhook on these board ids first
//
// Legacy: MONDAY_API_TOKEN=... in place of MONDAY_AUTH_URL/START_KEY subscribes with that personal
// token, and those deliveries arrive unsigned.
//
// Re-running without `--prune` leaves any existing subscription in place, including one for
// another Worker URL or one made with a personal token: the skip check keys on event type, not
// URL or owner. To move to app-owned webhooks, `--prune` every board this script subscribes.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MondayGraphQL } from '../src/monday/graphql.ts';
import { webhooksFromEnv } from '../../scripts/lib/broker-webhooks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const secret = process.env.WEBHOOK_SECRET;
if (!secret) {
  console.error('setup-webhooks: WEBHOOK_SECRET is required');
  process.exit(1);
}
const argIdx = (name) => process.argv.indexOf(name);
const workerUrl = argIdx('--worker-url') >= 0 ? process.argv[argIdx('--worker-url') + 1] : null;
if (!workerUrl) {
  console.error('setup-webhooks: --worker-url is required');
  process.exit(1);
}
const prune = argIdx('--prune') >= 0 ? process.argv[argIdx('--prune') + 1].split(',') : [];

const configPath = argIdx('--config') >= 0 ? process.argv[argIdx('--config') + 1] : join(HERE, '..', 'config', 'svbc.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const url = `${workerUrl.replace(/\/$/, '')}/webhooks/monday/donations?secret=${encodeURIComponent(secret)}`;

// The Worker's own copy of the canonical Monday transport (GL#35), for the legacy token path:
// retries rate limits and Monday blips, times out hung requests, and never blindly re-runs a
// create. Imported as TypeScript — needs a Node with built-in type stripping (22.18+ / 23.6+).
let graphql = null;
if (process.env.MONDAY_API_TOKEN && !process.env.MONDAY_AUTH_URL) {
  const monday = new MondayGraphQL(config.monday.apiUrl, process.env.MONDAY_API_TOKEN);
  graphql = (query, variables) => monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
}
const chosen = webhooksFromEnv(process.env, graphql, { log: (m) => console.error(`setup-webhooks: ${m}`) });
if (chosen.error) {
  console.error(`setup-webhooks: ${chosen.error}`);
  process.exit(1);
}
const { webhooks } = chosen;
console.error(`setup-webhooks: subscribing ${chosen.via === 'broker' ? 'as the Staff sync app (signed deliveries)' : 'with MONDAY_API_TOKEN (unsigned deliveries)'}`);

for (const boardId of prune) {
  for (const w of await webhooks.list(boardId)) {
    await webhooks.remove(w.id);
    console.error(`setup-webhooks: deleted webhook ${w.id} (${w.event}) from board ${boardId}`);
  }
}

// Subscribes each missing event on one board. The subscription handshake POSTs a challenge to the
// URL, so the Worker must already be deployed with the matching secret before this runs.
async function ensure(label, boardId, events) {
  const have = new Set((await webhooks.list(boardId)).map((w) => w.event));
  for (const event of events) {
    if (have.has(event)) {
      console.error(`setup-webhooks: ${label} ${boardId} already has ${event} — skipping`);
      continue;
    }
    const created = await webhooks.create({ board: boardId, url, event });
    console.error(`setup-webhooks: ${label} ${boardId} subscribed ${event} → webhook ${created.id}`);
  }
}

// item_deleted / item_archived / item_restored (issue GL#26): a deleted gift must leave its owner's
// totals, and a restored one come back.
for (const board of config.donationRollups.donationBoards) {
  await ensure('board', String(board.boardId), ['create_item', 'change_column_value', 'item_deleted', 'item_archived', 'item_restored']);
}

// Event Registrations boards (membership activity rule, spec 2026-10-09): a check-in, an
// Attendee re-point, a deletion or a restore must reach the consumer — a restored registration
// is re-read so it counts again. No item_archived: an archived registration keeps its last read.
for (const board of config.donationRollups.volunteerBoards ?? []) {
  await ensure('registrations board', String(board.boardId), ['create_item', 'change_column_value', 'item_deleted', 'item_restored']);
}

// Affiliations board, once employer sync is configured: a new item or a column change re-derives
// the person's Employer Name. The route ignores every column but Person, Organization, Status and
// Primary, which covers the attributed totals this Worker writes here. No deletion events: removing
// an affiliation leaves Employer Name as it was.
if (config.affiliations?.employerSync) {
  await ensure('affiliations board', String(config.affiliations.boardId), ['create_item', 'change_column_value']);
}

console.error('setup-webhooks: done');
