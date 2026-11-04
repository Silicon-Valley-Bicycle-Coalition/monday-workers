#!/usr/bin/env node
// Creates the Donor Roll Call board (spec 2026-11-02-donor-roll-call-board-design §4/§7) that the
// custodian's nightly `rollcall` duty maintains, adds the Don't List in Recognition checkbox to
// each People board and Organizations (and Recognition Name to Organizations), adds Recognition
// Fiscal Year to Donations (spec §10.1), and prints the
// complete `donationRollups.rollCall` config block. Idempotent: same-titled columns are reused,
// so re-running against an existing board (--board) only fills in what's missing.
//
// Usage:
//   MONDAY_API_TOKEN=... node scripts/setup-roll-call-board.mjs \
//     --workspace 18210301 [--name "Donor Roll Call"] [--board <existingId>] \
//     --people <id>[,<id>] --organizations <id> --donations <id>
//
// The People boards need Household ID / Household Greeting already (monday-migration's
// copy-household-greetings.mjs creates and fills them); the script only looks them up.

import { MondayGraphQL } from '../src/monday/graphql.ts';

const token = process.env.MONDAY_API_TOKEN;
if (!token) {
  console.error('setup-roll-call-board: MONDAY_API_TOKEN is required');
  process.exit(1);
}
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const workspaceId = arg('--workspace');
const boardName = arg('--name') ?? 'Donor Roll Call';
let boardId = arg('--board');
const peopleIds = (arg('--people') ?? '').split(',').filter(Boolean);
const organizationsId = arg('--organizations');
const donationsId = arg('--donations');
if ((!workspaceId && !boardId) || peopleIds.length === 0 || !organizationsId || !donationsId) {
  console.error('usage: setup-roll-call-board.mjs --workspace <id> [--name "..."] [--board <existingId>] ' +
    '--people <id>[,<id>] --organizations <id> --donations <id>');
  process.exit(1);
}

const CURRENCY = JSON.stringify({ unit: { symbol: '$', direction: 'left', precision: 2 } });
// Status columns are seeded with every label the duty writes: it never passes
// create_labels_if_missing, so a label missing here fails the write.
const statusLabels = (labels) => JSON.stringify({ labels: Object.fromEntries(labels.map((l, i) => [String(i), l])) });
const TIERS = ['$50,000+', '$25,000+', '$10,000+', '$5,000+', '$2,500+', '$1,000+', '$500+', '$100+', 'Under $100'];
const TYPES = ['Household', 'Individual', 'Organization', 'Anonymous'];
const LISTED = ['Listed', "Don't list"];

const DONT_LIST = { title: "Don't List in Recognition", type: 'checkbox',
  description: 'Check to leave this donor off the donor roll call printed in the Annual Impact Report. Their giving still counts toward the totals.' };
const RECOGNITION_NAME = { title: 'Recognition Name', type: 'text',
  description: 'How this organization is named in donor recognition. Blank means use Name. The donor roll call prints it.' };
// Text, like Fiscal Year Ending: a numbers column would render 2026 as "2,026".
const RECOGNITION_FISCAL_YEAR = { title: 'Recognition Fiscal Year', type: 'text',
  description: 'Blank: the donor roll call counts this gift in its own fiscal year. Type a year (2026 or FY2026) to count it in that year instead, e.g. a sponsor who prepaid for next year\'s event. Archived gifts: restore the item first.' };

const monday = new MondayGraphQL('https://api.monday.com/v2', token);
// Mutations here create boards and columns, so a failure that may have committed throws
// AmbiguousWriteError instead of being retried into a duplicate; queries get the full retry.
async function graphql(query, variables) {
  return monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
}

async function columnsOf(id) {
  const data = await graphql('query ($ids: [ID!]) { boards(ids: $ids) { columns { id title type } } }', { ids: [id] });
  if (!data.boards[0]) throw new Error(`board ${id} not found`);
  return new Map(data.boards[0].columns.map((c) => [c.title, c.id]));
}

