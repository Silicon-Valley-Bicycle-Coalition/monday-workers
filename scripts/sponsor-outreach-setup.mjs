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

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MondayApiError, MondayGraphQL } from '../monday-backup/src/monday/graphql.ts';
import { bareTitle } from './lib/column-titles.mjs';
import { assertDataPath, buildOrgIndex, ledgerGifts, mapEvent, matchOrg, parseCsv, parseCycles, splitEmails, toCsv } from './lib/sponsor-outreach-setup.mjs';

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
  contacts: {
    required: ['--organizations', '--affiliations', '--people', '--historical', '--sponsorships', '--dir', '--out'],
    optional: ['--apply'],
  },
};

const USAGE = `usage: MONDAY_API_TOKEN=... node scripts/sponsor-outreach-setup.mjs <command>
  columns --organizations <id> --affiliations <id> --sponsorships <id> [--apply]
  cycles --organizations <id> --donations <id> --sponsorships <id> --out data/<file>.csv
  link-pipeline --organizations <id> --sponsorships <id> --out data/<file>.csv [--apply]
  prospects --organizations <id> --input data/<Prospects tab>.csv --out data/<file>.csv [--apply]
  contacts --organizations <id> --affiliations <id> --people <id> --historical <id> --sponsorships <id>
           --dir data/sponsor-outreach --out data/<file>.csv [--apply]`;

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

/**
 * Ids an earlier --apply of this command already wrote, kept beside --out. A later --apply skips
 * them, so it never re-ticks a box or re-links an item Martha has since undone by hand.
 */
function appliedLedger(ctx, args) {
  const path = join(dirname(args.out), `applied-${args.command}.json`);
  let ids = [];
  try {
    ids = JSON.parse(ctx.readFile(path));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Stopped(`Can't read the applied ledger beside --out (applied-${args.command}.json).`);
  }
  const done = new Set(ids.map(String));
  return {
    has: (id) => done.has(String(id)),
    record: (id) => {
      done.add(String(id));
      writeReview(path, JSON.stringify([...done]), ctx.writeFile);
    },
  };
}

/** Write each planned id that an earlier --apply hasn't, recording it once Monday accepts. */
async function applyEach(ctx, args, ids, write) {
  const ledger = appliedLedger(ctx, args);
  let written = 0;
  let skipped = 0;
  for (const id of ids) {
    if (ledger.has(id)) {
      skipped += 1;
      continue;
    }
    await write(id);
    ledger.record(id);
    written += 1;
  }
  return { written, skipped };
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
    const orgOf = new Map(plan.link.map((l) => [l.itemId, l.orgId]));
    const r = await applyEach(ctx, args, [...orgOf.keys()], (itemId) =>
      setColumnValues(gql, args.sponsorships, itemId, { [orgCol.id]: { item_ids: [Number(orgOf.get(itemId))] } }));
    out(`Linked ${r.written} item(s); ${r.skipped} skipped because an earlier --apply already linked them.`);
  }
  if (plan.review.length > 0) throw new CheckFailed(`${plan.review.length} item(s) need review; see the --out file.`);
  return 0;
}


// The Prospects tab's two layouts: the original hand-built one, and the Salesforce-report layout
// Martha rebuilt it in on 2026-11-16 (Sponsorship Cycle, Account Name, notes, Contact: Email).
const PROSPECT_LAYOUTS = [
  { company: 'company', notes: 'notes for outreach (ex: hold or remove etc)' },
  { company: 'account name', notes: 'notes' },
];

/** The Prospects tab as { company, notes } rows, in either layout. Neither layout stops the run. */
export function prospectRecords(text) {
  const [header = [], ...rows] = parseCsv(text);
  const keys = header.map((h) => h.trim().toLowerCase());
  const layout = PROSPECT_LAYOUTS.find((l) => keys.includes(l.company) && keys.includes(l.notes));
  if (!layout) throw new Stopped('The Prospects CSV has neither Company + Notes for Outreach nor Account Name + notes columns.');
  const ci = keys.indexOf(layout.company);
  const ni = keys.indexOf(layout.notes);
  return rows.map((r) => ({ company: r[ci] ?? '', notes: r[ni] ?? '' }));
}

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
    const fillNotes = !now.notes.trim() && notes.trim() ? notes.trim() : null;
    if (now.prospect) {
      if (fillNotes) set.push({ orgId: m.orgId, notes: fillNotes, notesOnly: true });
      else already += 1;
      continue;
    }
    set.push({ orgId: m.orgId, notes: fillNotes });
  }
  return { set, review, already };
}

