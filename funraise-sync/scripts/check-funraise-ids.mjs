#!/usr/bin/env node
// Post-repoint window check 3 (svbc-monday-migration docs/23 step 5): one Donations item per
// Funraise ID. Read-only: pages through the Donations board with the Monday API and reports any
// Funraise ID carried by more than one item. Run it after a replay (replay-window.mjs) to prove
// the overlap with the final extract adopted rather than doubled.
//
// Usage (from funraise-sync/):
//   MONDAY_API_TOKEN=... node scripts/check-funraise-ids.mjs [--env sandbox] [--board-id <id>] [--column-id <id>]
//
// Board and column come from config/svbc.json (sandbox.json with --env sandbox):
// monday.boards["donations:live"] and funraiseSync.entityIdColumn. Exit 0 = no duplicates,
// 1 = duplicates found (or the read failed), 2 = bad usage/config.
//
// Archived items are not returned by the API's items_page, so a duplicate whose twin was archived
// is not seen here. That is the same blind spot adopt-before-create has, and the reason the
// consumer flags gifts older than oldestActiveFiscalYear instead of creating them.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MondayGraphQL } from '../src/monday/graphql.ts';
import { findDuplicateFunraiseIds } from './check-funraise-ids-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argValue = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const token = process.env.MONDAY_API_TOKEN;
if (!token) {
  console.error('check-funraise-ids: MONDAY_API_TOKEN is required');
  process.exit(2);
}
const wranglerEnv = argValue('--env', null);
if (wranglerEnv !== null && wranglerEnv !== 'sandbox') {
  console.error('check-funraise-ids: --env must be sandbox (or omitted for production)');
  process.exit(2);
}
const config = JSON.parse(readFileSync(join(HERE, '..', 'config', wranglerEnv === 'sandbox' ? 'sandbox.json' : 'svbc.json'), 'utf8'));
const boardId = Number(argValue('--board-id', config.monday.boards['donations:live']));
const columnId = argValue('--column-id', config.funraiseSync.entityIdColumn);
if (!Number.isInteger(boardId) || boardId <= 0 || !columnId || columnId.startsWith('REPLACE_')) {
  console.error('check-funraise-ids: no Donations board id / Funraise ID column in the config; pass --board-id and --column-id');
  process.exit(2);
}

const monday = new MondayGraphQL(config.monday.apiUrl, token);
const PAGE = 'items { id column_values(ids: [$columnId]) { id text value } }';
const items = [];
try {
  const first = await monday.request(
    `query ($boardId: ID!, $columnId: String!) { boards(ids: [$boardId]) { items_page(limit: 500) { cursor ${PAGE} } } }`,
    { boardId, columnId }
  );
  let data = first.boards[0]?.items_page;
  if (!data) throw new Error('board not found or not readable by this token');
  items.push(...data.items);
  let cursor = data.cursor;
  while (cursor) {
    const next = await monday.request(
      `query ($cursor: String!, $columnId: String!) { next_items_page(limit: 500, cursor: $cursor) { cursor ${PAGE} } }`,
      { cursor, columnId }
    );
    data = next.next_items_page;
    items.push(...data.items);
    cursor = data.cursor;
  }
} catch (err) {
  console.error(`check-funraise-ids: could not read board ${boardId}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const result = findDuplicateFunraiseIds(items, columnId);
console.log(
  `board ${boardId}: ${result.total} item(s), ${result.withId} with a Funraise ID (${result.distinct} distinct), ${result.blank} without`
);
if (result.duplicates.length === 0) {
  console.log('OK: one Donations item per Funraise ID.');
  process.exit(0);
}
console.error(`FAIL: ${result.duplicates.length} Funraise ID(s) on more than one item:`);
for (const d of result.duplicates) console.error(`  ${d.funraiseId}: items ${d.itemIds.join(', ')}`);
process.exit(1);