async function ensureColumn(board, byTitle, spec) {
  const existing = byTitle.get(spec.title);
  if (existing) return existing;
  const created = await graphql(
    `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON, $description: String) {
       create_column (board_id: $board, title: $title, column_type: $type, defaults: $defaults, description: $description) { id } }`,
    { board, title: spec.title, type: spec.type, defaults: spec.defaults, description: spec.description });
  byTitle.set(spec.title, created.create_column.id);
  console.error(`setup-roll-call-board: board ${board}: created "${spec.title}" → ${created.create_column.id}`);
  return created.create_column.id;
}

function lookup(byTitle, board, title) {
  const id = byTitle.get(title);
  if (!id) throw new Error(`board ${board} has no "${title}" column`);
  return id;
}

if (!boardId) {
  // Private, not public: the board holds donor names and giving totals, and a public board is
  // readable (and editable) by every member of the account. Only its subscribers see a private one.
  const created = await graphql(
    `mutation ($name: String!, $workspaceId: ID!) {
       create_board (board_name: $name, board_kind: private, workspace_id: $workspaceId) {
         id
         items_page (limit: 25) { items { id } }
       } }`,
    { name: boardName, workspaceId });
  boardId = created.create_board.id;
  // Delete monday.com's seeded placeholder item before any real data lands.
  for (const item of created.create_board.items_page?.items ?? []) {
    await graphql('mutation ($id: ID!) { delete_item (item_id: $id) { id } }', { id: item.id });
  }
  console.error(`setup-roll-call-board: created board ${boardId} ("${boardName}")`);
}

const boardColumns = await columnsOf(boardId);
const connect = (ids) => JSON.stringify({ boardIds: ids.map(Number) });
const FIELDS = {
  // text, not numbers: a numbers column would render 2026 as "2,026"
  fiscalYear: { title: 'Fiscal Year', type: 'text' },
  tier: { title: 'Tier', type: 'status', defaults: statusLabels(TIERS) },
  type: { title: 'Type', type: 'status', defaults: statusLabels(TYPES) },
  listed: { title: 'Listed', type: 'status', defaults: statusLabels(LISTED) },
  total: { title: 'Total', type: 'numbers', defaults: CURRENCY },
  gifts: { title: 'Gifts', type: 'numbers' },
  people: { title: 'People', type: 'board_relation', defaults: connect(peopleIds) },
  organization: { title: 'Organization', type: 'board_relation', defaults: connect([organizationsId]) },
  reviewNote: { title: 'Review Note', type: 'long_text' },
  rowKey: { title: 'Row Key', type: 'text' },
  // Spec §10.2: the item's Name again, as a cell exports and sorts keep.
  householdName: { title: 'Household Name', type: 'text',
    description: 'Written by the Worker: the name printed on the roll call (Household Greeting, else Name; an organization\'s Recognition Name). Edit it on the donor, not here.' },
  // Spec §11: for mailing an export. Text, like Address, the column it copies.
  mailingAddress: { title: 'Mailing Address', type: 'text',
    description: 'Written by the Worker from the donor\'s Address. Blank means no address on file, or Do Not Mail is checked (the Review Note says so). Edit it on the donor, not here.' },
};
const columns = {};
for (const [field, spec] of Object.entries(FIELDS)) columns[field] = await ensureColumn(boardId, boardColumns, spec);

// Donor-side columns: the checkbox on each People board and Organizations, the name on Organizations.
const people = {};
for (const id of peopleIds) {
  const byTitle = await columnsOf(id);
  const dontList = await ensureColumn(id, byTitle, DONT_LIST);
  people[id] = {
    householdId: lookup(byTitle, id, 'Household ID'),
    householdGreeting: lookup(byTitle, id, 'Household Greeting'),
    householdEmail: lookup(byTitle, id, 'Household Email'),
    doNotSolicit: lookup(byTitle, id, 'Do Not Solicit'),
    dontList,
    address: lookup(byTitle, id, 'Address'),
    doNotMail: lookup(byTitle, id, 'Do Not Mail'),
  };
}
const orgColumns = await columnsOf(organizationsId);
const organizations = {
  boardId: Number(organizationsId),
  columns: {
    recognitionName: await ensureColumn(organizationsId, orgColumns, RECOGNITION_NAME),
    dontList: await ensureColumn(organizationsId, orgColumns, DONT_LIST),
    address: lookup(orgColumns, organizationsId, 'Address'),
  },
};

