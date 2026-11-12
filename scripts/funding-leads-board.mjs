#!/usr/bin/env node
// Builds, converts and seeds the Funding Leads board in the CRM Sandbox v4 workspace. Operator tool:
// run with your own token, dry run by default, --apply to write. Sandbox only: every command refuses
// any workspace other than 18210301 before it sends a request. Design:
// docs/superpowers/specs/2026-11-11-funding-leads-board-design.md
//
//   MONDAY_API_TOKEN=... node scripts/funding-leads-board.mjs build --workspace 18210301 \
//       --organizations <orgBoardId> [--contacts <contactBoardId>] [--apply]
//
// Reports hold counts, Monday ids and column titles only: no item names, no contact data. A Monday
// error's message is never forwarded, since it can echo the write it refused.
//
// Exit 0: nothing wrong. Exit 1: a check failed. Exit 2: usage or API error, or a write whose
// outcome is unknown. Dry runs send no mutation.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AmbiguousWriteError, MondayApiError, MondayGraphQL } from '../monday-backup/src/monday/graphql.ts';
import { bareTitle } from './lib/column-titles.mjs';
import { DEAL_EXTRA_COLUMNS, LEADS_COLUMNS, assertSandboxWorkspace, mapSheetRow, normalizeOrgName } from './lib/funding-leads.mjs';

const API_URL = 'https://api.monday.com/v2';
const LEADS_BOARD_NAME = 'Funding Leads';
const DEALS_BOARD_NAMES = ['Deals', 'Opportunities (Deals)'];
const NEW_DEALS_BOARD_NAME = 'Opportunities (Deals)';

const USAGE = `usage: MONDAY_API_TOKEN=... node scripts/funding-leads-board.mjs <command>
  build --workspace <id> --organizations <boardId> [--contacts <boardId>] [--apply]
  convert --workspace <id> --leads <boardId> --deals <boardId> [--apply]
  seed --workspace <id> --leads <boardId> --orgs <boardId> --data <dir> [--apply]`;

const COMMANDS = {
  build: { required: ['--workspace', '--organizations'], optional: ['--contacts', '--apply'] },
  convert: { required: ['--workspace', '--leads', '--deals'], optional: ['--apply'] },
  seed: { required: ['--workspace', '--leads', '--orgs', '--data'], optional: ['--apply'] },
};

const numeric = (v, flag) => {
  if (!/^\d+$/.test(v ?? '')) throw new Error(`${flag} must be numeric, got "${v}"`);
  return v;
};

export function parseArgs(argv) {
  const command = argv[0];
  const spec = Object.hasOwn(COMMANDS, command ?? '') ? COMMANDS[command] : null;
  if (!spec) throw new Error(`name a command: ${Object.keys(COMMANDS).join(', ')}`);
  const allowed = new Set([...spec.required, ...spec.optional]);
  const seen = new Map();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.has(flag)) throw new Error(`unknown argument "${flag}" for ${command}`);
    if (seen.has(flag)) throw new Error(`${flag} can only be given once`);
    if (flag === '--apply') seen.set(flag, true);
    else if (flag === '--data') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error('--data needs a directory');
      seen.set(flag, argv[++i]);
    } else seen.set(flag, numeric(argv[++i], flag));
  }
  for (const flag of spec.required) if (!seen.has(flag)) throw new Error(`${flag} is required for ${command}`);
  return {
    command,
    workspace: seen.get('--workspace'),
    organizations: seen.get('--organizations') ?? null,
    contacts: seen.get('--contacts') ?? null,
    leads: seen.get('--leads') ?? null,
    deals: seen.get('--deals') ?? null,
    orgs: seen.get('--orgs') ?? null,
    data: seen.get('--data') ?? null,
    apply: seen.get('--apply') === true,
  };
}

const PALETTE = ['#579bfc', '#fdab3d', '#9d50dd', '#ff7575', '#a1e3f6', '#ff5ac4', '#00c875', '#df2f4a', '#037f4c', '#ffcb00'];

