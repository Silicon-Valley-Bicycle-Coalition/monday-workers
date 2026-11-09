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
import { assertDataPath, buildOrgIndex, ledgerGifts, mapEvent, matchOrg, parseCsv, parseCycles, toCsv } from './lib/sponsor-outreach-setup.mjs';

const ROOT = new URL('..', import.meta.url);
const EVENT_NAMES_PATH = new URL('sponsor-outreach/config/event-names.json', ROOT);
const ROLLUPS_CONFIG_PATH = new URL('donation-rollups/config/svbc.json', ROOT);

/** Cash and in-kind sponsorship Gift Types: donation-rollups' list, not a second copy of it. */
export function sponsorshipGiftTypes(readFile) {
  const s = JSON.parse(readFile(ROLLUPS_CONFIG_PATH)).donationRollups.sponsorships;
  return [...s.giftTypes, ...s.inKindGiftTypes];
}

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
  cycles: { required: ['--organizations', '--donations', '--sponsorships', '--out'], optional: [] },
  'link-pipeline': { required: ['--organizations', '--sponsorships', '--out'], optional: ['--apply'] },
  prospects: { required: ['--organizations', '--input', '--out'], optional: ['--apply'] },
};

const USAGE = `usage: MONDAY_API_TOKEN=... node scripts/sponsor-outreach-setup.mjs <command>
  columns --organizations <id> --affiliations <id> --sponsorships <id> [--apply]
  cycles --organizations <id> --donations <id> --sponsorships <id> --out data/<file>.csv
  link-pipeline --organizations <id> --sponsorships <id> --out data/<file>.csv [--apply]
  prospects --organizations <id> --input data/<Prospects tab>.csv --out data/<file>.csv [--apply]`;

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

/** title (bare) → { id, type, settingsStr } for one board. Two columns with one bare title stop the run. */
export async function columnsByTitle(gql, boardId) {
  const data = await gql(`query ($ids: [ID!]) { boards(ids: $ids) { id columns { id title type settings_str } } }`, { ids: [boardId] });
  const board = data.boards?.[0];
  if (!board) throw new Stopped(`Board ${boardId} not found, or the token can't see it.`);
  const map = new Map();
  for (const c of board.columns ?? []) {
    const title = bareTitle(c.title);
    if (map.has(title)) throw new Stopped(`Board ${boardId} has two columns titled "${title}".`);
    map.set(title, { id: String(c.id), type: c.type, settingsStr: c.settings_str ?? null });
  }
  return map;
}

/** A status column's label texts, from settings_str ({ labels: { "1": "BTWD", … } } or an array). */
export function statusLabels(column) {
  let labels;
  try {
    labels = JSON.parse(column.settingsStr ?? '{}').labels ?? {};
  } catch {
    throw new Stopped('A status column has unreadable settings.');
  }
  const list = Array.isArray(labels) ? labels.map((l) => (typeof l === 'string' ? l : l?.label)) : Object.values(labels);
  return list.filter((l) => typeof l === 'string' && l.trim() !== '');
}

/** Group sponsorship rows by the event text of their Sponsorship Cycle, with the mapped label. */
export function cycleReport(rows, table, sponsorshipGiftTypes) {
  const types = new Set(sponsorshipGiftTypes);
  const groups = new Map();
  let noYear = 0;
  for (const row of rows) {
    if (!types.has((row.giftType ?? '').trim())) continue;
    const parts = parseCycles(row.cycle);
    if (parts.length === 0) {
      noYear += 1;
      continue;
    }
    for (const parsed of parts) {
      const key = parsed.event.replace(/\s+/g, ' ').toLowerCase();
      const g = groups.get(key) ?? { event: parsed.event, label: mapEvent(parsed.event, table), years: new Set(), count: 0 };
      g.years.add(parsed.year);
      g.count += 1;
      groups.set(key, g);
    }
  }
  const byEvent = [...groups.values()]
    .map((g) => ({ event: g.event, label: g.label, years: [...g.years].sort((a, b) => a - b), count: g.count }))
    .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));
  return { byEvent, noYear };
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