const checked = (cell) => cell?.text === 'v' || /"checked"\s*:\s*"?true/.test(cell?.value ?? '');

async function cmdProspects(args, ctx) {
  const { gql, out } = ctx;
  const records = prospectRecords(ctx.readFile(args.input));
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
  const plan = planProspects(records, index, current);
  writeReview(
    args.out,
    toCsv(['Company', 'Reason', 'Candidate Organization IDs'], plan.review.map((r) => [r.company, r.reason, r.candidates.join(' ')])),
    ctx.writeFile,
  );
  const notesOnly = plan.set.filter((x) => x.notesOnly).length;
  out(`${records.length} row(s) against ${count} Organization(s): ${plan.set.length - notesOnly} to mark, ${notesOnly} already marked whose empty notes the sheet fills, ${plan.already} already marked, ${plan.review.length} for review.`);
  if (records.length > 0 && records.every((r) => !r.notes.trim())) {
    out('Warning: every Notes cell in the input is blank. If the tab has notes, re-export it with File → Download → CSV.');
  }
  if (!args.apply) {
    out('DRY RUN: nothing was changed.');
  } else {
    const byOrg = new Map(plan.set.map((x) => [x.orgId, x]));
    const r = await applyEach(ctx, { ...args, command: 'prospects' }, [...byOrg.keys()], (orgId) => {
      const x = byOrg.get(orgId);
      const values = x.notesOnly ? {} : { [prospect.id]: { checked: 'true' } };
      if (x.notes !== null) values[notesCol.id] = x.notes;
      return setColumnValues(gql, args.organizations, orgId, values);
    });
    out(`Wrote ${r.written} Organization(s); ${r.skipped} skipped because an earlier --apply already wrote them.`);
  }
  if (plan.review.length > 0) throw new CheckFailed(`${plan.review.length} row(s) need review; see the --out file.`);
  return 0;
}

/**
 * Which Affiliations to tick Sponsor Contact. Sources are Salesforce sponsorship primary contacts
 * ({ kind: 'salesforce', personSfId, orgSfId }) and addresses ({ kind: 'email', email, orgId? }).
 * Only a Current affiliation is ever ticked; everything else is a review row with its reason.
 */
