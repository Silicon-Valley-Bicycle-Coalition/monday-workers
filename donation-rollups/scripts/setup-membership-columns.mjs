#!/usr/bin/env node
// Ensures each People-type board has the eight membership columns the activity rule writes
// (spec 2026-10-09) — the four salesforce-import created (found by title) plus Current Term
// Start, Member Type, Lapse Count and Last Lapsed — and, with --registrations, an Hours column
// on Event Registrations. Prints config-ready blocks for config/<env>.json.
//
// Usage:
//   MONDAY_API_TOKEN=... node scripts/setup-membership-columns.mjs <peopleBoardId> [<peopleBoardId> ...] [--registrations <boardId>]

import { MondayGraphQL } from '../src/monday/graphql.ts';

const token = process.env.MONDAY_API_TOKEN;
if (!token) { console.error('setup-membership-columns: MONDAY_API_TOKEN is required'); process.exit(1); }
const args = process.argv.slice(2);
const regIdx = args.indexOf('--registrations');
const registrationsBoardId = regIdx >= 0 ? args[regIdx + 1] : null;
if (regIdx >= 0 && !/^\d+$/.test(registrationsBoardId ?? '')) { console.error('setup-membership-columns: --registrations needs a numeric board id'); process.exit(1); }
const boardIds = args.filter((a, i) => /^\d+$/.test(a) && (regIdx < 0 || i !== regIdx + 1));
if (boardIds.length === 0 && registrationsBoardId === null) {
  console.error('usage: node scripts/setup-membership-columns.mjs <peopleBoardId> [...] [--registrations <boardId>]');
  process.exit(1);
}

const MEMBERSHIP_FIELDS = {
  status: { title: 'Membership Status' },      // existing — found by title, never created here
  tier: { title: 'Membership Tier' },
  since: { title: 'Member Since' },
  until: { title: 'Member Until' },
  currentTermStart: { title: 'Current Term Start', type: 'date' },
  memberType: { title: 'Member Type', type: 'status', defaults: JSON.stringify({ labels: { 0: 'New', 1: 'Continuing', 2: 'Lapsed renewal' } }) },
  lapseCount: { title: 'Lapse Count', type: 'numbers' },
  lastLapsed: { title: 'Last Lapsed', type: 'date' },
};
const HOURS = { title: 'Hours', type: 'numbers' };

const monday = new MondayGraphQL('https://api.monday.com/v2', token);
async function graphql(query, variables) {
  return monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
}
async function boardColumns(boardId) {
  const data = await graphql('query ($ids: [ID!]) { boards(ids: $ids) { name columns { id title type } } }', { ids: [boardId] });
  const board = data.boards?.[0];
  if (!board) throw new Error(`setup-membership-columns: board ${boardId} not found`);
  return { name: board.name, byTitle: new Map(board.columns.map((c) => [c.title, c])) };
}
async function ensure(boardId, name, byTitle, spec) {
  const existing = byTitle.get(spec.title);
  if (existing) return existing.id;
  if (!spec.type) throw new Error(`setup-membership-columns: ${name} (${boardId}) has no "${spec.title}" column — run salesforce-import's column setup first`);
  const created = await graphql(
    `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
       create_column (board_id: $board, title: $title, column_type: $type, defaults: $defaults) { id } }`,
    { board: boardId, title: spec.title, type: spec.type, defaults: spec.defaults });
  console.error(`setup-membership-columns: ${name} (${boardId}): created "${spec.title}" → ${created.create_column.id}`);
  return created.create_column.id;
}

const out = { ownerColumnsByBoard: {}, registrations: null };
for (const boardId of boardIds) {
  const { name, byTitle } = await boardColumns(boardId);
  const membership = {};
  for (const [field, spec] of Object.entries(MEMBERSHIP_FIELDS)) membership[field] = await ensure(boardId, name, byTitle, spec);
  out.ownerColumnsByBoard[boardId] = { membership };
}
if (registrationsBoardId !== null) {
  const { name, byTitle } = await boardColumns(registrationsBoardId);
  out.registrations = { boardId: Number(registrationsBoardId), hours: await ensure(registrationsBoardId, name, byTitle, HOURS) };
}
console.log(JSON.stringify(out, null, 2));
