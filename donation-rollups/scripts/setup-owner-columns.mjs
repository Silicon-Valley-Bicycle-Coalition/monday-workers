#!/usr/bin/env node
// Ensures every owner board (People / People Historical / Organizations) has the full
// 12-column rollup set this Worker writes, creating any that are missing, and prints a
// config-ready `ownerColumnsByBoard` JSON block. salesforce-import creates only the first
// three (Lifetime Giving / First Gift / Gift Count); the other nine are this Worker's own
// surface, so provisioning them lives here. Run once per new environment (sandbox rebuild,
// production cutover), then paste the output into the config file for the environment you
// provisioned (`config/sandbox.json` or `config/svbc.json`).
//
// Usage:
//   MONDAY_API_TOKEN=... node scripts/setup-owner-columns.mjs <boardId> [<boardId> ...]

import { MondayGraphQL } from '../src/monday/graphql.ts';

const token = process.env.MONDAY_API_TOKEN;
if (!token) {
  console.error('setup-owner-columns: MONDAY_API_TOKEN is required');
  process.exit(1);
}
const boardIds = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (boardIds.length === 0) {
  console.error('usage: node scripts/setup-owner-columns.mjs <boardId> [<boardId> ...]');
  process.exit(1);
}

// Field key → { title, type, currency } — titles must match the existing boards so staff
// see one consistent vocabulary everywhere.
const CURRENCY = JSON.stringify({ unit: { symbol: '$', direction: 'left', precision: 2 } });
const FIELDS = {
  // Machine-readable gift-history projection (docs/20 §5.5) — plain text, no cap.
  giftLedgerJson: { title: 'Gift Ledger (JSON)', type: 'text' },
  lifetimeGiving: { title: 'Lifetime Giving', type: 'numbers', defaults: CURRENCY },
  giftCount: { title: 'Gift Count', type: 'numbers' },
  firstGift: { title: 'First Gift', type: 'date' },
  thisYearAmount: { title: 'This Year Amount', type: 'numbers', defaults: CURRENCY },
  thisYearCount: { title: 'This Year Count', type: 'numbers' },
  lastYearAmount: { title: 'Last Year Amount', type: 'numbers', defaults: CURRENCY },
  lastYearCount: { title: 'Last Year Count', type: 'numbers' },
  largestGift: { title: 'Largest Gift', type: 'numbers', defaults: CURRENCY },
  smallestGift: { title: 'Smallest Gift', type: 'numbers', defaults: CURRENCY },
  averageGift: { title: 'Average Gift', type: 'numbers', defaults: CURRENCY },
  lastGiftDate: { title: 'Last Gift Date', type: 'date' },
  lastGiftAmount: { title: 'Last Gift Amount', type: 'numbers', defaults: CURRENCY },
};

// The Worker's own copy of the canonical Monday transport (#35): retries rate limits and Monday
// blips, times out hung requests, and never blindly re-runs a create. Imported as TypeScript —
// needs a Node with built-in type stripping (22.18+ / 23.6+).
const monday = new MondayGraphQL('https://api.monday.com/v2', token, { apiVersion: '2026-01' });

// Mutations here create boards, columns and webhooks, so a failure that may have committed throws
// AmbiguousWriteError instead of being retried into a duplicate; queries get the full retry.
async function graphql(query, variables) {
  return monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
}

const out = {};
for (const boardId of boardIds) {
  const data = await graphql(
    'query ($ids: [ID!]) { boards(ids: $ids) { name columns { id title type } } }',
    { ids: [boardId] });
  const board = data.boards?.[0];
  if (!board) throw new Error(`setup-owner-columns: board ${boardId} not found`);
  const byTitle = new Map(board.columns.map((c) => [c.title, c]));

  const cols = {};
  for (const [field, spec] of Object.entries(FIELDS)) {
    const existing = byTitle.get(spec.title);
    if (existing) {
      cols[field] = existing.id;
      continue;
    }
    const created = await graphql(
      `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
         create_column (board_id: $board, title: $title, column_type: $type, defaults: $defaults) { id } }`,
      { board: boardId, title: spec.title, type: spec.type, defaults: spec.defaults });
    cols[field] = created.create_column.id;
    console.error(`setup-owner-columns: ${board.name} (${boardId}): created "${spec.title}" → ${cols[field]}`);
  }
  out[boardId] = cols;
}
console.log(JSON.stringify(out, null, 2));
