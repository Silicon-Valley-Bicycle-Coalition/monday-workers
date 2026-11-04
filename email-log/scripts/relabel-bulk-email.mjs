#!/usr/bin/env node
// One-off: relabels bulk sends logged before `mail.bulkSenders` existed, from Activity Type Email
// to Bulk Email, so people-reclassification doesn't count them as contact. It finds them by the
// Notes footer "Sent by <sender>", which buildActivity only writes for a BCC. Dry run by default.
//
// Usage: MONDAY_API_TOKEN=... node scripts/relabel-bulk-email.mjs --config config/<env>.json [--apply]

import { readFileSync } from 'node:fs';
import { MondayGraphQL } from '../src/monday/graphql.ts';

const argIdx = (name) => process.argv.indexOf(name);
const configPath = argIdx('--config') >= 0 ? process.argv[argIdx('--config') + 1] : null;
const apply = argIdx('--apply') >= 0;
const token = process.env.MONDAY_API_TOKEN;
if (!token || !configPath) {
  console.error('usage: MONDAY_API_TOKEN=... node scripts/relabel-bulk-email.mjs --config config/<env>.json [--apply]');
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const a = config.activities;
const boardId = String(config.monday.boards['activities-logged']);
const monday = new MondayGraphQL(config.monday.apiUrl, token);
const footers = config.mail.bulkSenders.map((s) => `Sent by ${s.toLowerCase()}`);

const columnIds = [a.activityTypeColumn, a.notesColumn];
const itemFields = 'cursor items { id column_values(ids: $columnIds) { id text } }';
const matches = [];
let cursor = null;
let scanned = 0;
do {
  const data = cursor === null
    ? await monday.request(`query ($boardId: [ID!], $columnIds: [String!]) { boards(ids: $boardId) { items_page(limit: 500) { ${itemFields} } } }`, { boardId: [boardId], columnIds })
    : await monday.request(`query ($cursor: String!, $columnIds: [String!]) { next_items_page(limit: 500, cursor: $cursor) { ${itemFields} } }`, { cursor, columnIds });
  const page = cursor === null ? data.boards[0].items_page : data.next_items_page;
  for (const item of page.items) {
    scanned += 1;
    const text = (id) => item.column_values.find((c) => c.id === id)?.text ?? '';
    const notes = text(a.notesColumn).toLowerCase();
    if (text(a.activityTypeColumn) === a.activityTypeLabel && footers.some((f) => notes.includes(f))) matches.push(item.id);
  }
  cursor = page.cursor;
} while (cursor !== null);

console.log(`scanned ${scanned}; ${matches.length} logged bulk sends labelled ${a.activityTypeLabel}: ${matches.join(', ') || 'none'}`);
if (!apply) {
  console.log('dry run; pass --apply to relabel');
  process.exit(0);
}
for (const itemId of matches) {
  await monday.request(
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }`,
    { boardId, itemId, columnId: a.activityTypeColumn, value: JSON.stringify({ label: a.bulkActivityTypeLabel }) },
  );
  console.log(`relabelled ${itemId}`);
}
