#!/usr/bin/env node
// Prefixes read-only column titles so staff know not to edit them:
//   🔒  a Worker writes or recomputes this column; a hand edit is overwritten (or breaks a lookup)
//   📜  history loaded once from Salesforce; nothing updates it, keep it as the audit record
//
// Code never sees the marker: every title lookup goes through scripts/lib/column-titles.mjs
// (bareTitle), so Workers, configs and the idempotent setup scripts keep naming the bare title.
// Renaming keeps the column id and its values (change_column_title), so nothing else moves.
//
//   # dry run (default): print the renames, listed columns a board lacks, and stray markers
//   MONDAY_API_TOKEN=... node scripts/mark-read-only-columns.mjs --workspace 123
//   # a sandbox workspace whose boards are named "People (Sandbox)" etc.
//   MONDAY_API_TOKEN=... node scripts/mark-read-only-columns.mjs --workspace 456 --suffix " (Sandbox)"
//   # apply, then re-read and confirm
//   MONDAY_API_TOKEN=... node scripts/mark-read-only-columns.mjs --workspace 123 --apply
//   # undo: strip every marker from the listed boards
//   MONDAY_API_TOKEN=... node scripts/mark-read-only-columns.mjs --workspace 123 --remove --apply
//
// Rename both People boards in the same run (the list below marks them identically): Monday's
// move_item_to_board maps connect columns by title, and people-reclassification compares titles
// across the two boards (it ignores markers, Monday does not).
//
// --apply retries each rename on a transient Monday failure (a 5xx, throttling, or the HTTP-200
// DOWNSTREAM_SERVICE_ERROR that stopped the first production run on 2026-11-02, after 109 of 160),
// logs each rename as it lands, and if one still fails stops with how many landed. Re-running is
// always safe: the plan is re-read, so only still-unmarked columns are renamed.
//
// Exit 0: nothing left to rename. Exit 1: --apply left a column unrenamed. Exit 2: usage or API
// error, including a rename that failed after retries. Dry run writes nothing; --apply writes only
// change_column_title.

import { fileURLToPath } from 'node:url';
import { MONDAY_API_VERSION } from '../monday-backup/src/monday/graphql.ts';
import { LOCKED, HISTORY, bareTitle, markedTitle } from './lib/column-titles.mjs';
import { WINDFALL_TITLES } from './lib/windfall-board.mjs';

const API_URL = 'https://api.monday.com/v2';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

// Board name (without environment suffix) → bare titles. Only columns where a staff edit is
// clearly wrong are listed; columns staff also fill by hand (Donations Amount/Date/Status, emails,
// Payment Method) stay unmarked even where a Worker writes them on its own items.
const OWNER_ROLLUPS = [
  'Gift Ledger (JSON)', 'Lifetime Giving', 'Gift Count', 'First Gift', 'This Year Amount',
  'This Year Count', 'Last Year Amount', 'Last Year Count', 'Largest Gift', 'Smallest Gift',
  'Average Gift', 'Last Gift Date', 'Last Gift Amount', 'Donor Level',
];
const MEMBERSHIP = [
  'Membership Status', 'Membership Tier', 'Member Since', 'Member Until', 'Current Term Start',
  'Member Type', 'Lapse Count', 'Last Lapsed',
];
const SALESFORCE = ['Salesforce ID', 'Salesforce Debug'];
const PEOPLE = {
  locked: [...OWNER_ROLLUPS, ...MEMBERSHIP, 'Organizational Giving', 'Has Active Recurring Gift', 'Funraise Profile', 'Promoted On',
    'DTD Company ID', 'DTD Company', 'DTD match link'],
  history: [...SALESFORCE, 'Salesforce Owner'],
};