export function planContacts(sources, affiliations, people, orgsBySfId) {
  const personBySfId = new Map();
  const personsByEmail = new Map();
  for (const [id, p] of people) {
    if (p.sfId) personBySfId.set(p.sfId, id);
    for (const e of p.emails) personsByEmail.set(e, [...(personsByEmail.get(e) ?? []), id]);
  }
  const tick = [];
  const alreadySeen = new Set();
  const review = [];
  const choose = (affs, source, key) => {
    const current = affs.filter((a) => a.status === 'Current');
    if (current.length === 0) {
      review.push({ source, key, reason: affs.length > 0 ? 'former only' : 'no current affiliation' });
      return;
    }
    for (const a of current) {
      if (a.sponsorContact) alreadySeen.add(a.id);
      else if (!tick.includes(a.id)) tick.push(a.id);
    }
  };
  const at = (personId, orgId) => affiliations.filter((a) => a.personId === personId && a.orgId === orgId);
  for (const src of sources) {
    if (src.kind === 'salesforce') {
      const personId = personBySfId.get(src.personSfId);
      const orgId = orgsBySfId.get(src.orgSfId);
      if (!personId) review.push({ source: 'salesforce', key: src.personSfId, reason: 'no person' });
      else if (!orgId) review.push({ source: 'salesforce', key: src.personSfId, reason: 'no organization' });
      else choose(at(personId, orgId), 'salesforce', src.personSfId);
      continue;
    }
    const byWork = affiliations.filter((a) => a.workEmail === src.email);
    if (new Set(byWork.filter((a) => a.status === 'Current').map((a) => a.personId)).size > 1) {
      review.push({ source: 'email', key: src.email, reason: 'several people share this email' });
      continue;
    }
    if (byWork.length > 0) {
      choose(byWork, 'email', src.email);
      continue;
    }
    const persons = [...new Set(personsByEmail.get(src.email) ?? [])];
    if (persons.length === 0) review.push({ source: 'email', key: src.email, reason: 'no person' });
    else if (persons.length > 1) review.push({ source: 'email', key: src.email, reason: 'several people share this email' });
    else if (!src.orgId) review.push({ source: 'email', key: src.email, reason: 'no organization' });
    else choose(at(persons[0], src.orgId), 'email', src.email);
  }
  const seen = new Set();
  const unique = review.filter((r) => {
    const k = `${r.source}\u0000${r.key}\u0000${r.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { tick, review: unique, already: alreadySeen.size };
}

// Sheet columns that may hold contact addresses, and the ones that name the company (any case).
const SHEET_EMAIL_HEADERS = ['email', 'email address', 'contact: email', 'other contacts', 'additional contact names'];
const SHEET_COMPANY_HEADERS = ['company', 'account name', 'name of your organization, business, or advocacy group:'];

// Salesforce ids compare on their case-sensitive 15-character form (an 18-character id adds a
// checksum), so an export and the migrated 📜 Salesforce ID agree whichever length each kept.
const sf15 = (id) => String(id ?? '').trim().slice(0, 15);

/** An email column's address, from its JSON value (its text can carry a display label). */
function emailOf(cell) {
  try {
    const v = JSON.parse(cell?.value ?? 'null');
    if (v?.email) return String(v.email).trim().toLowerCase();
  } catch {
    // fall through to the text
  }
  return splitEmails(cell?.text)[0] ?? null;
}

/** Person id → { sfId, emails, dns, boardId } across the People and Historical boards. */
async function readPeople(gql, boardIds) {
  const people = new Map();
  for (const boardId of boardIds) {
    const cols = await columnsByTitle(gql, boardId);
    const sf = needColumn(cols, boardId, 'Salesforce ID');
    const dns = needColumn(cols, boardId, 'Do Not Solicit');
    const emailCols = [...cols.values()].filter((c) => c.type === 'email').map((c) => c.id);
    for (const p of await readItems(gql, boardId, [sf.id, dns.id, ...emailCols])) {
      people.set(p.id, {
        sfId: sf15(p.values[sf.id].text) || null,
        emails: emailCols.map((c) => emailOf(p.values[c])).filter(Boolean),
        dns: checked(p.values[dns.id]),
        boardId,
      });
    }
  }
  return people;
}

/**
 * Email sources from every sheet tab exported under <dir>/sheet/. Each tab gets a console line
 * (its file name and address count, or why it was skipped), so a missing tab is visible. A missing
 * sheet/ directory, or one with no CSV, stops the run.
 */
export function sheetSources(ctx, dir, index) {
  const sources = [];
  const sheetDir = join(dir, 'sheet');
  let names;
  try {
    names = ctx.listDir(sheetDir).filter((n) => n.endsWith('.csv')).sort();
  } catch {
    throw new Stopped(`No sheet/ directory under --dir. Export each tab of the sponsor list there first.`);
  }
  if (names.length === 0) throw new Stopped('The sheet/ directory under --dir holds no .csv files.');
  for (const name of names) {
    const [header = [], ...rows] = parseCsv(ctx.readFile(join(sheetDir, name)));
    const keys = header.map((h) => h.trim().toLowerCase());
    const emailIdx = keys.map((k, i) => (SHEET_EMAIL_HEADERS.includes(k) ? i : -1)).filter((i) => i >= 0);
    if (emailIdx.length === 0) {
      ctx.out(`  sheet ${name}: skipped, no email column`);
      continue;
    }
    const companyIdx = keys.findIndex((k) => SHEET_COMPANY_HEADERS.includes(k));
    let n = 0;
    for (const row of rows) {
      const m = companyIdx >= 0 ? matchOrg(index, row[companyIdx]) : { status: 'unmatched' };
      for (const i of emailIdx) {
        for (const email of splitEmails(row[i])) {
          sources.push({ kind: 'email', email, orgId: m.status === 'matched' ? m.orgId : undefined });
          n += 1;
        }
      }
    }
    ctx.out(`  sheet ${name}: ${n} address(es)${companyIdx >= 0 ? '' : ', no company column'}`);
  }
  return sources;
}

async function cmdContacts(args, ctx) {
  const { gql, out } = ctx;
  const { index, bySfId } = await organizationIndex(gql, args.organizations);
  const orgsBySfId = new Map([...bySfId].map(([k, v]) => [sf15(k), v]));

  const aCols = await columnsByTitle(gql, args.affiliations);
  const status = needColumn(aCols, args.affiliations, 'Status');
  const work = needColumn(aCols, args.affiliations, 'Work Email');
  const person = needColumn(aCols, args.affiliations, 'Person');
  const org = needColumn(aCols, args.affiliations, 'Organization');
  const sc = optionalColumn(aCols, args.affiliations, 'Sponsor Contact', args.apply);
  const affiliations = (await readItems(gql, args.affiliations, [status.id, work.id, person.id, org.id, ...(sc ? [sc.id] : [])])).map((a) => ({
    id: a.id,
    personId: a.values[person.id].linked[0] ?? null,
    orgId: a.values[org.id].linked[0] ?? null,
    status: a.values[status.id].text,
    workEmail: emailOf(a.values[work.id]),
    sponsorContact: sc ? checked(a.values[sc.id]) : false,
  }));
  const people = await readPeople(gql, [args.people, args.historical]);

  const sources = [];
  for (const r of csvRecords(ctx.readFile(join(args.dir, 'sf-primary-contacts.csv')), ['npsp__Primary_Contact__c', 'AccountId'])) {
    sources.push({ kind: 'salesforce', personSfId: sf15(r.npsp__Primary_Contact__c), orgSfId: sf15(r.AccountId) });
  }
  sources.push(...sheetSources(ctx, args.dir, index));
  const spCols = await columnsByTitle(gql, args.sponsorships);
  const spEmail = needColumn(spCols, args.sponsorships, 'Email');
  const spOrg = spCols.get('Organization') ?? null;
  for (const it of await readItems(gql, args.sponsorships, [spEmail.id, ...(spOrg ? [spOrg.id] : [])])) {
    const orgId = spOrg ? it.values[spOrg.id].linked[0] : undefined;
    for (const email of splitEmails(it.values[spEmail.id].text)) sources.push({ kind: 'email', email, orgId });
  }

  const plan = planContacts(sources, affiliations, people, orgsBySfId);
  writeReview(args.out, toCsv(['Source', 'Salesforce ID or Email', 'Reason'], plan.review.map((r) => [r.source, r.key, r.reason])), ctx.writeFile);

  const optOut = csvRecords(ctx.readFile(join(args.dir, 'sf-fundraise-opt-out.csv')), ['Id']).map((r) => r.Id.trim());
  const bySf = new Map([...people].filter(([, p]) => p.sfId).map(([id, p]) => [p.sfId, { id, ...p }]));
  writeReview(
    join(dirname(args.out), 'fundraise-opt-out.csv'),
    toCsv(
      ['People Item ID', 'Monday Link', 'Do Not Solicit', 'Salesforce ID'],
      optOut.map((id) => {
        const p = bySf.get(sf15(id));
        return p ? [p.id, itemLink(p.boardId, p.id), p.dns ? 'yes' : 'no', id] : ['', '', 'not in Monday', id];
      }),
    ),
    ctx.writeFile,
  );

  out(`${sources.length} contact source(s) against ${affiliations.length} Affiliation(s): ${plan.tick.length} to tick, ${plan.already} already ticked, ${plan.review.length} for review. ${ARCHIVED_NOTE}`);
  out(`Fundraise Opt Out: ${optOut.length} contact(s) listed in fundraise-opt-out.csv; nothing is written for them.`);
  if (!args.apply) {
    out(`DRY RUN${sc ? '' : " (the Sponsor Contact column doesn't exist yet)"}: nothing was changed.`);
  } else {
    const r = await applyEach(ctx, args, plan.tick, (id) => setColumnValues(gql, args.affiliations, id, { [sc.id]: { checked: 'true' } }));
    out(`Ticked ${r.written} Affiliation(s); ${r.skipped} skipped because an earlier --apply already ticked them.`);
  }
  if (plan.review.length > 0) throw new CheckFailed(`${plan.review.length} source(s) need review; see the --out file.`);
  return 0;
}

const HANDLERS = { columns: cmdColumns, cycles: cmdCycles, 'link-pipeline': cmdLinkPipeline, prospects: cmdProspects, contacts: cmdContacts };

export async function run(args, deps) {
  const ctx = {
    out: deps.out,
    err: deps.err ?? deps.out,
    gql: deps.gql,
    readFile: deps.readFile ?? ((p) => readFileSync(p, 'utf8')),
    listDir: deps.listDir ?? ((p) => readdirSync(p)),
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
