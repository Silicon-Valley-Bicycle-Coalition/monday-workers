#!/usr/bin/env node
// One-time setup for the Sponsor Outreach board: new columns, the Sponsorships board linked to
// Organizations, prospects and sponsor contacts marked, the event-name table checked, and the
// review lists Martha checks before the board is built. Run by David with his own token, never a
// Worker's. Design: docs/superpowers/specs/2026-11-09-sponsor-outreach-board-design.md
// Runbook: docs/runbooks/sponsor-outreach-setup.md
//
//   MONDAY_API_TOKEN=... node scripts/sponsor-outreach-setup.mjs columns \
//     --organizations <id> --affiliations <id> --sponsorships <id> [--apply]
//
// Every command is a dry run unless --apply is given, and a dry run sends no mutation. Columns are
// found by title through bareTitle. Names, emails and notes never reach the console: it prints
// counts, Monday ids and column titles. Review lists go to CSV files under a data/ directory only.
// A Monday error's message is never printed, since it can echo the write it refused.
//
// Archived items are not read (items_page skips them).
//
// Exit 0: nothing wrong. Exit 1: review items, or a check failed. Exit 2: usage or API error.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MondayApiError, MondayGraphQL } from '../monday-backup/src/monday/graphql.ts';
import { bareTitle } from './lib/column-titles.mjs';
import { assertDataPath } from './lib/sponsor-outreach-setup.mjs';

const API_URL = 'https://api.monday.com/v2';
const ITEM_PAGE_SIZE = 500;
const MAX_ITEM_PAGES = 100;
export const ARCHIVED_NOTE = "Archived items aren't read.";

// Titles exactly as the design names them. None are 🔒: staff edit all four.
export const WANTED_COLUMNS = {
  organizations: [
    { title: 'Sponsor Prospect', type: 'checkbox' },
    { title: 'Prospect Notes', type: 'text' },
  ],
  affiliations: [{ title: 'Sponsor Contact', type: 'checkbox' }],
  sponsorships: [{ title: 'Organization', type: 'board_relation' }],
};

const BOARD_FLAGS = ['--organizations', '--affiliations', '--people', '--historical', '--donations', '--sponsorships'];
const PATH_FLAGS = ['--out', '--input', '--dir'];

const COMMANDS = {
  columns: { required: ['--organizations', '--affiliations', '--sponsorships'], optional: ['--apply'] },
};

const USAGE = `usage: MONDAY_API_TOKEN=... node scripts/sponsor-outreach-setup.mjs <command>
  columns --organizations <id> --affiliations <id> --sponsorships <id> [--apply]`;

const flagKey = (flag) => flag.slice(2);

export function parseArgs(argv) {
  const command = argv[0];
  const spec = Object.hasOwn(COMMANDS, command ?? '') ? COMMANDS[command] : null;
  if (!spec) throw new Error(`name a command: ${Object.keys(COMMANDS).join(', ')}`);
  const allowed = new Set([...spec.required, ...spec.optional]);
  const args = { command };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.has(flag)) throw new Error(`unknown argument "${flag}" for ${command}`);
    if (flag === '--apply') {
      args.apply = true;
      continue;
    }
    if (Object.hasOwn(args, flagKey(flag))) throw new Error(`${flag} can only be given once`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (BOARD_FLAGS.includes(flag) && !/^\d+$/.test(value)) throw new Error(`${flag} must be numeric, got "${value}"`);
    if (!BOARD_FLAGS.includes(flag) && !PATH_FLAGS.includes(flag)) throw new Error(`unknown argument "${flag}"`);
    args[flagKey(flag)] = value;
  }
  for (const flag of spec.required) if (!Object.hasOwn(args, flagKey(flag))) throw new Error(`${flag} is required for ${command}`);
  if (spec.optional.includes('--apply')) args.apply = args.apply === true;
  return args;
}

// A failed check or review items: the message is ours, ids and titles only. Exit 1.
export class CheckFailed extends Error {}
// A stop that isn't a check, such as a page cap: the message is ours. Exit 2.
export class Stopped extends Error {}

function describeFailure(error) {
  if (error instanceof Stopped) return error.message;
  if (!(error instanceof MondayApiError)) return 'Unexpected error; its message is withheld because it can echo a value.';
  const facts = [];
  if (error.httpStatus !== undefined) facts.push(`HTTP ${error.httpStatus}`);
  if (typeof error.code === 'string' && /^\w{1,64}$/.test(error.code)) facts.push(error.code);
  return `Monday call failed${facts.length > 0 ? ` (${facts.join(', ')})` : ''}; its message is withheld because it can echo a value.`;
}

/** title (bare) → { id, type } for one board. Two columns with one bare title stop the run. */
export async function columnsByTitle(gql, boardId) {
  const data = await gql(`query ($ids: [ID!]) { boards(ids: $ids) { id columns { id title type } } }`, { ids: [boardId] });
  const board = data.boards?.[0];
  if (!board) throw new Stopped(`Board ${boardId} not found, or the token can't see it.`);
  const map = new Map();
  for (const c of board.columns ?? []) {
    const title = bareTitle(c.title);
    if (map.has(title)) throw new Stopped(`Board ${boardId} has two columns titled "${title}".`);
    map.set(title, { id: String(c.id), type: c.type });
  }
  return map;
}

