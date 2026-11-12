#!/usr/bin/env node
// One-time backfill: proposes roles into Affiliations' `Proposed Roles` from existing data. Staff
// confirm by moving a label into `SVBC Roles`; a proposal never takes effect on its own.
//   - Affiliations `Sponsor Contact` checkbox      -> Sponsorship on that same affiliation
//   - BP Request Form `Contact (People)` at the board's org column     -> Bike Parking
//   - Grants & Contracts `Funder Contact` at the board's org column    -> Grants
//   - Sponsorships `Primary Contact` (only if it is a People link)     -> Sponsorship
//   - Affiliations `Grant/Contract Contact` checkbox -> Grants on that same affiliation
// Only Current affiliations get proposals; nothing is created; SVBC Roles is never written.
// Dry run by default; --execute writes Proposed Roles only (merged with the labels already there).
// Prints counts only (no names, no emails) and writes an ids-only JSON report outside the repo.
//
//   MONDAY_API_TOKEN=... node contact-roles/scripts/backfill-proposed-roles.mjs --env sandbox [--report <file>]
//   MONDAY_API_TOKEN=... node contact-roles/scripts/backfill-proposed-roles.mjs --env production --execute
//
// Exit 0: done. Exit 2: usage or API error.

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bareTitle } from '../../scripts/lib/column-titles.mjs';
import { MondayGraphQL } from '../src/monday/graphql.ts';
import { planProposals, buildWrites, summarize } from './backfill-lib.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Board sources. `rule` names the entry in config.boards (board id, role, org column); `person` is
// the column holding the contact; `orgFallbacks` are tried when the configured org column is absent.
export const BOARD_SOURCES = [
  { from: 'bp-request', rule: 'BP Request Form', person: 'Contact (People)', orgFallbacks: [] },
  { from: 'grants', rule: 'Grants & Contracts', person: 'Funder Contact', orgFallbacks: ['Grant Provider'] },
  { from: 'sponsorships', rule: 'Sponsorships', person: 'Primary Contact', orgFallbacks: [] },
];
// Affiliations checkbox sources: a checked box proposes the role on that same affiliation.
export const CHECKBOX_SOURCES = [
  { from: 'sponsor-contact', title: 'Sponsor Contact', role: 'Sponsorship' },
  { from: 'grant-contract-contact', title: 'Grant/Contract Contact', role: 'Grants' },
];
export const PROPOSED_TITLE = 'Proposed Roles';

