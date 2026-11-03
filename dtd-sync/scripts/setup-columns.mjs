#!/usr/bin/env node
// Provisions the Monday surface dtd-sync writes, creating whatever is missing (idempotent by bare
// column title, so a 🔒 marker added later never causes a duplicate) and printing a config-ready
// JSON block of every column id:
//   Donations: Match Status, DTD Status (raw), Match Company, Matches gift, Match pairing, Sent to DTD
//   People:    DTD Company ID, DTD Company, DTD match link
//   Board "Matching Gift Program" (program summary) in the given workspace
//   Donations table view "Matching gifts to follow up" (Match Status = Waiting for donor, newest first)
// Run once per environment, then paste the output into config/sandbox.json or config/svbc.json.
//
// Usage:
//   MONDAY_API_TOKEN=... node dtd-sync/scripts/setup-columns.mjs --donations <id> --people <id> --workspace <id>
//     [--config dtd-sync/config/sandbox.json]   # statusLabels / programSummary keys come from here

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bareTitle } from '../../scripts/lib/column-titles.mjs';

export const PROGRAM_BOARD_NAME = 'Matching Gift Program';
export const VIEW_NAME = 'Matching gifts to follow up';
export const WAITING_LABEL = 'Waiting for donor';
export const PAIRING_LABELS = ['Auto', 'Needs review', 'Staff'];
// Monday reads an empty status cell as label id 5, so a real label must never sit on it.
export const RESERVED_LABEL_ID = 5;

const WRITTEN_BY = 'Written by dtd-sync';

// Distinct Match Status labels, in first-seen order: the statusLabels values, then Matched, Other.
export function matchStatusLabels(statusLabels) {
  return [...new Set([...Object.values(statusLabels), 'Matched', 'Other'])];
}

// {"0":"A","1":"B",...} skipping RESERVED_LABEL_ID.
export function labelIds(labels) {
  const out = {};
  let id = 0;
  for (const label of labels) {
    if (id === RESERVED_LABEL_ID) id++;
    out[id++] = label;
  }
  return out;
}

const statusDefaults = (labels) => JSON.stringify({ labels: labelIds(labels) });

// Column specs per board. `key` is the config key. `boardRelation: true` points the relation at
// the Donations board itself (filled in by the caller, which knows the id).
export function donationColumnSpecs(statusLabels) {
  return [
    { key: 'matchStatus', title: 'Match Status', type: 'status', description: WRITTEN_BY, labels: matchStatusLabels(statusLabels) },
    { key: 'dtdStatusRaw', title: 'DTD Status (raw)', type: 'text', description: WRITTEN_BY },
    { key: 'matchCompany', title: 'Match Company', type: 'text', description: WRITTEN_BY },
    { key: 'matchesGift', title: 'Matches gift', type: 'board_relation', description: WRITTEN_BY, boardRelation: true },
    { key: 'matchPairing', title: 'Match pairing', type: 'status', description: 'Set Staff to lock a link you made by hand', labels: PAIRING_LABELS },
    { key: 'sentToDtd', title: 'Sent to DTD', type: 'date', description: WRITTEN_BY },
  ];
}

export const PEOPLE_COLUMN_SPECS = [
  { key: 'dtdCompanyId', title: 'DTD Company ID', type: 'text', description: WRITTEN_BY },
  { key: 'dtdCompany', title: 'DTD Company', type: 'text', description: WRITTEN_BY },
  { key: 'dtdLink', title: 'DTD match link', type: 'link', description: WRITTEN_BY },
];

const CURRENCY = JSON.stringify({ unit: { symbol: '$', direction: 'left', precision: 2 } });
const PROGRAM_TITLES = {
  screened: ['Screened', 'numbers'],
  employerIdentified: ['Employer identified', 'numbers'],
  eligible: ['Eligible', 'numbers'],
  submitted: ['Submitted', 'numbers'],
  matchesPaid: ['Matches paid', 'numbers'],
  matchDollars: ['Match dollars', 'numbers', CURRENCY],
  matchedGiftDollars: ['Matched gift dollars', 'numbers', CURRENCY],
  newMatchingCompanies: ['New matching companies', 'numbers'],
  firstTimeMatchedDonors: ['First-time matched donors', 'numbers'],
  asOf: ['As of', 'date'],
};

// One spec per key of config.programSummary, in config order; fiscalYear is the text column.
export function programSummarySpecs(programSummaryKeys) {
  return programSummaryKeys.map((key) => {
    if (key === 'fiscalYear') return { key, title: 'Fiscal Year', type: 'text', description: WRITTEN_BY };
    const entry = PROGRAM_TITLES[key];
    if (!entry) throw new Error(`setup-columns: no column title for programSummary.${key}`);
    const [title, type, defaults] = entry;
    return { key, title, type, description: WRITTEN_BY, defaults };
  });
}

// Index existing columns by bare title.
export function indexByTitle(columns) {
  return new Map(columns.map((c) => [bareTitle(c.title), c]));
}

// Splits specs into those already on the board (key → id) and those still to create.
export function planColumns(specs, existingColumns) {
  const byTitle = indexByTitle(existingColumns);
  const have = {};
  const missing = [];
  for (const spec of specs) {
    const hit = byTitle.get(spec.title);
    if (hit) have[spec.key] = hit.id;
    else missing.push(spec);
  }
  return { have, missing };
}

