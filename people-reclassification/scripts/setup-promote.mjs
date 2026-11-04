#!/usr/bin/env node
// Adds what staff promote needs to both People boards: the Promote to People and Promoted On
// columns, the status labels, and the webhook on the status column. They go on both boards in one
// run because a column on only one stops every pass (the column check). Safe to re-run. Then re-run
// scripts/mark-read-only-columns.mjs to mark Promoted On.
//
// Usage:
//   MONDAY_API_TOKEN=... WEBHOOK_SECRET=... node scripts/setup-promote.mjs \
//     --config config/<env>.json --worker-url https://<worker>.workers.dev
//
// WEBHOOK_SECRET must match the Worker's PROMOTE_WEBHOOK_SECRET.

import { readFileSync } from 'node:fs';
import { MondayGraphQL } from '../src/monday/graphql.ts';
import { bareTitle } from '../../scripts/lib/column-titles.mjs';
import { planPromoteSetup } from './setup-promote-lib.mjs';

const argOf = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const token = process.env.MONDAY_API_TOKEN;
const secret = process.env.WEBHOOK_SECRET;
const configPath = argOf('--config');
const workerUrl = argOf('--worker-url');
if (!token || !secret || !configPath || !workerUrl) {
  console.error('usage: MONDAY_API_TOKEN=... WEBHOOK_SECRET=... node scripts/setup-promote.mjs --config config/<env>.json --worker-url <url>');
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const { promoteStatus, promotedOn } = config.peopleColumns;
const { requestLabel, doneLabel, failedLabel } = config.promote;
const boardIds = [config.boards.live.boardId, config.boards.historical.boardId].map(String);
const url = `${workerUrl.replace(/\/$/, '')}/webhooks/monday/promote?secret=${encodeURIComponent(secret)}`;

const monday = new MondayGraphQL(config.monday.apiUrl, token);
// Mutations create things, so a failure that may have committed mustn't be retried into a duplicate.
const graphql = (query, variables) => monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });

async function readBoards() {
  const { boards } = await graphql('query ($ids: [ID!]) { boards(ids: $ids) { id columns { id title } } }', { ids: boardIds });
  return Promise.all(boards.map(async (board) => {
    const { webhooks } = await graphql('query ($id: ID!) { webhooks(board_id: $id) { event config } }', { id: board.id });
    return { ...board, webhooks };
  }));
}

const plan = planPromoteSetup(await readBoards(), promoteStatus, promotedOn);
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
  const boards = await readBoards();
  for (const boardId of plan.createWebhooks) {
    const column = boards.find((b) => b.id === boardId).columns.find((c) => bareTitle(c.title) === bareTitle(promoteStatus));
    await graphql(
      `mutation ($boardId: ID!, $url: String!, $config: JSON!) {
        create_webhook(board_id: $boardId, url: $url, event: change_specific_column_value, config: $config) { id }
      }`,
      { boardId, url, config: JSON.stringify({ columnId: column.id }) },
    );
    console.log(`board ${boardId}: subscribed the webhook on column ${column.id}`);
  }
}
if (plan.createColumns.length === 0 && plan.createWebhooks.length === 0) console.log('nothing to do');