/** The `defaults` JSON string create_column takes for one column spec, or undefined for none. */
export function columnDefaults(column, boardIds = []) {
  const { type, settings } = column;
  if (type === 'status') {
    const labels = {};
    const colors = {};
    settings.labels.forEach((l, i) => {
      labels[i] = l.label;
      const color = PALETTE[i % PALETTE.length];
      colors[i] = { color, border: color, ...(l.done ? { is_done: true } : {}) };
    });
    return JSON.stringify({ labels, labels_colors: colors });
  }
  if (type === 'dropdown')
    return JSON.stringify({ settings: { labels: settings.labels.map((l, i) => ({ id: i + 1, label: l.label })) } });
  if (type === 'numbers' && settings) return JSON.stringify(settings);
  if (type === 'board_relation') return boardIds.length ? JSON.stringify({ boardIds: boardIds.map(Number) }) : undefined;
  return undefined;
}

/**
 * What `build` would do given the boards that already exist in the workspace. Idempotent: a board or
 * column that exists (matched by bare title) is never planned again, and the board is never duplicated.
 */
export function planBuild(existingBoards, _opts = {}) {
  const steps = [];
  const leads = existingBoards.find((b) => b.name === LEADS_BOARD_NAME);
  const deals = existingBoards.find((b) => DEALS_BOARD_NAMES.includes(b.name));
  if (!leads) steps.push({ kind: 'create_board', key: 'leads', name: LEADS_BOARD_NAME });
  if (!deals) steps.push({ kind: 'create_board', key: 'deals', name: NEW_DEALS_BOARD_NAME });
  const missing = (board, columns) => {
    const have = new Set((board?.columns ?? []).map((c) => bareTitle(c.title)));
    return columns.filter((c) => !have.has(c.title));
  };
  for (const column of missing(leads, LEADS_COLUMNS)) steps.push({ kind: 'create_column', board: 'leads', column });
  for (const column of missing(deals, DEAL_EXTRA_COLUMNS)) steps.push({ kind: 'create_column', board: 'deals', column });
  return steps;
}

// ---- Hand-off: Pledged lead → Deal ------------------------------------------------------------

// A relation column's links are in linked_item_ids (via the BoardRelationValue fragment); its plain
// `value` is null, which is what made the first live conversion re-run forever.
const linkedIds = (column) => (column?.linked_item_ids ?? []).map(String);
const labelsOf = (text) => (text ? text.split(',').map((t) => t.trim()).filter(Boolean) : []);

/** One Leads item (id, name, column_values[{id,text,value}]) → the fields the hand-off reads. */
export function leadFromItem(item, cols) {
  const byId = new Map(item.column_values.map((c) => [c.id, c]));
  const col = (title) => byId.get(cols[title]);
  return {
    id: String(item.id),
    name: item.name,
    stage: col('Stage')?.text ?? '',
    dealLinked: linkedIds(col('Deal')).length > 0,
    organization: linkedIds(col('Organization')),
    contact: linkedIds(col('Contact')),
    amount: col('Amount')?.text || null,
    owner: col('Owner')?.value ?? null,
    types: labelsOf(col('Type')?.text),
    events: labelsOf(col('Events of interest')?.text),
  };
}

/** The Deals to create: Pledged leads whose Deal link is empty. The link is the dedupe key. */
export function planConversions(leads) {
  return leads
    .filter((l) => l.stage === 'Pledged' && !l.dealLinked)
    .map((l) => ({
      leadId: l.id,
      deal: {
        name: l.name,
        organization: l.organization,
        contact: l.contact,
        amount: l.amount,
        owner: l.owner,
        types: l.types,
        events: l.events,
      },
    }));
}

const COLUMNS_BY_BOARD = `query ($ids: [ID!]) { boards(ids: $ids) { id columns { id title type } } }`;
const ITEM_FIELDS = 'id name column_values { id text value ... on BoardRelationValue { linked_item_ids } }';
const ITEMS_FIRST = `query ($ids: [ID!]) { boards(ids: $ids) { items_page(limit: 500) { cursor items { ${ITEM_FIELDS} } } } }`;
const ITEMS_NEXT = `query ($cursor: String!) { next_items_page(limit: 500, cursor: $cursor) { cursor items { ${ITEM_FIELDS} } } }`;

