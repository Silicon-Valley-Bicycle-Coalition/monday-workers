#!/usr/bin/env node
// Writes a funder's quarterly report numbers to a Monday doc on the Funder Reports board, one item per
// funder and quarter, from the Education Tracker, Event Registrations and the Post-Class Survey. What
// counts as what is in scripts/lib/funder-report.mjs. Run it again to refresh the page.
//
//   MONDAY_API_TOKEN=... node scripts/funder-report.mjs --quarter 2026-Q4             # dry run: prints the numbers
//   MONDAY_API_TOKEN=... node scripts/funder-report.mjs --quarter 2026-Q4 --apply     # writes both funders' pages
//   ... --funder VTA                                                                  # only one
//
// The console never gets a comment someone typed. No email is read, and an item's name only from the
// tracker: on Event Registrations and the survey it can be a person's.
// Exit 0: done. Exit 2: usage or API error; nothing is written until every read has succeeded.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MondayGraphQL } from '../monday-backup/src/monday/graphql.ts';
import { buildReport, countyOf, parseQuarter, renderReport } from './lib/funder-report.mjs';

const here = (path) => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));

function parseArgs(argv) {
  const args = { quarter: null, funder: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--quarter') args.quarter = parseQuarter(argv[++i]);
    else if (argv[i] === '--funder') args.funder = argv[++i];
    else throw new Error(`unknown argument "${argv[i]}"`);
  }
  if (args.quarter === null) throw new Error('--quarter 2026-Q4 is required');
  return args;
}

const CELLS = 'id text value ... on BoardRelationValue { linked_item_ids } ... on FormulaValue { display_value }';

// Every item on a board as { field: cell }. A column missing from the answer (deleted or retyped) fails
// the run, because every cell would otherwise read as blank.
async function readBoard(monday, board, { rules = null, names = false } = {}) {
  const { boardId, ...fields } = board;
  const columnIds = Object.values(fields);
  const params = rules === null ? null : { rules };
  const page = `cursor items { id ${names ? 'name ' : ''}column_values(ids: $columnIds) { ${CELLS} } }`;
  const first = await monday.request(`query ($boardId: ID!, $columnIds: [String!], $params: ItemsQuery) { boards(ids: [$boardId]) { items_page(limit: 500, query_params: $params) { ${page} } } }`, { boardId, columnIds, params });
  if (first.boards[0] === undefined) throw new Error(`Monday returned no board ${boardId}`);
  const items = [];
  for (let current = first.boards[0].items_page; ;) {
    items.push(...current.items);
    if (current.cursor === null) break;
    current = (await monday.request(`query ($cursor: String!, $columnIds: [String!]) { next_items_page(cursor: $cursor, limit: 500) { ${page} } }`, { cursor: current.cursor, columnIds })).next_items_page;
  }
  return items.map((item) => {
    const cells = new Map(item.column_values.map((c) => [c.id, c]));
    const row = names ? { id: item.id, name: item.name } : { id: item.id };
    for (const [field, id] of Object.entries(fields)) {
      const cell = cells.get(id);
      if (cell === undefined) throw new Error(`board ${boardId} item ${item.id} came back without column ${id}`);
      row[field] = cell;
    }
    return row;
  });
}

const text = (cell) => (cell.text ?? '').trim();
// An empty status cell's text is label id 5's; only its null value says it's blank.
const status = (cell) => (cell.value === null ? '' : text(cell));
const day = (cell) => text(cell).slice(0, 10);
const number = (value) => (value === null || value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value));