export function parseArgs(argv, now = Date.now()) {
  const args = { env: null, execute: false, report: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--env': args.env = argv[++i] ?? null; break;
      case '--execute': args.execute = true; break;
      case '--report': args.report = argv[++i] ?? null; break;
      default: throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (args.env === null) throw new Error('--env sandbox|production is required');
  if (args.env !== 'sandbox' && args.env !== 'production') throw new Error('--env must be sandbox or production');
  args.report ??= join(tmpdir(), `backfill-proposed-roles-${args.env}-${now}.json`);
  return args;
}

// The report holds ids; it must never land in the repo, where it could be committed.
export function assertOutsideRepo(file, root = REPO_ROOT) {
  const rel = relative(resolve(root), resolve(file));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('--report must be outside the repository');
}

const BOARD_COLUMNS = `query ($ids: [ID!]) { boards(ids: $ids) { id columns { id title type } } }`;
const VALUES = 'column_values(ids: $columnIds) { id text ... on BoardRelationValue { linked_item_ids } ... on DropdownValue { values { label } } ... on CheckboxValue { checked } }';
const FIRST = `query ($board: [ID!], $columnIds: [String!]) { boards(ids: $board) { items_page(limit: 500) { cursor items { id ${VALUES} } } } }`;
const NEXT = `query ($cursor: String!, $columnIds: [String!]) { next_items_page(limit: 500, cursor: $cursor) { cursor items { id ${VALUES} } } }`;
const WRITE = `mutation ($board: ID!, $item: ID!, $values: JSON!) { change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values) { id } }`;

async function pageAll(gql, boardId, columnIds) {
  const first = await gql.request(FIRST, { board: [boardId], columnIds });
  let page = first.boards[0]?.items_page ?? { cursor: null, items: [] };
  const items = [...page.items];
  while (page.cursor) {
    page = (await gql.request(NEXT, { cursor: page.cursor, columnIds })).next_items_page;
    items.push(...page.items);
  }
  return items;
}

const find = (cols, title) => cols.find((c) => bareTitle(c.title) === bareTitle(title));
const linked = (cv) => (cv?.linked_item_ids ?? []).map(String);
const cvMap = (item) => new Map(item.column_values.map((cv) => [cv.id, cv]));

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    assertOutsideRepo(args.report);
  } catch (e) {
    console.error(`${e.message}\nusage: MONDAY_API_TOKEN=... node contact-roles/scripts/backfill-proposed-roles.mjs --env sandbox|production [--execute] [--report <file>]`);
    return 2;
  }
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    console.error('MONDAY_API_TOKEN is not set');
    return 2;
  }
  const file = args.env === 'sandbox' ? 'sandbox.json' : 'svbc.json';
  const config = JSON.parse(readFileSync(fileURLToPath(new URL(`../config/${file}`, import.meta.url)), 'utf8'));
  const gql = new MondayGraphQL(config.monday.apiUrl, token);
  const aff = config.affiliations;
  const notes = [];

  const boardIds = [aff.boardId, ...BOARD_SOURCES.map((s) => config.boards.find((b) => b.name === s.rule)?.boardId).filter(Boolean)];
  const colsByBoard = new Map((await gql.request(BOARD_COLUMNS, { ids: boardIds })).boards.map((b) => [String(b.id), b.columns]));

  // Affiliations
  const affCols = colsByBoard.get(String(aff.boardId));
  if (!affCols) throw new Error('Affiliations board not found');
  const need = (title) => {
    const c = find(affCols, title);
    if (!c) throw new Error(`Affiliations: no column titled "${title}"`);
    return c.id;
  };
  const personId = need(aff.personColumn);
  const orgId = need(aff.orgColumn);
  const statusId = need(aff.statusColumn);
  const stats = {}; // per source: { read, skipped }
  const checkboxes = CHECKBOX_SOURCES.map((c) => {
    const col = find(affCols, c.title);
    stats[c.from] = { read: 0, skipped: col ? null : `no "${c.title}" column on Affiliations` };
    return { ...c, id: col?.id ?? null };
  });
  const rolesId = find(affCols, aff.rolesColumn)?.id ?? null;
  const proposedId = find(affCols, PROPOSED_TITLE)?.id ?? null;
  if (rolesId === null || proposedId === null) {
    if (args.execute) throw new Error(`Affiliations needs "${aff.rolesColumn}" and "${PROPOSED_TITLE}"; run provision-contact-roles.mjs first`);
    notes.push(`Affiliations lacks "${aff.rolesColumn}" and/or "${PROPOSED_TITLE}" (not provisioned): treated as empty`);
  }
  const affColumnIds = [personId, orgId, statusId, ...checkboxes.map((c) => c.id), rolesId, proposedId].filter(Boolean);
  const affItems = await pageAll(gql, aff.boardId, affColumnIds);

  const affiliations = [];
  const sources = [];
  let withoutLinks = 0;
  for (const item of affItems) {
    const by = cvMap(item);
    const p = linked(by.get(personId))[0];
    const o = linked(by.get(orgId))[0];
    if (p === undefined || o === undefined) {
      withoutLinks++;
      continue;
    }
    const a = {
      id: String(item.id), personId: p, orgId: o, status: by.get(statusId)?.text ?? '',
      roles: (by.get(rolesId)?.values ?? []).map((v) => v.label),
      proposed: (by.get(proposedId)?.values ?? []).map((v) => v.label),
    };
    affiliations.push(a);
    for (const c of checkboxes) {
      if (c.id === null || by.get(c.id)?.checked !== true) continue;
      stats[c.from].read++;
      sources.push({ role: c.role, orgId: o, personId: p, from: c.from, affiliationId: a.id });
    }
  }

  // Board sources
  for (const s of BOARD_SOURCES) {
    const rule = config.boards.find((b) => b.name === s.rule);
    const cols = rule ? colsByBoard.get(String(rule.boardId)) : null;
    stats[s.from] = { read: 0, skipped: null };
    const skip = (why) => { stats[s.from].skipped = why; };
    if (!rule || !cols) { skip('board not found'); continue; }
    const person = find(cols, s.person);
    const org = [rule.orgColumn, ...s.orgFallbacks].map((t) => find(cols, t)).find(Boolean);
    if (!person) { skip(`no "${s.person}" column on the board`); continue; }
    if (!org) { skip('no organization link column'); continue; }
    if (org.title !== rule.orgColumn) notes.push(`${s.from}: used org column "${org.title}", not configured "${rule.orgColumn}"`);
    const isLink = person.type === 'board_relation';
    if (!isLink) notes.push(`${s.from}: "${person.title}" is ${person.type}, not a People link: items report no-person-link`);
    for (const item of await pageAll(gql, rule.boardId, [person.id, org.id])) {
      const by = cvMap(item);
      const orgs = linked(by.get(org.id));
      const people = isLink ? linked(by.get(person.id)) : (by.get(person.id)?.text ? [''] : []);
      for (const o of orgs) for (const p of people) stats[s.from].read++;
      for (const o of orgs) for (const p of people) sources.push({ role: rule.role, orgId: o, personId: p, from: s.from });
    }
  }

  const plan = planProposals({ affiliations, sources }, { currentLabel: aff.currentLabel });
  const writes = buildWrites(affiliations, plan.proposals);
  const summary = summarize(plan);

  console.log(`${args.execute ? 'EXECUTE' : 'DRY RUN'} (${args.env})`);
  console.log(`affiliations read: ${affItems.length} (${affiliations.length} usable, ${withoutLinks} without a person or organization link)`);
  console.log(`sources: ${sources.length}; proposals: ${plan.proposals.length} across ${writes.length} affiliations; reported: ${plan.reported.length}`);
  for (const [from, st] of Object.entries(stats)) {
    const c = summary[from] ?? { proposed: 0, 'no-affiliation': 0, 'draft-or-former': 0, 'no-person-link': 0 };
    const tail = st.skipped ? `SKIPPED (${st.skipped})` : `reported no-affiliation ${c['no-affiliation']}, draft-or-former ${c['draft-or-former']}, no-person-link ${c['no-person-link']}`;
    console.log(`  ${from}: read ${st.read} / proposed ${c.proposed} / ${tail}`);
  }
  for (const n of notes) console.log(`note: ${n}`);

  writeFileSync(args.report, JSON.stringify({ env: args.env, executed: args.execute, notes, stats, summary, proposals: plan.proposals, reported: plan.reported, writes }, null, 2));
  console.log(`report (ids only): ${args.report}`);

  if (args.execute) {
    for (const w of writes) {
      await gql.request(WRITE, { board: aff.boardId, item: w.affiliationId, values: JSON.stringify({ [proposedId]: { labels: w.labels } }) }, { idempotent: false });
    }
    console.log(`wrote Proposed Roles on ${writes.length} affiliations`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    console.error(e.message);
    process.exit(2);
  });
}