/** Every item on a board, following the cursor past the first 500. */
async function fetchAllItems(gql, board) {
  const first = (await gql(ITEMS_FIRST, { ids: [board] })).boards[0].items_page;
  const items = [...first.items];
  for (let cursor = first.cursor; cursor; ) {
    const page = (await gql(ITEMS_NEXT, { cursor })).next_items_page;
    items.push(...page.items);
    cursor = page.cursor;
  }
  return items;
}
const LEAD_DEAL_LINK = `query ($ids: [ID!], $col: [String!]) { items(ids: $ids) { id column_values(ids: $col) { ... on BoardRelationValue { linked_item_ids } } } }`;
const CREATE_ITEM = `mutation ($board: ID!, $name: String!, $cv: JSON) {
  create_item(board_id: $board, item_name: $name, column_values: $cv) { id }
}`;
const SET_COLUMNS = `mutation ($board: ID!, $item: ID!, $cv: JSON!) {
  change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id }
}`;

function dealColumnValues(deal, leadId, dealCols) {
  const cv = {};
  const set = (title, value) => {
    if (dealCols[title] && value !== null && value !== undefined && value !== '') cv[dealCols[title]] = value;
  };
  set('Lead', { item_ids: [leadId] });
  if (deal.organization.length) set('Organization', { item_ids: deal.organization });
  if (deal.contact.length) set('Contact', { item_ids: deal.contact });
  set('Amount', deal.amount);
  if (deal.owner) set('Owner', JSON.parse(deal.owner));
  if (deal.types.length) set('Type', { labels: deal.types });
  if (deal.events.length) set('Events of interest', { labels: deal.events });
  return cv;
}

async function convert(args, { gql, out, err }) {
  const meta = await gql(COLUMNS_BY_BOARD, { ids: [args.leads, args.deals] });
  const colsOf = (id) =>
    Object.fromEntries((meta.boards.find((b) => String(b.id) === String(id))?.columns ?? []).map((c) => [bareTitle(c.title), c.id]));
  const leadCols = colsOf(args.leads);
  const dealCols = colsOf(args.deals);
  const items = await fetchAllItems(gql, args.leads);
  const plan = planConversions(items.map((i) => leadFromItem(i, leadCols)));
  // A Deal left by a run that died between create and link already names its lead (I1): link it, never duplicate it.
  const orphanByLead = new Map();
  if (dealCols.Lead)
    for (const d of await fetchAllItems(gql, args.deals))
      for (const lid of linkedIds(d.column_values.find((c) => c.id === dealCols.Lead))) if (!orphanByLead.has(lid)) orphanByLead.set(lid, String(d.id));
  out(`convert: ${plan.length} Pledged lead(s) without a Deal`);
  if (!args.apply) {
    out('dry run: nothing written. Re-run with --apply.');
    return 0;
  }
  for (const c of plan) {
    // Re-read the dedupe key right before writing, so a lead linked since the listing is skipped.
    const fresh = await gql(LEAD_DEAL_LINK, { ids: [c.leadId], col: [leadCols.Deal] });
    if (linkedIds(fresh.items?.[0]?.column_values?.[0]).length) {
      out(`skipped lead ${c.leadId}: already linked`);
      continue;
    }
    const orphan = orphanByLead.get(c.leadId);
    const dealId =
      orphan ??
      String(
        (
          await gql(
            CREATE_ITEM,
            { board: args.deals, name: c.deal.name, cv: JSON.stringify(dealColumnValues(c.deal, c.leadId, dealCols)) },
            { idempotent: false },
          )
        ).create_item.id,
      );
    try {
      await gql(
        SET_COLUMNS,
        { board: args.leads, item: c.leadId, cv: JSON.stringify({ [leadCols.Deal]: { item_ids: [dealId] } }) },
        { idempotent: false },
      );
    } catch (e) {
      err(`deal ${dealId} was created for lead ${c.leadId} but linking it failed (${errorLine(e)}); link them by hand, then re-run`);
      return 2;
    }
    out(`${orphan ? 'relinked' : 'converted'} lead ${c.leadId} → deal ${dealId}`);
  }
  return 0;
}

// ---- Seed from the sponsor sheet ---------------------------------------------------------------