async function readEverything(monday, config) {
  const { tracker, registrations, survey, spanishSurvey } = config;
  const rows = (await readBoard(monday, tracker, { names: true })).map((r) => ({
    id: r.id, name: r.name, date: day(r.date), status: status(r.status), funder: status(r.funder), eventType: status(r.eventType), event: status(r.event),
    registered: number(text(r.registered)), checkedIn: number(text(r.checkedIn)), noShows: number(text(r.noShows)), studentHours: number(r.studentHours.display_value),
    eventItemIds: r.crmEvent.linked_item_ids ?? [],
  }));
  const eventIds = [...new Set(rows.flatMap((r) => r.eventItemIds))].map(Number);
  const people = eventIds.length === 0 ? [] : await readBoard(monday, registrations, { rules: [{ column_id: registrations.event, compare_value: eventIds, operator: 'any_of' }] });
  const statusFields = new Set(['gender', 'age', 'ethnicity', 'income', 'language', 'frequencyBefore', 'frequencyAfter', 'comfortBefore', 'comfortAfter', 'permission']);
  const answers = (await readBoard(monday, survey)).map(({ id, ...cells }) => Object.fromEntries(
    Object.entries(cells).map(([field, cell]) => [field, field === 'date' ? day(cell) : statusFields.has(field) ? status(cell) : text(cell)])));
  return {
    rows,
    registrations: people.map((p) => ({ eventItemId: (p.event.linked_item_ids ?? [])[0] ?? '', attendance: status(p.attendance), zip: text(p.zip) })),
    survey: answers,
    spanishDates: (await readBoard(monday, spanishSurvey)).map((s) => day(s.date)),
  };
}

async function writePage(monday, { boardId, doc }, name, markdown) {
  const found = await monday.request('query ($boardId: ID!, $doc: [String!]) { boards(ids: [$boardId]) { items_page(limit: 500) { items { id name column_values(ids: $doc) { ... on DocValue { file { doc { id } } } } } } } }', { boardId, doc: [doc] });
  const item = found.boards[0].items_page.items.find((i) => i.name === name);
  const itemId = item?.id ?? (await monday.request('mutation ($boardId: ID!, $name: String!) { create_item(board_id: $boardId, item_name: $name) { id } }', { boardId, name }, { idempotent: false })).create_item.id;
  const docId = item?.column_values[0]?.file?.doc?.id
    ?? (await monday.request('mutation ($itemId: ID!, $column: String!) { create_doc(location: { board: { item_id: $itemId, column_id: $column } }) { id } }', { itemId, column: doc }, { idempotent: false })).create_doc.id;

  // New content first, then the old is removed: a failure half way leaves both, never an empty page.
  const old = await docBlocks(monday, docId);
  const added = await monday.request('mutation ($docId: ID!, $markdown: String!) { add_content_to_doc_from_markdown(docId: $docId, markdown: $markdown) { success error } }', { docId, markdown }, { idempotent: false });
  if (!added.add_content_to_doc_from_markdown.success) throw new Error(`writing the doc for ${name} failed`);
  await monday.request('mutation ($docId: ID!, $name: String!) { update_doc_name(docId: $docId, name: $name) }', { docId, name: `${name} report numbers` });
  if (old.length > 0) await monday.request('mutation ($ids: [ID!]!) { delete_doc_blocks(block_ids: $ids) { id } }', { ids: old });
  return itemId;
}

// Top-level blocks only: a table's cells go with it.
async function docBlocks(monday, docId) {
  const ids = [];
  for (let page = 1; ; page++) {
    const { docs } = await monday.request('query ($ids: [ID!], $page: Int) { docs(ids: $ids) { blocks(limit: 100, page: $page) { id parent_block_id } } }', { ids: [docId], page });
    const blocks = docs[0]?.blocks ?? [];
    ids.push(...blocks.filter((b) => b.parent_block_id === null).map((b) => b.id));
    if (blocks.length < 100) return ids;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = here('./funder-report.config.json');
  const funders = config.funders.filter((f) => args.funder === null || f.label === args.funder);
  if (funders.length === 0) throw new Error(`--funder must be one of ${config.funders.map((f) => f.label).join(', ')}`);
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error('MONDAY_API_TOKEN is required');

  const monday = new MondayGraphQL(config.apiUrl, token);
  const eventbrite = here('../eventbrite-sync/config/svbc.json');
  const tables = { overrides: eventbrite.attendeeSync.zipCounty.overrides, lists: { ...eventbrite.pledge.zipCounty, ...eventbrite.attendeeSync.zipCounty.lists } };
  const data = await readEverything(monday, config);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

  for (const funder of funders) {
    const report = buildReport({ funder, quarter: args.quarter, today, ...data, county: (zip) => countyOf(zip, tables), options: config.options });
    const name = `${funder.label} ${args.quarter.label}`;
    if (args.apply) console.log(`${name}: wrote item ${await writePage(monday, config.report, name, renderReport(report, { quotes: true }))}`);
    else console.log(`${renderReport(report, { quotes: false })}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`funder-report: ${err.message}`);
    process.exit(2);
  });
}