export const MARKED_COLUMNS = {
  'People': PEOPLE,
  'People (Historical)': PEOPLE,
  // Wealth screening moved off People on 2026-11-06 (docs/runbooks/windfall-private-board.md).
  // Loaded once from Windfall, whose subscription has ended, so all 11 are history.
  'Wealth Screening': { locked: [], history: [...WINDFALL_TITLES] },
  'Organizations': { locked: OWNER_ROLLUPS, history: [...SALESFORCE, 'Salesforce Owner'] },
  'Donations': {
    locked: ['Funding Stream', 'Gift Size', 'Fiscal Quarter', 'Gift Fiscal Year', 'Matched By Company', 'Funraise ID',
      'Eventbrite Order ID', 'Benevity Transaction ID', 'Match Status', 'DTD Status (raw)', 'Match Company',
      'Sent to DTD', 'Contacts'],
    history: [...SALESFORCE, 'Salesforce Owner', 'Finance Class', 'Revenue Code', 'Sponsorship Cycle',
      'Fee Covered', 'In-Kind Value', 'In-Kind Category', 'Soft Credit'],
  },
  // Contacts is written by contact-roles from the Affiliations board; a hand edit is overwritten.
  // Only boards whose names are in the workspace are touched, so an environment that lacks one
  // (the sandbox has no BP Request Form, say) just skips it.
  'Sponsorships': { locked: ['Contacts'], history: [] },
  'Grants & Contracts': { locked: ['Contacts'], history: [] },
  'BP Request Form': { locked: ['Contacts'], history: [] },
  'Bike Education Lifecycle Tracker': { locked: ['Contacts'], history: [] },
  'Leads': { locked: ['Contacts'], history: [] },
  'Matching Gift Program': {
    locked: ['Fiscal Year', 'Screened', 'Employer identified', 'Eligible', 'Submitted', 'Matches paid',
      'Match dollars', 'Matched gift dollars', 'New matching companies', 'First-time matched donors', 'As of'],
    history: [],
  },
  'Recurring Gifts': {
    locked: ['Funraise ID', 'Installment Amount', 'Annualized Value', 'Frequency', 'Status',
      'Next Payment', 'Designation', 'Company Match', 'Match Employer'],
    history: [...SALESFORCE, 'Pledge Amount', 'Received Amount'],
  },
  'Affiliations': {
    locked: ['Attributed Giving', 'Attributed Gift Count', 'Last Attributed Gift'],
    history: SALESFORCE,
  },
  'Annual Giving Summary': {
    locked: ['Fiscal Year Ending', 'Total Received', 'Gift Count', 'By Gift Type', 'Restated'],
    history: [],
  },
  'Pledge to Ride': {
    locked: ['Eventbrite Attendee ID', 'Year', 'Status', 'Pledge Date', 'Email', 'Details', 'Zip', 'County', 'Days Pledged',
      'Rider Type', 'Heard About It', 'Who Asked', 'Contact Consent', 'Other Answers'],
    history: [],
  },
  'Events': { locked: ['Eventbrite ID', 'Send event email', 'Registrants'], history: [...SALESFORCE, 'Funraise Event ID', 'Tickets Sold'] },
  'Event Registrations': {
    locked: ['Eventbrite Attendee ID', 'Attendee Phone', 'First Name', 'Class Date', 'Class Day', 'Class Location', 'Registrants link', 'Home Zip'],
    history: [...SALESFORCE, 'Ticket Type', 'Ticket Amount', 'Deductible Amount', 'Payment'],
  },
  // Type, Start and End stay editable: whoever runs an appeal fills them in on its new item (#82).
  'Campaigns': { locked: [], history: [...SALESFORCE, 'Salesforce Owner', 'Active'] },
  'Volunteers': { locked: ['Eventbrite Listing', 'Eventbrite Attendee ID', 'Attendee Name', 'Attendee Email', 'Ticket Type'], history: [...SALESFORCE, 'Job', 'Hours', 'Date', 'Status', 'Historical', 'Volunteer'] },
  'Activities': { locked: [], history: [...SALESFORCE, 'Owner'] },
};

const USAGE =
  'usage: MONDAY_API_TOKEN=... node scripts/mark-read-only-columns.mjs --workspace <id> [--suffix <text>] [--remove] [--apply]';