/** Minimal RFC 4180 reader: first row is the header; returns one object per data row. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...data] = rows.filter((r) => r.some((c) => c !== ''));
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

const SUFFIX = new Set(['inc', 'llc', 'co', 'corp', 'corporation', 'company', 'ltd']);
/** For spotting near-matches only (never for matching): no punctuation, leading "the", trailing inc/llc/co. */
function looseKey(key) {
  let words = key.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (words[0] === 'the') words = words.slice(1);
  while (words.length > 1 && SUFFIX.has(words.at(-1))) words = words.slice(0, -1);
  return words.join(' ');
}

/**
 * entries: [{tab, plan}] from mapSheetRow. existingOrgs: [{id, name}]. Pure.
 * One organization per normalized name, one lead per (company, tab, events); near-matches (one name
 * is the other plus more words) are listed for review and never merged.
 */
export function planSeed(entries, existingOrgs) {
  const known = new Map(existingOrgs.map((o) => [normalizeOrgName(o.name), o.id]));
  const orgCreates = new Map();
  const leads = new Map();
  let skippedBlank = 0;
  let collapsed = 0;
  for (const { tab, plan } of entries) {
    if (!plan.orgKey) {
      skippedBlank += 1;
      continue;
    }
    if (!known.has(plan.orgKey) && !orgCreates.has(plan.orgKey)) orgCreates.set(plan.orgKey, { key: plan.orgKey, name: plan.orgName });
    const key = `${plan.orgKey}|${tab}|${plan.events.join('+')}`;
    if (leads.has(key)) collapsed += 1;
    else leads.set(key, { key, tab, plan, orgKey: plan.orgKey, orgId: known.get(plan.orgKey) ?? null });
  }
  const sheetKeys = new Set(entries.map((e) => e.plan.orgKey).filter(Boolean));
  const keys = [...new Set([...known.keys(), ...orgCreates.keys()])];
  const loose = new Map(keys.map((k) => [k, looseKey(k)]));
  const reviewPairs = [];
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) {
      const [a, b] = [keys[i], keys[j]];
      if (!sheetKeys.has(a) && !sheetKeys.has(b)) continue; // only variants of a company on the sheet matter
      const [la, lb] = [loose.get(a), loose.get(b)];
      if (!la || !lb) continue;
      if (la === lb || lb.startsWith(`${la} `) || la.startsWith(`${lb} `)) reviewPairs.push([a, b]);
    }
  return { orgCreates: [...orgCreates.values()], leadCreates: [...leads.values()], reviewPairs, skippedBlank, collapsed };
}

const ORG_PAGE = `query ($ids: [ID!]) { boards(ids: $ids) { items_page(limit: 500) { cursor items { id name } } } }`;
const ORG_NEXT = `query ($cursor: String!) { next_items_page(limit: 500, cursor: $cursor) { cursor items { id name } } }`;

async function fetchOrgs(gql, board) {
  const first = (await gql(ORG_PAGE, { ids: [board] })).boards[0].items_page;
  const orgs = [...first.items];
  for (let cursor = first.cursor; cursor; ) {
    const page = (await gql(ORG_NEXT, { cursor })).next_items_page;
    orgs.push(...page.items);
    cursor = page.cursor;
  }
  return orgs;
}

const REQUIRED_HEADER = { active: 'Company', prospects: 'Account Name', lapsed: 'Company' };
const TAB_FILES = { active: 'active.csv', prospects: 'prospects.csv', lapsed: 'lapsed.csv' };

