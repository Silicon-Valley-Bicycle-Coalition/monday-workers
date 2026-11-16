#!/usr/bin/env node
// Adds the Affiliations `Proposed status` column impact-attribution writes on each Draft it creates
// (labels Current / Former; spec "What a proposal is"). Idempotent by bare column title, so a 🔒
// marker added later never causes a duplicate; a same-titled column of another type is reported,
// never duplicated. Dry run by default; --execute creates.
//
//   MONDAY_API_TOKEN=... node impact-attribution/scripts/add-proposed-status.mjs --env sandbox
//   MONDAY_API_TOKEN=... node impact-attribution/scripts/add-proposed-status.mjs --env production --execute
//
// Then run scripts/mark-read-only-columns.mjs to put the 🔒 on it, and re-run salesforce-import's
// configure step so the "Drafts to confirm" view shows it. Exit 0: done or nothing to do. Exit 2:
// usage, conflict, or API error.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bareTitle } from '../../scripts/lib/column-titles.mjs';
import { MondayGraphQL } from '../src/monday/graphql.ts';

export const TITLE = 'Proposed status';
export const LABELS = ['Current', 'Former'];

// Pure. columns: [{ id, title, type }].
export function planColumn(columns) {
  const found = columns.find((c) => bareTitle(c.title) === TITLE);
  if (found === undefined) return { action: 'create' };
  if (found.type !== 'status') return { action: 'conflict', detail: `"${TITLE}" exists as type "${found.type}", expected "status"; fix or rename it` };
  return { action: 'exists' };
}

// create_column `defaults` for a status column: label index -> label.
export function defaultsJson() {
  return JSON.stringify({ labels: Object.fromEntries(LABELS.map((l, i) => [i + 1, l])) });
}

// Pure. Monday silently accepts a malformed `defaults` payload and creates a status column with its
// own default labels, so the result is checked. Returns problems (empty = fine).
export function verifyLabels(columns) {
  const col = columns.find((c) => bareTitle(c.title) === TITLE && c.type === 'status');
  if (col === undefined) return [`${TITLE} column not found`];
  const labels = Object.values(JSON.parse(col.settings_str || '{}').labels ?? {});
  const missing = LABELS.filter((l) => !labels.includes(l));
  return missing.length === 0 ? [] : [`${TITLE} is missing labels: ${missing.join(', ')}`];
}

export function parseArgs(argv) {
  const args = { env: null, execute: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--env': args.env = argv[++i] ?? null; break;
      case '--execute': args.execute = true; break;
      default: throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (args.env !== 'sandbox' && args.env !== 'production') throw new Error('--env sandbox|production is required');
  return args;
}

const BOARD_QUERY = `query ($ids: [ID!]) { boards(ids: $ids) { id name columns { id title type settings_str } } }`;
const CREATE = `mutation ($board: ID!, $title: String!, $defaults: JSON) {
  create_column(board_id: $board, title: $title, column_type: status, defaults: $defaults) { id } }`;

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nusage: MONDAY_API_TOKEN=... node impact-attribution/scripts/add-proposed-status.mjs --env sandbox|production [--execute]`);
    return 2;
  }
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    console.error('MONDAY_API_TOKEN is not set');
    return 2;
  }
  const file = args.env === 'sandbox' ? 'sandbox.json' : 'svbc.json';
  const config = JSON.parse(readFileSync(fileURLToPath(new URL(`../config/${file}`, import.meta.url)), 'utf8'));
  const boardId = config.affiliations.boardId;
  const gql = new MondayGraphQL(config.monday.apiUrl, token);
  const columns = async () => {
    const board = (await gql.request(BOARD_QUERY, { ids: [boardId] })).boards[0];
    if (!board) throw new Error(`Affiliations board ${boardId} not found`);
    return board.columns;
  };

  const plan = planColumn(await columns());
  if (plan.action === 'conflict') {
    console.error(`board ${boardId}: ${plan.detail}`);
    return 2;
  }
  if (plan.action === 'exists') {
    console.log(`board ${boardId}: "${TITLE}" already exists`);
  } else if (!args.execute) {
    console.log(`would create  board ${boardId}: "${TITLE}" (status: ${LABELS.join(', ')})`);
    return 0;
  } else {
    await gql.request(CREATE, { board: boardId, title: TITLE, defaults: defaultsJson() }, { idempotent: false });
    console.log(`created  board ${boardId}: "${TITLE}"`);
  }
  const problems = verifyLabels(await columns());
  for (const p of problems) console.error(p);
  return problems.length === 0 ? 0 : 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    console.error(e.message);
    process.exit(2);
  });
}
