#!/usr/bin/env node
// Adds what staff promote needs to both People boards: the Promote to People and Promoted On
// columns, the status labels, and the webhook on the status column. They go on both boards in one
// run because a column on only one stops every pass (the column check). Safe to re-run. Then re-run
// scripts/mark-read-only-columns.mjs to mark Promoted On.
//
// It runs twice, around the deploy. The new build aborts every pass until the columns exist, and
// Monday won't register a webhook until the URL answers its challenge, which needs the new build:
//   1. MONDAY_API_TOKEN=... node scripts/setup-promote.mjs --config config/<env>.json
//   2. wrangler secret put PROMOTE_WEBHOOK_SECRET, then deploy
//   3. MONDAY_API_TOKEN=... MONDAY_AUTH_URL=https://svbc-monday-auth[-sandbox].svbc-account.workers.dev \
//        START_KEY=... WEBHOOK_SECRET=... node scripts/setup-promote.mjs \
//        --config config/<env>.json --worker-url https://<worker>.workers.dev [--replace-webhooks]
//
// WEBHOOK_SECRET must match the Worker's PROMOTE_WEBHOOK_SECRET. MONDAY_API_TOKEN reads the boards
// and creates the columns. With MONDAY_AUTH_URL and START_KEY the webhook goes through the
// monday-auth broker, so the Staff sync app owns it and Monday signs its deliveries (GL#110; needs
// WEBHOOKS_ENABLED on the broker for that deploy). Without them it is made with MONDAY_API_TOKEN
// and arrives unsigned. --replace-webhooks first deletes the existing webhook on the Promote
// column, to move a personal-token subscription over to the app.

import { readFileSync } from 'node:fs';
import { MondayGraphQL } from '../src/monday/graphql.ts';
import { bareTitle } from '../../scripts/lib/column-titles.mjs';
import { webhooksFromEnv } from '../../scripts/lib/broker-webhooks.mjs';
import { planPromoteSetup } from './setup-promote-lib.mjs';

const argOf = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const token = process.env.MONDAY_API_TOKEN;
const secret = process.env.WEBHOOK_SECRET;
const configPath = argOf('--config');
const workerUrl = argOf('--worker-url');
const replace = process.argv.includes('--replace-webhooks');
if (!token || !configPath || (workerUrl !== null && !secret) || (replace && workerUrl === null)) {
  console.error('usage: MONDAY_API_TOKEN=... [MONDAY_AUTH_URL=... START_KEY=...] [WEBHOOK_SECRET=...] node scripts/setup-promote.mjs --config config/<env>.json [--worker-url <url> [--replace-webhooks]]');
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const { promoteStatus, promotedOn } = config.peopleColumns;
const { requestLabel, doneLabel, failedLabel } = config.promote;
const boardIds = [config.boards.live.boardId, config.boards.historical.boardId].map(String);

const monday = new MondayGraphQL(config.monday.apiUrl, token);
// Mutations create things, so a failure that may have committed mustn't be retried into a duplicate.
const graphql = (query, variables) => monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
const chosen = webhooksFromEnv(process.env, graphql, { log: (m) => console.error(m) });
if (chosen.error) {
  console.error(chosen.error);
  process.exit(1);
}
const { webhooks } = chosen;

async function readBoards() {
  const { boards } = await graphql('query ($ids: [ID!]) { boards(ids: $ids) { id columns { id title } } }', { ids: boardIds });
  return Promise.all(boards.map(async (board) => ({ ...board, webhooks: await webhooks.list(board.id) })));
}

const promoteColumnId = (board) => board.columns.find((c) => bareTitle(c.title) === bareTitle(promoteStatus))?.id;

if (replace) {
  for (const board of await readBoards()) {
    const columnId = promoteColumnId(board);
    if (columnId === undefined) continue;
    // Same match as planPromoteSetup: Monday returns config as {"columnId" => "color_x"}.
    for (const w of board.webhooks.filter((w) => w.event === 'change_specific_column_value' && (w.config ?? '').includes(`"${columnId}"`))) {
      await webhooks.remove(w.id);
      console.log(`board ${board.id}: deleted webhook ${w.id} on column ${columnId}`);
    }
  }
}

const plan = planPromoteSetup(await readBoards(), promoteStatus, promotedOn, { webhooks: workerUrl !== null });
// Keyed 0..2: Monday shows label id 5's text for an empty status cell, so a real label stays off it.
const defaults = JSON.stringify({ labels: { 0: requestLabel, 1: doneLabel, 2: failedLabel } });
for (const { boardId, title, type } of plan.createColumns) {
  await graphql(
    `mutation ($boardId: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
      create_column(board_id: $boardId, title: $title, column_type: $type, defaults: $defaults) { id }
    }`,
    { boardId, title, type, defaults: type === 'status' ? defaults : null },
  );
  console.log(`board ${boardId}: created column "${title}"`);
}
if (plan.createWebhooks.length > 0) {
  const url = `${workerUrl.replace(/\/$/, '')}/webhooks/monday/promote?secret=${encodeURIComponent(secret)}`;
  const boards = await readBoards();
  for (const boardId of plan.createWebhooks) {
    const columnId = promoteColumnId(boards.find((b) => b.id === boardId));
    await webhooks.create({ board: boardId, url, event: 'change_specific_column_value', config: { columnId } });
    console.log(`board ${boardId}: subscribed the webhook on column ${columnId}${chosen.via === 'broker' ? ' as the Staff sync app' : ' with MONDAY_API_TOKEN (unsigned)'}`);
  }
}
if (plan.createColumns.length === 0 && plan.createWebhooks.length === 0) console.log('nothing to do');
if (workerUrl === null) console.log('columns only: no webhook subscribed. Deploy, then re-run with --worker-url.');
