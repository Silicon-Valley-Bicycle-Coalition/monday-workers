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
//     [--prune 111,222,333]        # delete every webhook on these board ids first

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const config = JSON.parse(readFileSync(join(HERE, '..', 'config', 'svbc.json'), 'utf8'));
const url = `${workerUrl.replace(/\/$/, '')}/webhooks/monday/donations?secret=${encodeURIComponent(secret)}`;

async function graphql(query, variables) {
  const res = await fetch(config.monday.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2026-01' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`monday API: HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`monday API: ${json.errors.map((e) => e.message).join('; ')}`);
  return json.data;
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
  for (const event of ['create_item', 'change_column_value']) {
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