const IDS_CHUNK = 100;

/**
 * Items by id, archived ones included (items_page skips those; items(ids:) doesn't). An archived
 * item's board_relation cells read empty, so only use this for text-like columns.
 */
export async function readItemsByIds(gql, ids, cols) {
  const out = [];
  for (let i = 0; i < ids.length; i += IDS_CHUNK) {
    const chunk = ids.slice(i, i + IDS_CHUNK);
    const data = await gql(
      `query ($ids: [ID!], $cols: [String!]) { items(ids: $ids, limit: ${IDS_CHUNK}) { id name column_values(ids: $cols) { id text value } } }`,
      { ids: chunk, cols },
    );
    for (const item of data.items ?? []) {
      const values = {};
      for (const c of item.column_values ?? []) values[c.id] = { text: c.text ?? null, value: c.value ?? null, linked: [] };
      out.push({ id: String(item.id), name: item.name ?? '', values });
    }
  }
  return out;
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

/**
 * giftItemId → { orgId, ...gift } for every sponsorship gift on any Organization's 🔒 Gift Ledger
 * (JSON). The ledger comes from donation-rollups' D1 ledger, so archived gifts are included.
 */
export async function organizationSponsorshipGifts(gql, organizationsBoard, types) {
  const cols = await columnsByTitle(gql, organizationsBoard);
  const ledger = needColumn(cols, organizationsBoard, 'Gift Ledger (JSON)');
  const orgs = await readItems(gql, organizationsBoard, [ledger.id]);
  const gifts = new Map();
  for (const org of orgs) {
    for (const g of ledgerGifts(org.values[ledger.id].text, types)) gifts.set(g.itemId, { orgId: org.id, ...g });
  }
  return gifts;
}

async function cmdCycles(args, ctx) {
  const { gql, out } = ctx;
  const types = sponsorshipGiftTypes(ctx.readFile);
  const gifts = await organizationSponsorshipGifts(gql, args.organizations, types);
  const donCols = await columnsByTitle(gql, args.donations);
  const cycle = needColumn(donCols, args.donations, 'Sponsorship Cycle');
  const spCols = await columnsByTitle(gql, args.sponsorships);
  const boardLabels = new Set(statusLabels(needColumn(spCols, args.sponsorships, 'Event')));
  const items = await readItemsByIds(gql, [...gifts.keys()], [cycle.id]);
  const rows = items.map((it) => ({ giftType: gifts.get(it.id).type, cycle: it.values[cycle.id]?.text ?? null }));
  const missing = gifts.size - items.length;
  const report = cycleReport(rows, ctx.eventNames(), types);
  for (const e of report.byEvent) if (e.label !== null && !boardLabels.has(e.label)) e.label = null;
  const unmapped = report.byEvent.filter((e) => e.label === null);
  writeReview(
    args.out,
    toCsv(['Event', 'Label', 'Years', 'Count'], report.byEvent.map((e) => [e.event, e.label ?? '', e.years.join(' '), String(e.count)])),
    ctx.writeFile,
  );
  out(`${report.byEvent.length} event name(s) across ${report.byEvent.reduce((n, e) => n + e.count, 0)} sponsorship(s); ${unmapped.length} unmapped; ${report.noYear} with no year in Sponsorship Cycle.`);
  out(`Read ${items.length} of ${gifts.size} ledgered sponsorship gift(s), archived included; ${missing} no longer exist in Monday.`);
  out('Wrote the list to the --out file.');
  if (unmapped.length > 0) throw new CheckFailed(`${unmapped.length} event name(s) don't map to a Sponsorships Event label; see the --out file.`);
  return 0;
}

/** Which Sponsorships items to link to which Organization: item name first, then Employer. */
export function planPipelineLinks(items, index) {
  const link = [];
  const review = [];
  let already = 0;
  for (const item of items) {
    if (item.linked.length > 0) {
      already += 1;
      continue;
    }
    const m = matchOrg(index, item.name, item.employer);
    if (m.status === 'matched') link.push({ itemId: item.id, orgId: m.orgId });
    else review.push({ itemId: item.id, reason: m.status, candidates: m.candidates ?? [] });
  }
  return { link, review, already };
}

/** The organization index from every Organizations item's name, plus Salesforce ID → item id. */
async function organizationIndex(gql, organizationsBoard) {
  const sf = needColumn(await columnsByTitle(gql, organizationsBoard), organizationsBoard, 'Salesforce ID');
  const orgs = await readItems(gql, organizationsBoard, [sf.id]);
  const bySfId = new Map();
  for (const o of orgs) if (o.values[sf.id].text) bySfId.set(o.values[sf.id].text.trim(), o.id);
  return { index: buildOrgIndex(orgs.map((o) => ({ id: o.id, name: o.name }))), count: orgs.length, bySfId };
}

/** A column that may not exist yet: a dry run proceeds without it, --apply stops. */
function optionalColumn(columns, boardId, title, apply) {
  const col = columns.get(title);
  if (!col && apply) throw new Stopped(`Board ${boardId} has no "${title}" column. Run the columns command with --apply first.`);
  return col ?? null;
}

const itemLink = (boardId, itemId) => `https://bikesiliconvalley.monday.com/boards/${boardId}/pulses/${itemId}`;

async function setColumnValues(gql, boardId, itemId, values) {
  await gql(
    `mutation ($board: ID!, $item: ID!, $values: JSON!) {
       change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values) { id }
     }`,
    { board: boardId, item: itemId, values: JSON.stringify(values) },
  );
}

async function cmdLinkPipeline(args, ctx) {
  const { gql, out } = ctx;
  const cols = await columnsByTitle(gql, args.sponsorships);
  const employer = needColumn(cols, args.sponsorships, 'Employer');
  const orgCol = optionalColumn(cols, args.sponsorships, 'Organization', args.apply);
  const { index, count } = await organizationIndex(gql, args.organizations);
  const items = await readItems(gql, args.sponsorships, orgCol ? [employer.id, orgCol.id] : [employer.id]);
  const plan = planPipelineLinks(
    items.map((it) => ({ id: it.id, name: it.name, employer: it.values[employer.id].text, linked: orgCol ? it.values[orgCol.id].linked : [] })),
    index,
  );
  const byId = new Map(items.map((it) => [it.id, it]));
  writeReview(
    args.out,
    toCsv(
      ['Item ID', 'Monday Link', 'Item Name', 'Employer', 'Reason', 'Candidate Organization IDs'],
      plan.review.map((r) => [r.itemId, itemLink(args.sponsorships, r.itemId), byId.get(r.itemId).name, byId.get(r.itemId).values[employer.id].text ?? '', r.reason, r.candidates.join(' ')]),
    ),
    ctx.writeFile,
  );
  out(`${items.length} Sponsorships item(s) against ${count} Organization(s): ${plan.link.length} to link, ${plan.already} already linked, ${plan.review.length} for review. ${ARCHIVED_NOTE}`);
  if (!args.apply) {
    out(`DRY RUN${orgCol ? '' : ' (the Organization column doesn\'t exist yet)'}: nothing was changed.`);
  } else {
    for (const l of plan.link) await setColumnValues(gql, args.sponsorships, l.itemId, { [orgCol.id]: { item_ids: [Number(l.orgId)] } });
    out(`Linked ${plan.link.length} item(s).`);
  }
  if (plan.review.length > 0) throw new CheckFailed(`${plan.review.length} item(s) need review; see the --out file.`);
  return 0;
}

export const PROSPECT_HEADERS = { company: 'Company', notes: 'Notes for Outreach (EX: Hold or Remove etc)' };

/** Rows of a CSV as objects keyed by header (trimmed). A required header that's missing stops the run. */
export function csvRecords(text, required) {
  const [header = [], ...rows] = parseCsv(text);
  const keys = header.map((h) => h.trim());
  for (const r of required) if (!keys.includes(r)) throw new Stopped(`The input CSV has no "${r}" column.`);
  return rows.map((row) => Object.fromEntries(keys.map((k, i) => [k, row[i] ?? ''])));
}

/** Which Organizations to mark Sponsor Prospect, with notes only where none exist yet. */
export function planProspects(rows, index, current) {
  const set = [];
  const review = [];
  let already = 0;
  const seen = new Set();
  for (const { company, notes } of rows) {
    if (!company.trim()) continue;
    if (/remove/i.test(notes)) {
      review.push({ company, reason: 'marked remove', candidates: [] });
      continue;
    }
    const m = matchOrg(index, company);
    if (m.status !== 'matched') {
      review.push({ company, reason: m.status, candidates: m.candidates ?? [] });
      continue;
    }
    if (seen.has(m.orgId)) continue;
    seen.add(m.orgId);
    const now = current.get(m.orgId) ?? { prospect: false, notes: '' };
    if (now.prospect) {
      already += 1;
      continue;
    }
    set.push({ orgId: m.orgId, notes: now.notes.trim() || !notes.trim() ? null : notes.trim() });
  }
  return { set, review, already };
}

const checked = (cell) => cell?.text === 'v' || /"checked"\s*:\s*"?true/.test(cell?.value ?? '');

async function cmdProspects(args, ctx) {
  const { gql, out } = ctx;
  const records = csvRecords(ctx.readFile(args.input), [PROSPECT_HEADERS.company, PROSPECT_HEADERS.notes]);
  const cols = await columnsByTitle(gql, args.organizations);
  const prospect = optionalColumn(cols, args.organizations, 'Sponsor Prospect', args.apply);
  const notesCol = optionalColumn(cols, args.organizations, 'Prospect Notes', args.apply);
  const { index, count } = await organizationIndex(gql, args.organizations);
  const current = new Map();
  if (prospect && notesCol) {
    for (const o of await readItems(gql, args.organizations, [prospect.id, notesCol.id])) {
      current.set(o.id, { prospect: checked(o.values[prospect.id]), notes: o.values[notesCol.id].text ?? '' });
    }
  }
  const plan = planProspects(
    records.map((r) => ({ company: r[PROSPECT_HEADERS.company], notes: r[PROSPECT_HEADERS.notes] })),
    index,
    current,
  );
  writeReview(
    args.out,
    toCsv(['Company', 'Reason', 'Candidate Organization IDs'], plan.review.map((r) => [r.company, r.reason, r.candidates.join(' ')])),
    ctx.writeFile,
  );
  out(`${records.length} row(s) against ${count} Organization(s): ${plan.set.length} to mark, ${plan.already} already marked, ${plan.review.length} for review.`);
  if (!args.apply) {
    out('DRY RUN: nothing was changed.');
  } else {
    for (const s of plan.set) {
      const values = { [prospect.id]: { checked: 'true' } };
      if (s.notes !== null) values[notesCol.id] = s.notes;
      await setColumnValues(gql, args.organizations, s.orgId, values);
    }
    out(`Marked ${plan.set.length} Organization(s).`);
  }
  if (plan.review.length > 0) throw new CheckFailed(`${plan.review.length} row(s) need review; see the --out file.`);
  return 0;
}

const HANDLERS = { columns: cmdColumns, cycles: cmdCycles, 'link-pipeline': cmdLinkPipeline, prospects: cmdProspects };

export async function run(args, deps) {
  const ctx = {
    out: deps.out,
    err: deps.err ?? deps.out,
    gql: deps.gql,
    readFile: deps.readFile ?? ((p) => readFileSync(p, 'utf8')),
    eventNames: () => deps.eventNames ?? JSON.parse(readFileSync(EVENT_NAMES_PATH, 'utf8')).eventNames,
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