export function parseArgs(argv) {
  const args = { workspace: null, suffix: '', apply: false, remove: false };
  for (let i = 0; i < argv.length; i++) {
    const value = () => {
      if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
      return argv[++i];
    };
    switch (argv[i]) {
      case '--workspace': args.workspace = value(); break;
      case '--suffix': args.suffix = value(); break;
      case '--apply': args.apply = true; break;
      case '--remove': args.remove = true; break;
      default: throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (args.workspace === null) throw new Error('--workspace is required');
  if (!/^\d+$/.test(args.workspace)) throw new Error(`--workspace must be numeric, got "${args.workspace}"`);
  return args;
}

// What to rename on `boards` ({ id, name, columns: [{ id, title }] }). Pure, so it is tested
// without the API. `missing`: listed titles a matched board lacks (a typo, or a Worker's column
// not created in this environment). `unmarked`: markers on columns no longer in the list.
export function planRenames(boards, spec = MARKED_COLUMNS, { suffix = '', remove = false } = {}) {
  const renames = [];
  const missing = [];
  const unmarked = [];
  for (const b of boards) {
    const base = suffix && b.name.endsWith(suffix) ? b.name.slice(0, -suffix.length) : b.name;
    const lists = spec[base];
    if (!lists) continue;
    const want = new Map([
      ...lists.history.map((t) => [t, HISTORY]),
      ...lists.locked.map((t) => [t, LOCKED]),
    ]);
    const present = new Set();
    for (const c of b.columns) {
      const bare = bareTitle(c.title);
      present.add(bare);
      const marker = want.get(bare);
      const to = remove ? bare : marker ? markedTitle(bare, marker) : c.title;
      if (!remove && !marker && bare !== c.title) unmarked.push({ boardName: b.name, title: c.title });
      if (to !== c.title) renames.push({ boardId: b.id, boardName: b.name, columnId: c.id, from: c.title, to });
    }
    if (!remove) for (const t of want.keys()) if (!present.has(t)) missing.push({ boardName: b.name, title: t });
  }
  return { renames, missing, unmarked };
}

// True when no suffix was given, or at least one board name ends with it.
export function suffixMatchesAny(boards, suffix) {
  return !suffix || boards.some((b) => b.name.endsWith(suffix));
}

export function formatPlan(plan, { apply }) {
  const lines = [];
  for (const r of plan.renames) lines.push(`${apply ? 'will rename' : 'would rename'}  ${r.boardName}: "${r.from}" → "${r.to}"`);
  if (plan.renames.length === 0) lines.push('nothing to rename');
  for (const m of plan.missing) lines.push(`not on board  ${m.boardName}: "${m.title}"`);
  for (const u of plan.unmarked) lines.push(`stray marker  ${u.boardName}: "${u.title}" is not in the list (left as-is)`);
  return lines.join('\n');
}

// A failed Monday call, with what isTransient needs: the HTTP status and every GraphQL error code
// (Monday reports a server-side failure as HTTP 200 with errors[].extensions.code).
export class MondayError extends Error {
  constructor(message, status, codes) {
    super(message);
    this.name = 'MondayError';
    this.status = status;
    this.codes = codes;
  }
}

const TRANSIENT_CODES = new Set([
  'INTERNAL_SERVER_ERROR', 'DOWNSTREAM_SERVICE_ERROR', 'COMPLEXITY_BUDGET_EXHAUSTED', 'RATE_LIMIT_EXCEEDED',
  'ComplexityException', 'maxConcurrencyExceeded',
]);

// Worth retrying: Monday-side failures and throttling, and our own request timeout. A request
// Monday rejected (bad id, no permission) fails the same way every time, so it is not retried.
export function isTransient(error) {
  if (error?.name === 'TimeoutError') return true;
  if (!(error instanceof MondayError)) return false;
  return error.status >= 500 || error.status === 429 || error.codes.some((c) => TRANSIENT_CODES.has(c));
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Calls fn, retrying a transient failure once after each delay (so delaysMs.length + 1 tries).
export async function withRetry(fn, { delaysMs = [2_000, 10_000, 30_000], sleep = sleepMs, onRetry = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= delaysMs.length || !isTransient(error)) throw error;
      onRetry(error, delaysMs[attempt]);
      await sleep(delaysMs[attempt]);
    }
  }
}

// Applies renames one at a time, logging each as it lands, so a run that stops part-way shows
// exactly how far it got. Stops at the first rename that still fails after retries.
export async function applyRenames(renames, rename, { log = console.log, retry = {} } = {}) {
  let done = 0;
  for (const r of renames) {
    try {
      await withRetry(() => rename(r), {
        ...retry,
        onRetry: (error, ms) => log(`retrying     ${r.boardName}: "${r.from}" in ${ms / 1000}s (${error.message})`),
      });
    } catch (error) {
      return { done, failed: { rename: r, error } };
    }
    log(`renamed  ${r.boardName}: "${r.from}" → "${r.to}"`);
    done++;
  }
  return { done, failed: null };
}

async function query(token, graphql, variables) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': MONDAY_API_VERSION },
    body: JSON.stringify({ query: graphql, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body === null || body.errors || !body.data) {
    const codes = (body?.errors ?? []).flatMap((e) => [e.extensions?.code, e.extensions?.error_code]).filter(Boolean);
    if (body?.error_code) codes.push(body.error_code);
    throw new MondayError(
      `monday API: HTTP ${res.status}: ${JSON.stringify(body?.errors ?? body?.error_message ?? body).slice(0, 300)}`,
      res.status, codes);
  }
  return body.data;
}

async function listBoards(token, workspace) {
  const boards = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await query(
      token,
      `query ($ws: [ID!], $limit: Int, $page: Int) {
         boards(workspace_ids: $ws, limit: $limit, page: $page, state: active) { id name columns { id title } }
       }`,
      { ws: [workspace], limit: PAGE_SIZE, page },
    );
    boards.push(...data.boards);
    if (data.boards.length < PAGE_SIZE) return boards;
  }
  throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} boards in the workspace; raise MAX_PAGES`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    console.error(`MONDAY_API_TOKEN is not set\n${USAGE}`);
    return 2;
  }
  const options = { suffix: args.suffix, remove: args.remove };
  const boards = await listBoards(token, args.workspace);
  // A suffix that matches no board means every suffixed board would be skipped while unsuffixed
  // boards in the workspace still match (the sandbox v4 boards end " (sandbox v4)", not " (Sandbox)").
  if (!suffixMatchesAny(boards, args.suffix)) {
    console.error(`no board in workspace ${args.workspace} ends with ${JSON.stringify(args.suffix)}; ` +
      `check the suffix (boards: ${[...new Set(boards.map((b) => b.name.match(/\(([^)]*)\)$/)?.[0]).filter(Boolean))].join(', ')})`);
    return 2;
  }
  const plan = planRenames(boards, MARKED_COLUMNS, options);
  console.log(formatPlan(plan, args));
  if (!args.apply) return 0;

  const { done, failed } = await applyRenames(plan.renames, (r) => query(
    token,
    `mutation ($board: ID!, $column: String!, $title: String!) {
       change_column_title(board_id: $board, column_id: $column, title: $title) { id }
     }`,
    { board: r.boardId, column: r.columnId, title: r.to },
  ));
  if (failed) {
    console.error(`stopped after ${done} of ${plan.renames.length} rename(s): ${failed.rename.boardName}: ` +
      `"${failed.rename.from}" failed: ${failed.error.message}`);
    console.error('Re-running is safe: it renames only what is still unmarked.');
    return 2;
  }
  const left = planRenames(await listBoards(token, args.workspace), MARKED_COLUMNS, options).renames;
  if (left.length > 0) {
    console.error(`${left.length} column(s) still need renaming after --apply:`);
    console.error(formatPlan({ renames: left, missing: [], unmarked: [] }, { apply: false }));
    return 1;
  }
  console.log(`applied ${plan.renames.length} rename(s); re-read confirms nothing left to rename`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    console.error(e.message);
    process.exit(2);
  });
}
