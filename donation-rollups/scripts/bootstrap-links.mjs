#!/usr/bin/env node
// One-time bootstrap for the donation_links D1 table (see migrations/0003_donation_links.sql).
// The Worker maintains this reverse index incrementally as webhooks arrive, but it starts
// empty — every Donation already on the board when this Worker goes live needs a row too,
// or its donor's rollup silently comes back short until that specific donation happens to
// get touched again. Reads the same donationBoards list the Worker itself uses (--config
// <path>, default config/svbc.json), so there's one source of truth for "which boards, which
// column ids."
//
// Usage:
//   MONDAY_API_TOKEN=... node scripts/bootstrap-links.mjs [--out bootstrap.sql] [--config config/sandbox.json]
//   wrangler d1 execute <database-name> --remote --file=bootstrap.sql
//
// Deliberately writes a SQL file for `wrangler d1 execute` rather than writing to D1
// directly — D1 has no public non-Workers write API, and this keeps the one-time
// bootstrap on the same tooling path as every other D1 migration in this monorepo.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MondayGraphQL } from '../src/monday/graphql.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const token = process.env.MONDAY_API_TOKEN;
if (!token) {
  console.error('bootstrap-links: MONDAY_API_TOKEN is required');
  process.exit(1);
}

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : join(HERE, '..', 'bootstrap.sql');

const configIdx = process.argv.indexOf('--config');
const configPath = configIdx >= 0 ? process.argv[configIdx + 1] : join(HERE, '..', 'config', 'svbc.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const { apiUrl } = config.monday;
const { donationBoards } = config.donationRollups;

// The Worker's own copy of the canonical Monday transport (#35): retries rate limits and Monday
// blips, times out hung requests, and never blindly re-runs a create. Imported as TypeScript —
// needs a Node with built-in type stripping (22.18+ / 23.6+).
const monday = new MondayGraphQL(apiUrl, token);

// Mutations here create boards, columns and webhooks, so a failure that may have committed throws
// AmbiguousWriteError instead of being retried into a duplicate; queries get the full retry.
async function graphql(query, variables) {
  return monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
}

async function* listOwnerLinks(boardId, donorLinkColumnId) {
  let cursor = null;
  do {
    const data = await graphql(
      `query ($boardId: [ID!], $columnId: [String!], $cursor: String) {
        boards(ids: $boardId) {
          items_page(limit: 100, cursor: $cursor) {
            cursor
            items { id column_values(ids: $columnId) { id ... on BoardRelationValue { linked_item_ids } } }
          }
        }
      }`,
      { boardId: [boardId], columnId: [donorLinkColumnId], cursor },
    );
    const page = data.boards[0]?.items_page;
    if (!page) return;
    for (const item of page.items) {
      const linked = item.column_values[0]?.linked_item_ids ?? [];
      if (linked.length > 0) yield { itemId: item.id, ownerItemId: linked[0] };
    }
    cursor = page.cursor;
  } while (cursor !== null);
}

const sqlEscape = (s) => `'${String(s).replace(/'/g, "''")}'`;

const rows = [];
const now = new Date().toISOString();
for (const board of donationBoards) {
  console.log(`bootstrap-links: scanning board ${board.boardId}…`);
  let count = 0;
  for await (const { itemId, ownerItemId } of listOwnerLinks(board.boardId, board.columns.donorLink)) {
    // ownerBoardId isn't knowable from this query alone (the linked item could be on
    // any of the board_relation column's configured target boards) — left blank here;
    // the Worker fills it in via change on first webhook touch, or a follow-up pass
    // can resolve it with one items(ids:) call per unique ownerItemId if needed sooner.
    rows.push({ donationItemId: itemId, donationBoardId: String(board.boardId), ownerItemId });
    count++;
  }
  console.log(`  ${count} linked donations`);
}

console.log(`bootstrap-links: ${rows.length} total links, writing ${OUT}`);

const BATCH = 500;
const lines = [];
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const values = chunk.map((r) =>
    `(${sqlEscape(r.donationItemId)}, ${sqlEscape(r.donationBoardId)}, ${sqlEscape(r.ownerItemId)}, '', ${sqlEscape(now)})`);
  lines.push(
    `INSERT INTO donation_links (donation_item_id, donation_board_id, owner_item_id, owner_board_id, updated_at)\n` +
    `VALUES\n${values.join(',\n')}\n` +
    `ON CONFLICT (donation_item_id) DO UPDATE SET\n` +
    `  donation_board_id = excluded.donation_board_id, owner_item_id = excluded.owner_item_id, updated_at = excluded.updated_at;`,
  );
}
writeFileSync(OUT, lines.join('\n\n') + '\n');
console.log(`bootstrap-links: done. Apply with:\n  wrangler d1 execute <database-name> --remote --file=${OUT}`);
