#!/usr/bin/env node
// Creates the Annual Giving Summary board (docs/20 §5.4) — one item per closed fiscal year,
// written only by the custodian's year-end archive run (or an audit restatement). Prints the
// config snippet for custodian.annualSummaryBoardId + annualSummaryColumns. Run once per
// environment; re-running against an existing board reuses same-titled columns.
//
// Usage:
//   MONDAY_API_TOKEN=... node scripts/setup-annual-summary-board.mjs \
//     --workspace 18210301 --name "Annual Giving Summary (sandbox v2)" [--board <existingId>]

import { MondayGraphQL } from '../src/monday/graphql.ts';
import { bareTitle } from '../../scripts/lib/column-titles.mjs';

const token = process.env.MONDAY_API_TOKEN;
if (!token) {
  console.error('setup-annual-summary-board: MONDAY_API_TOKEN is required');
  process.exit(1);
}
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const workspaceId = arg('--workspace');
const boardName = arg('--name') ?? 'Annual Giving Summary';
let boardId = arg('--board');
if (!workspaceId && !boardId) {
  console.error('usage: setup-annual-summary-board.mjs --workspace <id> [--name "..."] [--board <existingId>]');
  process.exit(1);
}

const CURRENCY = JSON.stringify({ unit: { symbol: '$', direction: 'left', precision: 2 } });
const FIELDS = {
  // text, not numbers: a numbers column would render 2025 as "2,025"
  fiscalYear: { title: 'Fiscal Year Ending', type: 'text' },
  total: { title: 'Total Received', type: 'numbers', defaults: CURRENCY },
  giftCount: { title: 'Gift Count', type: 'numbers' },
  byType: { title: 'By Gift Type', type: 'long_text' },
  restatedAt: { title: 'Restated', type: 'date' },
};

// The Worker's own copy of the canonical Monday transport (#35): retries rate limits and Monday
// blips, times out hung requests, and never blindly re-runs a create. Imported as TypeScript —
// needs a Node with built-in type stripping (22.18+ / 23.6+).
const monday = new MondayGraphQL('https://api.monday.com/v2', token);

// Mutations here create boards, columns and webhooks, so a failure that may have committed throws
// AmbiguousWriteError instead of being retried into a duplicate; queries get the full retry.
async function graphql(query, variables) {
  return monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
}

if (!boardId) {
  const created = await graphql(
    `mutation ($name: String!, $workspaceId: ID!) {
       create_board (board_name: $name, board_kind: public, workspace_id: $workspaceId) {
         id
         items_page (limit: 25) { items { id } }
       } }`,
    { name: boardName, workspaceId });
  boardId = created.create_board.id;
  // Delete monday.com's seeded placeholder item before any real data lands.
  for (const item of created.create_board.items_page?.items ?? []) {
    await graphql('mutation ($id: ID!) { delete_item (item_id: $id) { id } }', { id: item.id });
  }
  console.error(`setup-annual-summary-board: created board ${boardId} ("${boardName}")`);
}

const data = await graphql('query ($ids: [ID!]) { boards(ids: $ids) { columns { id title } } }', { ids: [boardId] });
const byTitle = new Map(data.boards[0].columns.map((c) => [bareTitle(c.title), c.id]));
const cols = {};
for (const [field, spec] of Object.entries(FIELDS)) {
  if (byTitle.has(spec.title)) {
    cols[field] = byTitle.get(spec.title);
    continue;
  }
  const created = await graphql(
    `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
       create_column (board_id: $board, title: $title, column_type: $type, defaults: $defaults) { id } }`,
    { board: boardId, title: spec.title, type: spec.type, defaults: spec.defaults });
  cols[field] = created.create_column.id;
  console.error(`setup-annual-summary-board: created "${spec.title}" → ${cols[field]}`);
}

console.log(JSON.stringify({ annualSummaryBoardId: Number(boardId), annualSummaryColumns: cols }, null, 2));