export function createColumnDefaults(spec, donationsBoardId) {
  if (spec.type === 'status') return statusDefaults(spec.labels);
  if (spec.boardRelation) return JSON.stringify({ boardIds: [Number(donationsBoardId)] });
  return spec.defaults;
}

// The label index Monday gave a status label, from the column's settings_str.
export function labelIndex(settingsStr, label) {
  const labels = JSON.parse(settingsStr).labels ?? {};
  const hit = Object.entries(labels).find(([, name]) => name === label);
  return hit ? Number(hit[0]) : undefined;
}

export const viewFilter = (matchStatusColumnId, waitingIndex) => ({
  operator: 'and',
  rules: [{ column_id: matchStatusColumnId, compare_value: [waitingIndex], operator: 'any_of' }],
});

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`setup-columns: ${flag} needs a value`);
    out[flag.slice(2)] = value;
  }
  for (const k of ['donations', 'people', 'workspace']) {
    if (!/^\d+$/.test(out[k] ?? '')) throw new Error(`setup-columns: --${k} <numeric id> is required`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error('setup-columns: MONDAY_API_TOKEN is required');
  const configPath = args.config ?? fileURLToPath(new URL('../config/sandbox.json', import.meta.url));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  // The Worker's own copy of the Monday transport; imported as TypeScript (Node type stripping).
  const { MondayGraphQL } = await import('../src/monday/graphql.ts');
  const monday = new MondayGraphQL('https://api.monday.com/v2', token);
  // Mutations that may have committed throw AmbiguousWriteError instead of retrying into a duplicate.
  const graphql = (query, variables) => monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
  const log = (msg) => console.error(`setup-columns: ${msg}`);

  async function readBoard(id) {
    const data = await graphql('query ($ids: [ID!]) { boards(ids: $ids) { id name columns { id title type settings_str } } }', { ids: [id] });
    const board = data.boards?.[0];
    if (!board) throw new Error(`setup-columns: board ${id} not found`);
    return board;
  }

  async function ensureColumns(board, specs) {
    const { have, missing } = planColumns(specs, board.columns);
    for (const [key, id] of Object.entries(have)) log(`${board.name}: exists "${specs.find((s) => s.key === key).title}" → ${id}`);
    const ids = { ...have };
    for (const spec of missing) {
      const created = await graphql(
        `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON, $description: String) {
           create_column (board_id: $board, title: $title, column_type: $type, defaults: $defaults, description: $description) { id } }`,
        { board: board.id, title: spec.title, type: spec.type, defaults: createColumnDefaults(spec, args.donations), description: spec.description });
      ids[spec.key] = created.create_column.id;
      log(`${board.name}: created "${spec.title}" → ${ids[spec.key]}`);
    }
    return Object.fromEntries(specs.map((s) => [s.key, ids[s.key]]));
  }

  const donationsBoard = await readBoard(args.donations);
  const donations = await ensureColumns(donationsBoard, donationColumnSpecs(config.statusLabels));
  const peopleBoard = await readBoard(args.people);
  const people = await ensureColumns(peopleBoard, PEOPLE_COLUMN_SPECS);

  // Program summary board, found by name inside the workspace.
  const inWorkspace = await graphql('query ($ws: [ID!]) { boards(workspace_ids: $ws, limit: 100) { id name } }', { ws: [args.workspace] });
  let summary = inWorkspace.boards.find((b) => b.name === PROGRAM_BOARD_NAME);
  if (summary) log(`exists board "${PROGRAM_BOARD_NAME}" → ${summary.id}`);
  else {
    const created = await graphql(
      'mutation ($name: String!, $ws: ID) { create_board (board_name: $name, board_kind: public, workspace_id: $ws) { id } }',
      { name: PROGRAM_BOARD_NAME, ws: args.workspace });
    summary = { id: created.create_board.id };
    log(`created board "${PROGRAM_BOARD_NAME}" → ${summary.id}`);
  }
  const summaryBoard = await readBoard(summary.id);
  const programSummary = await ensureColumns(summaryBoard, programSummarySpecs(Object.keys(config.programSummary)));

  // View: re-read Match Status for its label index, then create unless a view of that name exists.
  const fresh = await readBoard(args.donations);
  const statusCol = fresh.columns.find((c) => c.id === donations.matchStatus);
  const waiting = labelIndex(statusCol.settings_str, WAITING_LABEL);
  if (waiting === undefined) throw new Error(`setup-columns: Match Status has no "${WAITING_LABEL}" label`);
  const views = await graphql('query ($ids: [ID!]) { boards(ids: $ids) { views { id name } } }', { ids: [args.donations] });
  const existingView = views.boards[0].views.find((v) => v.name === VIEW_NAME);
  let viewId;
  if (existingView) {
    viewId = existingView.id;
    log(`exists view "${VIEW_NAME}" → ${viewId}`);
  } else {
    const created = await graphql(
      `mutation ($board: ID!, $name: String, $filter: ItemsQueryGroup, $sort: [ItemsQueryOrderBy!]) {
         create_view_table (board_id: $board, name: $name, filter: $filter, sort: $sort) { id } }`,
      { board: args.donations, name: VIEW_NAME, filter: viewFilter(donations.matchStatus, waiting), sort: [{ column_id: fresh.columns.find((c) => bareTitle(c.title) === 'Date').id, direction: 'desc' }] });
    viewId = created.create_view_table.id;
    log(`created view "${VIEW_NAME}" → ${viewId}`);
  }

  console.log(JSON.stringify({ boards: { programSummary: Number(summary.id) }, donations, people, programSummary, viewId }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