async function seed(args, { gql, out, err }) {
  const entries = [];
  for (const [tab, file] of Object.entries(TAB_FILES)) {
    const path = join(args.data, file);
    if (!existsSync(path)) {
      err(`missing ${file} in the data directory`);
      return 2;
    }
    const rows = parseCsv(readFileSync(path, 'utf8'));
    const need = REQUIRED_HEADER[tab];
    if (rows.length && !(need in rows[0])) {
      err(`${file} has no "${need}" column (found: ${Object.keys(rows[0]).join(', ')})`);
      return 2;
    }
    for (const row of rows) entries.push({ tab, plan: mapSheetRow(tab, row) });
  }
  const ledgerPath = join(args.data, 'ledger.json');
  const ledger = existsSync(ledgerPath)
    ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
    : { leadsBoard: args.leads, orgsBoard: args.orgs, orgs: {}, leads: [], pending: null };
  if (ledger.leadsBoard !== args.leads || ledger.orgsBoard !== args.orgs) {
    err('ledger.json was written for different boards; move it aside to seed these boards');
    return 2;
  }
  if (ledger.pending) {
    err(`the previous run was interrupted at lead ${ledger.pending.index}; check Monday for it (its key is in ledger.json under "pending"), then clear "pending" and re-run`);
    return 2;
  }
  const saveLedger = () => {
    writeFileSync(`${ledgerPath}.tmp`, JSON.stringify(ledger));
    renameSync(`${ledgerPath}.tmp`, ledgerPath);
  };

  const meta = await gql(COLUMNS_BY_BOARD, { ids: [args.leads] });
  const cols = Object.fromEntries(meta.boards[0].columns.map((c) => [bareTitle(c.title), c.id]));
  const existing = [
    ...(await fetchOrgs(gql, args.orgs)),
    ...Object.entries(ledger.orgs).map(([name, id]) => ({ id, name })),
  ];
  const planned = planSeed(entries, existing);
  const leadCreates = planned.leadCreates.filter((l) => !ledger.leads.includes(l.key));
  const contactRows = entries.filter((e) => e.plan.contacts.length).length;
  const unparsedAmounts = entries.filter((e) => e.plan.amountUnparsed).length;
  const review = [
    `organizations to create: ${planned.orgCreates.length}`,
    `leads to create: ${leadCreates.length} (already in ledger: ${planned.leadCreates.length - leadCreates.length})`,
    `rows with a blank company, skipped: ${planned.skippedBlank}`,
    `rows collapsed into an earlier lead (same company, tab and events): ${planned.collapsed}`,
    `amounts that could not be read, left empty: ${unparsedAmounts}`,
    `rows with contact data, not linked this pass: ${contactRows}`,
    'near-match organization names (not merged):',
    ...planned.reviewPairs.map(([a, b]) => `  "${a}"  vs  "${b}"`),
  ];
  writeFileSync(join(args.data, 'review.txt'), `${review.join('\n')}\n`);
  out(`seed: ${planned.orgCreates.length} organization(s), ${leadCreates.length} lead(s) to create; ${planned.reviewPairs.length} near-match pair(s) in review.txt`);
  out(`skipped ${planned.skippedBlank} blank-company row(s); collapsed ${planned.collapsed} duplicate row(s); ${unparsedAmounts} unreadable amount(s)`);
  if (!args.apply) {
    out('dry run: nothing written. Re-run with --apply.');
    return 0;
  }
  const orgId = new Map(existing.map((o) => [normalizeOrgName(o.name), o.id]));
  for (const o of planned.orgCreates) {
    const made = await gql(CREATE_ITEM, { board: args.orgs, name: o.name, cv: null }, { idempotent: false });
    orgId.set(o.key, String(made.create_item.id));
    ledger.orgs[o.key] = String(made.create_item.id);
    saveLedger();
  }
  for (const [index, l] of leadCreates.entries()) {
    const p = l.plan;
    const cv = {};
    const set = (title, value) => {
      if (cols[title] && value !== null && value !== undefined) cv[cols[title]] = value;
    };
    set('Organization', { item_ids: [orgId.get(l.orgKey)] });
    set('Stage', { label: p.stage });
    set('Type', { labels: p.types });
    if (p.events.length) set('Events of interest', { labels: p.events });
    if (p.btwdTier) set('BTWD tier', { label: p.btwdTier });
    if (p.funderStatus) set('Funder Status', { label: p.funderStatus });
    if (p.amount !== null) set('Amount', String(p.amount));
    // Marked before the write: if this run dies here, the next one refuses to guess whether it landed (I7).
    ledger.pending = { key: l.key, index: index + 1 };
    saveLedger();
    await gql(CREATE_ITEM, { board: args.leads, name: p.name, cv: JSON.stringify(cv) }, { idempotent: false });
    ledger.leads.push(l.key);
    ledger.pending = null;
    saveLedger();
  }
  out(`created ${planned.orgCreates.length} organization(s) and ${leadCreates.length} lead(s)`);
  return 0;
}

