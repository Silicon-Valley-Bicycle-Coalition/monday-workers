#!/usr/bin/env node
// Provisions the private Pledge to Ride board, creating whatever is missing (idempotent by name and by
// bare column title, so a 🔒 marker never causes a duplicate), and prints the config-ready board id
// and columns. Dry run by default. Run once per environment, then paste the output into
// config/sandbox.json or config/svbc.json.
//
// Usage (from eventbrite-sync/):
//   MONDAY_API_TOKEN=... node scripts/setup-pledge-board.mjs --workspace <id> \
//     [--board <id>]           use this board instead of finding it by name
//     [--subscribe <userId>]   repeatable. A private board is invisible to anyone not subscribed, so
//                              include the Worker's integration user and monday-backup's
//     [--apply]                make the changes
//
// A private board is also invisible to this script unless the token's user is subscribed. Run it
// with the same user each time, or pass --board and check the result. Then run
// scripts/mark-read-only-columns.mjs for the 🔒 markers.

import { fileURLToPath } from 'node:url';
import { bareTitle } from '../../scripts/lib/column-titles.mjs';

export const BOARD_NAME = 'Pledge to Ride';
// Monday reads an empty status cell as label id 5, so a real label must never sit on it.
export const RESERVED_LABEL_ID = 5;

const WRITTEN_BY = 'Written by eventbrite-sync';

// `key` is the key in config pledge.columns. Year and the dropdowns get their labels from the writes.
export const PLEDGE_COLUMN_SPECS = [
  { key: 'attendeeIdColumn', title: 'Eventbrite Attendee ID', type: 'text' },
  { key: 'yearColumn', title: 'Year', type: 'status', labels: [] },
  { key: 'statusColumn', title: 'Status', type: 'status', labels: ['Pledged', 'Canceled'] },
  { key: 'dateColumn', title: 'Pledge Date', type: 'date' },
  { key: 'emailColumn', title: 'Email', type: 'email' },
  { key: 'detailsColumn', title: 'Details', type: 'status', labels: ['Complete', 'Buyer only'] },
  { key: 'zipColumn', title: 'Zip', type: 'text' },
  { key: 'countyColumn', title: 'County', type: 'status', labels: ['Santa Clara', 'San Mateo', 'Outside', 'Unknown'] },
  { key: 'daysPledgedColumn', title: 'Days Pledged', type: 'status', labels: ['1 day', 'Multiple days', 'All month'] },
  { key: 'riderTypeColumn', title: 'Rider Type', type: 'dropdown' },
  { key: 'heardAboutColumn', title: 'Heard About It', type: 'dropdown' },
  { key: 'whoAskedColumn', title: 'Who Asked', type: 'text' },
  { key: 'consentColumn', title: 'Contact Consent', type: 'checkbox' },
  { key: 'otherAnswersColumn', title: 'Other Answers', type: 'long_text' },
];

export function columnDefaults(spec) {
  if (!spec.labels) return undefined;
  const labels = {};
  let id = 0;
  for (const label of spec.labels) {
    if (id === RESERVED_LABEL_ID) id++;
    labels[id++] = label;
  }
  return JSON.stringify({ labels });
}

export function missingColumns(existing, specs) {
  const titles = new Set(existing.map((c) => bareTitle(c.title)));
  return specs.filter((spec) => !titles.has(spec.title));
}

export function columnConfig(existing, specs) {
  const byTitle = new Map(existing.map((c) => [bareTitle(c.title), c.id]));
  return Object.fromEntries(specs.map((spec) => {
    const id = byTitle.get(spec.title);
    if (id === undefined) throw new Error(`setup-pledge-board: no column "${spec.title}" on the board`);
    return [spec.key, id];
  }));
}

export function parseArgs(argv) {
  const out = { workspace: null, board: null, subscribe: [], apply: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apply') {
      out.apply = true;
      continue;
    }
    const value = argv[++i];
    if (!['--workspace', '--board', '--subscribe'].includes(flag)) throw new Error(`setup-pledge-board: unknown flag ${flag}`);
    if (!/^\d+$/.test(value ?? '')) throw new Error(`setup-pledge-board: ${flag} needs a numeric id`);
    if (flag === '--subscribe') out.subscribe.push(value);
    else out[flag.slice(2)] = value;
  }
  if (out.workspace === null) throw new Error('setup-pledge-board: --workspace <numeric id> is required');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error('setup-pledge-board: MONDAY_API_TOKEN is required');

  // The Worker's own copy of the Monday transport; imported as TypeScript (Node type stripping).
  const { MondayGraphQL } = await import('../src/monday/graphql.ts');
  const monday = new MondayGraphQL('https://api.monday.com/v2', token);
  // Mutations that may have committed throw AmbiguousWriteError instead of retrying into a duplicate.
  const graphql = (query, variables) => monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
  const log = (msg) => console.error(`setup-pledge-board: ${msg}`);

  let boardId = args.board;
  if (boardId === null) {
    const found = await graphql('query ($ws: [ID!]) { boards(workspace_ids: $ws, limit: 500) { id name } }', { ws: [args.workspace] });
    boardId = found.boards.find((b) => b.name === BOARD_NAME)?.id ?? null;
  }
  if (boardId === null) {
    log(`no board "${BOARD_NAME}" this token can see in workspace ${args.workspace}`);
    if (!args.apply) {
      log(`dry run: would create it private, with ${PLEDGE_COLUMN_SPECS.length} columns, subscribing ${args.subscribe.length} users`);
      return;
    }
    const created = await graphql(
      'mutation ($name: String!, $ws: ID) { create_board (board_name: $name, board_kind: private, workspace_id: $ws) { id } }',
      { name: BOARD_NAME, ws: args.workspace }
    );
    boardId = created.create_board.id;
    log(`created private board → ${boardId}`);
  }

  const read = async () => {
    const data = await graphql('query ($ids: [ID!]) { boards(ids: $ids) { id board_kind columns { id title type } } }', { ids: [boardId] });
    const board = data.boards?.[0];
    if (!board) throw new Error(`setup-pledge-board: board ${boardId} not found, or the token's user isn't subscribed`);
    return board;
  };
  const board = await read();
  if (board.board_kind !== 'private') throw new Error(`setup-pledge-board: board ${boardId} is ${board.board_kind}; it must be private`);

  const missing = missingColumns(board.columns, PLEDGE_COLUMN_SPECS);
  if (!args.apply) {
    log(`dry run: board ${boardId} needs ${missing.map((s) => `"${s.title}"`).join(', ') || 'no columns'}; would subscribe ${args.subscribe.length} users`);
    return;
  }
  for (const spec of missing) {
    await graphql(
      `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON, $description: String) {
         create_column (board_id: $board, title: $title, column_type: $type, defaults: $defaults, description: $description) { id } }`,
      { board: boardId, title: spec.title, type: spec.type, defaults: columnDefaults(spec), description: WRITTEN_BY }
    );
    log(`created "${spec.title}"`);
  }
  if (args.subscribe.length > 0) {
    await graphql('mutation ($board: ID!, $users: [ID!]!) { add_users_to_board (board_id: $board, user_ids: $users, kind: subscriber) { id } }', { board: boardId, users: args.subscribe });
    log(`subscribed ${args.subscribe.length} users`);
  }
  const fresh = await read();
  console.log(JSON.stringify({ boards: { 'pledge-to-ride': Number(boardId) }, columns: columnConfig(fresh.columns, PLEDGE_COLUMN_SPECS) }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
