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

import { fileURLToPath } from 'node:url';
import { AmbiguousWriteError, MondayApiError, MondayGraphQL } from '../monday-backup/src/monday/graphql.ts';
import { bareTitle } from './lib/column-titles.mjs';
import { DEAL_EXTRA_COLUMNS, LEADS_COLUMNS, assertSandboxWorkspace } from './lib/funding-leads.mjs';

const API_URL = 'https://api.monday.com/v2';
const LEADS_BOARD_NAME = 'Funding Leads';
const DEALS_BOARD_NAMES = ['Deals', 'Opportunities (Deals)'];
const NEW_DEALS_BOARD_NAME = 'Opportunities (Deals)';

const USAGE = `usage: MONDAY_API_TOKEN=... node scripts/funding-leads-board.mjs <command>
  build --workspace <id> --organizations <boardId> [--contacts <boardId>] [--apply]
  convert --workspace <id> --leads <boardId> --deals <boardId> [--apply]`;

const COMMANDS = {
  build: { required: ['--workspace', '--organizations'], optional: ['--contacts', '--apply'] },
  convert: { required: ['--workspace', '--leads', '--deals'], optional: ['--apply'] },
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
    else seen.set(flag, numeric(argv[++i], flag));
  }
  for (const flag of spec.required) if (!seen.has(flag)) throw new Error(`${flag} is required for ${command}`);
  return {
    command,
    workspace: seen.get('--workspace'),
    organizations: seen.get('--organizations') ?? null,
    contacts: seen.get('--contacts') ?? null,
    leads: seen.get('--leads') ?? null,
    deals: seen.get('--deals') ?? null,
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

const linkedIds = (value) => {
  try {
    return (JSON.parse(value)?.linkedPulseIds ?? []).map((l) => String(l.linkedPulseId));
  } catch {
    return [];
  }
};
const labelsOf = (text) => (text ? text.split(',').map((t) => t.trim()).filter(Boolean) : []);

/** One Leads item (id, name, column_values[{id,text,value}]) → the fields the hand-off reads. */
export function leadFromItem(item, cols) {
  const byId = new Map(item.column_values.map((c) => [c.id, c]));
  const col = (title) => byId.get(cols[title]);
  return {
    id: String(item.id),
    name: item.name,
    stage: col('Stage')?.text ?? '',
    dealLinked: linkedIds(col('Deal')?.value).length > 0,
    organization: linkedIds(col('Organization')?.value),
    contact: linkedIds(col('Contact')?.value),
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
const LEAD_ITEMS = `query ($ids: [ID!]) {
  boards(ids: $ids) { items_page(limit: 500) { items { id name column_values { id text value } } } }
}`;
const LEAD_DEAL_LINK = `query ($ids: [ID!], $col: [String!]) { items(ids: $ids) { id column_values(ids: $col) { value } } }`;
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
  const items = (await gql(LEAD_ITEMS, { ids: [args.leads] })).boards[0].items_page.items;
  const plan = planConversions(items.map((i) => leadFromItem(i, leadCols)));
  out(`convert: ${plan.length} Pledged lead(s) without a Deal`);
  if (!args.apply) {
    out('dry run: nothing written. Re-run with --apply.');
    return 0;
  }
  for (const c of plan) {
    // Re-read the dedupe key right before writing, so a lead linked since the listing is skipped.
    const fresh = await gql(LEAD_DEAL_LINK, { ids: [c.leadId], col: [leadCols.Deal] });
    if (linkedIds(fresh.items?.[0]?.column_values?.[0]?.value).length) {
      out(`skipped lead ${c.leadId}: already linked`);
      continue;
    }
    const made = await gql(
      CREATE_ITEM,
      { board: args.deals, name: c.deal.name, cv: JSON.stringify(dealColumnValues(c.deal, c.leadId, dealCols)) },
      { idempotent: false },
    );
    const dealId = String(made.create_item.id);
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
    out(`converted lead ${c.leadId} → deal ${dealId}`);
  }
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

export async function run(args, io) {
  try {
    assertSandboxWorkspace(args.workspace);
  } catch (e) {
    io.err(e.message);
    return 2;
  }
  try {
    if (args.command === 'build') return await build(args, io);
    if (args.command === 'convert') return await convert(args, io);
    io.err(`unknown command ${args.command}`);
    return 2;
  } catch (e) {
    io.err(errorLine(e));
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