const BOARDS_QUERY = `query ($ws: [ID!]) {
  boards(workspace_ids: $ws, limit: 100) { id name columns { id title type } }
}`;
const CREATE_BOARD = `mutation ($name: String!, $ws: ID!) {
  create_board(board_name: $name, board_kind: public, workspace_id: $ws) { id }
}`;
const CREATE_COLUMN = `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
  create_column(board_id: $board, title: $title, column_type: $type, defaults: $defaults) { id }
}`;

const errorLine = (e) =>
  e instanceof AmbiguousWriteError
    ? 'a write may or may not have committed; look in Monday before re-running'
    : e instanceof MondayApiError
      ? `Monday API error (status ${e.httpStatus ?? '?'}, code ${e.code ?? '?'})`
      : 'unexpected error';

async function build(args, { gql, out, err }) {
  const data = await gql(BOARDS_QUERY, { ws: [args.workspace] });
  const existing = data.boards ?? [];
  const steps = planBuild(existing, args);
  out(`build: ${steps.filter((s) => s.kind === 'create_board').length} board(s), ${steps.filter((s) => s.kind === 'create_column').length} column(s) to create`);
  for (const s of steps) out(s.kind === 'create_board' ? `  board  ${s.name}` : `  column ${s.board}: ${s.column.title}`);
  if (!args.apply) {
    out('dry run: nothing written. Re-run with --apply.');
    return 0;
  }
  const ids = {
    leads: existing.find((b) => b.name === LEADS_BOARD_NAME)?.id,
    deals: existing.find((b) => DEALS_BOARD_NAMES.includes(b.name))?.id,
  };
  for (const s of steps.filter((x) => x.kind === 'create_board')) {
    const made = await gql(CREATE_BOARD, { name: s.name, ws: args.workspace }, { idempotent: false });
    ids[s.key] = String(made.create_board.id);
    out(`created board ${s.key}: ${ids[s.key]}`);
  }
  const targets = (title) => {
    if (title === 'Organization') return [args.organizations];
    if (title === 'Contact') return args.contacts ? [args.contacts] : [];
    if (title === 'Deal') return [ids.deals];
    if (title === 'Lead') return [ids.leads];
    return [];
  };
  for (const s of steps.filter((x) => x.kind === 'create_column')) {
    const defaults = columnDefaults(s.column, targets(s.column.title));
    await gql(CREATE_COLUMN, { board: ids[s.board], title: s.column.title, type: s.column.type, defaults }, { idempotent: false });
    out(`created column ${s.board}: ${s.column.title}`);
  }
  out(`leads board ${ids.leads}, deals board ${ids.deals}`);
  return 0;
}

const BOARD_WORKSPACES = `query ($ids: [ID!]) { boards(ids: $ids) { id workspace { id } } }`;

/** Every board id named on the command line must exist and live in the sandbox workspace. */
async function assertBoardsInSandbox(gql, args) {
  const ids = [args.organizations, args.contacts, args.leads, args.deals, args.orgs].filter(Boolean);
  if (!ids.length) return;
  const found = new Map(((await gql(BOARD_WORKSPACES, { ids })).boards ?? []).map((b) => [String(b.id), b.workspace?.id]));
  for (const id of ids) {
    if (!found.has(String(id))) throw new Error(`board ${id} was not found`);
    assertSandboxWorkspace(found.get(String(id)));
  }
}

export async function run(args, io) {
  try {
    assertSandboxWorkspace(args.workspace);
  } catch (e) {
    io.err(e.message);
    return 2;
  }
  try {
    await assertBoardsInSandbox(io.gql, args);
    if (args.command === 'build') return await build(args, io);
    if (args.command === 'convert') return await convert(args, io);
    if (args.command === 'seed') return await seed(args, io);
    io.err(`unknown command ${args.command}`);
    return 2;
  } catch (e) {
    io.err(e instanceof MondayApiError ? errorLine(e) : e.message.startsWith('board ') || e.message.startsWith('funding-leads') ? e.message : errorLine(e));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const token = process.env.MONDAY_API_TOKEN;
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (!token) {
    console.error('MONDAY_API_TOKEN is required');
    process.exit(2);
  }
  const client = new MondayGraphQL(API_URL, token);
  const code = await run(args, {
    gql: (query, variables, options) => client.request(query, variables, options),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
  process.exit(code);
}
