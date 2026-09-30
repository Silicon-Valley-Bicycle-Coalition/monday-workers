#!/usr/bin/env node
// Subscribes this Worker's webhook pair (create_item + change_column_value) on every board in
// config.donationRollups.donationBoards, and optionally deletes ALL webhooks from boards being
// retired. Monday webhooks are board-scoped, so any board change (sandbox rebuild, production
// cutover, a board added later) needs this re-run. The shared secret rides in the URL query
// (?secret=...) and must match the Worker's MONDAY_WEBHOOK_SECRET.
//
// Usage:
//   MONDAY_API_TOKEN=... WEBHOOK_SECRET=... node scripts/setup-webhooks.mjs \
//     --worker-url https://svbc-donation-rollups.svbc-account.workers.dev \
//     [--config config/sandbox.json]   # which config's donationBoards to subscribe (default config/svbc.json)
//     [--prune 111,222,333]        # delete every webhook on these board ids first
//
// Re-running without `--prune` leaves any existing subscription for another Worker URL in
// place — the skip check keys on event type, not URL. Pass `--prune <boardId>` when moving
// the webhook to a different deployment.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MondayGraphQL } from '../src/monday/graphql.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const token = process.env.MONDAY_API_TOKEN;
const secret = process.env.WEBHOOK_SECRET;
if (!token || !secret) {
  console.error('setup-webhooks: MONDAY_API_TOKEN and WEBHOOK_SECRET are required');
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

// The Worker's own copy of the canonical Monday transport (#35): retries rate limits and Monday
// blips, times out hung requests, and never blindly re-runs a create. Imported as TypeScript —
// needs a Node with built-in type stripping (22.18+ / 23.6+).
const monday = new MondayGraphQL(config.monday.apiUrl, token);

// Mutations here create boards, columns and webhooks, so a failure that may have committed throws
// AmbiguousWriteError instead of being retried into a duplicate; queries get the full retry.
async function graphql(query, variables) {
  return monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
}

for (const boardId of prune) {
  const data = await graphql('query ($id: ID!) { webhooks (board_id: $id) { id event } }', { id: boardId });
  for (const w of data.webhooks ?? []) {
    await graphql('mutation ($id: ID!) { delete_webhook (id: $id) { id } }', { id: w.id });
    console.error(`setup-webhooks: deleted webhook ${w.id} (${w.event}) from board ${boardId}`);
  }
}

for (const board of config.donationRollups.donationBoards) {
  const existing = await graphql(
    'query ($id: ID!) { webhooks (board_id: $id) { id event } }', { id: String(board.boardId) });
  const have = new Set((existing.webhooks ?? []).map((w) => w.event));
  // item_deleted / item_archived / item_restored (issue #26): a deleted gift must leave its owner's
  // totals, and a restored one come back. Re-running this script on boards already subscribed to
  // the first two adds only the missing three.
  for (const event of ['create_item', 'change_column_value', 'item_deleted', 'item_archived', 'item_restored']) {
    if (have.has(event)) {
      console.error(`setup-webhooks: board ${board.boardId} already has ${event} — skipping`);
      continue;
    }
    // The subscription handshake POSTs a challenge to the URL, so the Worker must already
    // be deployed with the matching secret before this runs.
    const created = await graphql(
      `mutation ($board: ID!, $url: String!, $event: WebhookEventType!) {
         create_webhook (board_id: $board, url: $url, event: $event) { id } }`,
      { board: String(board.boardId), url, event });
    console.error(`setup-webhooks: board ${board.boardId} subscribed ${event} → webhook ${created.create_webhook.id}`);
  }
}
console.error('setup-webhooks: done');