const donationColumns = await columnsOf(donationsId);
const recognitionFiscalYear = await ensureColumn(donationsId, donationColumns, RECOGNITION_FISCAL_YEAR);
// Optional (spec §10.3): counted when Amount is blank; left out of the config if the board has none.
// Migrated columns carry a 📜 prefix (salesforce-import's marker for Salesforce-sourced fields).
const inKindValue = donationColumns.get('📜 In-Kind Value') ?? donationColumns.get('In-Kind Value');
const donations = {
  boardId: Number(donationsId),
  columns: {
    amount: lookup(donationColumns, donationsId, 'Amount'),
    date: lookup(donationColumns, donationsId, 'Date'),
    status: lookup(donationColumns, donationsId, 'Status'),
    fiscalYear: lookup(donationColumns, donationsId, 'Fiscal Year Ending'),
    giftType: lookup(donationColumns, donationsId, 'Gift Type'),
    donorLink: lookup(donationColumns, donationsId, 'Donor'),
    matchedBy: lookup(donationColumns, donationsId, 'Matched By'),
    anonymous: lookup(donationColumns, donationsId, 'Anonymous Donor'),
    ...(inKindValue ? { inKindValue } : {}),
    recognitionFiscalYear,
  },
};

console.error(`setup-roll-call-board: board ${boardId} is private and holds donor names and giving totals. ` +
  'Subscribe only the staff who need it (the report owner and whoever prints the roll call).');
console.log(JSON.stringify({
  rollCall: {
    boardId: Number(boardId),
    firstFiscalYear: 2026,
    excludedGiftTypes: ['Contracts'],
    writesPerRun: 500,
    columns,
    donations,
    people,
    organizations,
  },
}, null, 2));

// Saved views (spec §4), each Total largest first. The API can express filter + sort
// (create_view_table), but a filter can't say "the in-progress year", so the two year views name
// the fiscal years as of today and need their Fiscal Year value changed each July (README).
// Status filters compare label indexes, which are the seed order above. Existing views of the
// same name are left alone.
const existing = await graphql('query ($ids: [ID!]) { boards(ids: $ids) { views { id name } } }', { ids: [boardId] });
const haveViews = new Set((existing.boards[0].views ?? []).map((v) => v.name));
const ptNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
const currentFY = ptNow.getFullYear() + (ptNow.getMonth() >= 6 ? 1 : 0);
const indexes = (labels, wanted) => wanted.map((l) => labels.indexOf(l));
const fiscalYearIs = (fy) => ({ column_id: columns.fiscalYear, compare_value: [String(fy)], operator: 'any_of' });
const listedOnly = { column_id: columns.listed, compare_value: indexes(LISTED, ['Listed']), operator: 'any_of' };
const VIEWS = [
  { name: 'This year so far', rules: [fiscalYearIs(currentFY), listedOnly,
    { column_id: columns.tier, compare_value: indexes(TIERS, ['Under $100']), operator: 'not_any_of' }] },
  { name: 'Last closed year', rules: [fiscalYearIs(currentFY - 1), listedOnly,
    { column_id: columns.tier, compare_value: indexes(TIERS, TIERS.filter((t) => t !== 'Under $100')), operator: 'any_of' }] },
  { name: 'Needs review', rules: [{ column_id: columns.reviewNote, compare_value: [], operator: 'is_not_empty' }] },
];
for (const view of VIEWS) {
  if (haveViews.has(view.name)) continue;
  await graphql(
    `mutation ($board: ID!, $name: String, $filter: ItemsQueryGroup, $sort: [ItemsQueryOrderBy!]) {
       create_view_table (board_id: $board, name: $name, filter: $filter, sort: $sort) { id } }`,
    { board: boardId, name: view.name, filter: { rules: view.rules, operator: 'and' },
      sort: [{ column_id: columns.total, direction: "desc" }] });
  console.error(`setup-roll-call-board: created view "${view.name}"`);
}