/** The column for a title, or a stop naming what's missing. */
export function needColumn(columns, boardId, title) {
  const col = columns.get(title);
  if (!col) throw new Stopped(`Board ${boardId} has no "${title}" column. Run the columns command first.`);
  return col;
}

const ITEM_FIELDS = `cursor items {
  id name
  column_values(ids: $cols) { id text value ... on BoardRelationValue { linked_item_ids } }
}`;

/** Every item with the requested cells: { id, name, values: { colId: { text, value, linked } } }. */
export async function readItems(gql, boardId, cols) {
  const first = await gql(
    `query ($ids: [ID!], $cols: [String!]) { boards(ids: $ids) { items_page(limit: ${ITEM_PAGE_SIZE}) { ${ITEM_FIELDS} } } }`,
    { ids: [boardId], cols },
  );
  let page = first.boards?.[0]?.items_page;
  if (!page) throw new Stopped(`Board ${boardId} returned no items page.`);
  const raw = [...page.items];
  let pages = 1;
  while (page.cursor) {
    if (pages >= MAX_ITEM_PAGES) {
      throw new Stopped(`Board ${boardId} goes past the page cap (${MAX_ITEM_PAGES} pages of ${ITEM_PAGE_SIZE}); the run stopped.`);
    }
    const next = await gql(
      `query ($cursor: String!, $cols: [String!]) { next_items_page(limit: ${ITEM_PAGE_SIZE}, cursor: $cursor) { ${ITEM_FIELDS} } }`,
      { cursor: page.cursor, cols },
    );
    page = next.next_items_page;
    raw.push(...page.items);
    pages += 1;
  }
  return raw.map((item) => {
    const values = {};
    for (const c of item.column_values ?? []) {
      values[c.id] = { text: c.text ?? null, value: c.value ?? null, linked: (c.linked_item_ids ?? []).map(String) };
    }
    for (const id of cols) {
      if (!values[id]) throw new Stopped(`Board ${boardId} item ${item.id}: Monday left out a requested column.`);
    }
    return { id: String(item.id), name: item.name ?? '', values };
  });
}

/** Which wanted columns to create, and which exist under the title with the wrong type. */
export function planColumns(existing, wanted) {
  const create = [];
  const wrongType = [];
  for (const w of wanted) {
    const have = existing.get(w.title);
    if (!have) create.push(w);
    else if (have.type !== w.type) wrongType.push(w.title);
  }
  return { create, wrongType };
}

/** Write a review CSV, only under data/. */
export function writeReview(path, csv, writeFile) {
  assertDataPath(path);
  writeFile(path, csv);
}

async function cmdColumns(args, { gql, out }) {
  const boards = [
    { key: 'organizations', id: args.organizations },
    { key: 'affiliations', id: args.affiliations },
    { key: 'sponsorships', id: args.sponsorships },
  ];
  const plans = [];
  for (const b of boards) plans.push({ ...b, plan: planColumns(await columnsByTitle(gql, b.id), WANTED_COLUMNS[b.key]) });
  const wrong = plans.flatMap((p) => p.plan.wrongType.map((t) => `board ${p.id}: "${t}"`));
  if (wrong.length > 0) throw new CheckFailed(`Column exists with the wrong type, nothing created: ${wrong.join('; ')}.`);
  for (const p of plans) {
    for (const c of p.plan.create) out(`board ${p.id}: create "${c.title}" (${c.type})`);
  }
  const total = plans.reduce((n, p) => n + p.plan.create.length, 0);
  if (!args.apply) {
    out(`DRY RUN: ${total} column(s) to create. Re-run with --apply. Nothing was changed.`);
    return 0;
  }
  for (const p of plans) {
    for (const c of p.plan.create) {
      const defaults = c.type === 'board_relation' ? JSON.stringify({ boardIds: [Number(args.organizations)] }) : null;
      await gql(
        `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
           create_column(board_id: $board, title: $title, column_type: $type, defaults: $defaults) { id }
         }`,
        { board: p.id, title: c.title, type: c.type, defaults },
        { idempotent: false },
      );
    }
  }
  out(`Created ${total} column(s).`);
  return 0;
}

const HANDLERS = { columns: cmdColumns };

export async function run(args, deps) {
  const ctx = {
    out: deps.out,
    err: deps.err ?? deps.out,
    gql: deps.gql,
    readFile: deps.readFile ?? ((p) => readFileSync(p, 'utf8')),
    writeFile: deps.writeFile ?? ((p, s) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, s);
    }),
  };
  try {
    return await HANDLERS[args.command](args, ctx);
  } catch (error) {
    if (error instanceof CheckFailed) {
      ctx.err(`FAIL: ${error.message}`);
      return 1;
    }
    ctx.err(describeFailure(error));
    return 2;
  }
}

async function main() {
  let args;
  const token = process.env.MONDAY_API_TOKEN;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!token) throw new Error('MONDAY_API_TOKEN is not set');
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  const client = new MondayGraphQL(API_URL, token);
  return run(args, {
    gql: (query, variables, options) => client.request(query, variables, options),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
