#!/usr/bin/env node
// Provisions the Monday columns contact-roles needs, creating whatever is missing (idempotent by
// bare column title, so a 🔒 marker added later never causes a duplicate):
//   Affiliations: `SVBC Roles` and `Proposed Roles` (multi dropdowns, the five seed role labels)
//   every board in config/<env>.json (enabled or not): `Contacts`, a one-way multi connect column
//     to the same People boards the Affiliations `Person` column links to (read live)
// Dry run by default; --execute creates. Then run scripts/mark-read-only-columns.mjs to put the 🔒
// on Contacts, and do the UI-only steps this prints.
//
//   MONDAY_API_TOKEN=... node contact-roles/scripts/provision-contact-roles.mjs --env sandbox
//   MONDAY_API_TOKEN=... node contact-roles/scripts/provision-contact-roles.mjs --env production --execute
//
// One-way: create_column's board_relation settings accept allowCreateReflectionColumn, which we
// pass as false so People gets no reflection column. Exit 0: nothing (left) to create or all
// created. Exit 2: usage or API error.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bareTitle } from '../../scripts/lib/column-titles.mjs';
import { MondayGraphQL } from '../src/monday/graphql.ts';

export const SEED_ROLES = ['Sponsorship', 'Grants', 'Bike Parking', 'Donation Matching', 'Classes'];
export const ROLE_COLUMNS = ['SVBC Roles', 'Proposed Roles'];
export const CONTACTS_TITLE = 'Contacts';

export const UI_STEPS = [
  'UI-only steps (the API cannot do these):',
  '  1. Affiliations: create the view "Roles to confirm" (table; filter: Proposed Roles is not empty).',
  '  2. Donations: open the staff "Enter a gift" form editor and hide the new Contacts question, then run',
  '       node scripts/check-donation-form.mjs --form <token>',
  '     (token from the share link; production 567223ac739c23567e56e9057d81dbf5, sandbox v4 2325fd7745d3a2d425086d38358e4bd5).',
  '  3. node scripts/mark-read-only-columns.mjs --workspace <id> [--suffix " (Sandbox)"] --apply   (puts 🔒 on Contacts).',
];

// Pure. boards: [{ id, name, columns: [{ id, title, type }] }]; spec: { config, peopleBoardIds }.
export function planProvision(boards, { config, peopleBoardIds }) {
  if (!peopleBoardIds || peopleBoardIds.length === 0) throw new Error('no People board ids to link Contacts to');
  const byId = new Map(boards.map((b) => [String(b.id), b]));
  const has = (board, title) => board.columns.some((c) => bareTitle(c.title) === title);
  const creates = [];
  const skipped = [];

  const aff = byId.get(String(config.affiliations.boardId));
  if (!aff) throw new Error(`Affiliations board ${config.affiliations.boardId} not found`);
  for (const title of ROLE_COLUMNS) {
    if (has(aff, title)) continue;
    creates.push({
      boardId: aff.id, title, type: 'dropdown',
      settings: { labels: SEED_ROLES.map((label, i) => ({ id: i + 1, label })) },
    });
  }

  for (const rule of config.boards) {
    const board = byId.get(String(rule.boardId));
    if (!board) {
      skipped.push(`${rule.name} (${rule.boardId}): board not found`);
      continue;
    }
    if (has(board, CONTACTS_TITLE)) continue;
    creates.push({
      boardId: board.id, title: CONTACTS_TITLE, type: 'board_relation',
      settings: { boardIds: peopleBoardIds.map(Number), allowMultipleItems: true, allowCreateReflectionColumn: false },
    });
  }
  return { creates, skipped };
}

export function parseArgs(argv) {
  const args = { env: null, execute: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--env': args.env = argv[++i] ?? null; break;
      case '--execute': args.execute = true; break;
      default: throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (args.env === null) throw new Error('--env sandbox|production is required');
  if (args.env !== 'sandbox' && args.env !== 'production') throw new Error('--env must be sandbox or production');
  return args;
}

export function formatPlan(plan, { execute }) {
  const lines = plan.creates.map((c) => `${execute ? 'will create' : 'would create'}  board ${c.boardId}: "${c.title}" (${c.type})`);
  if (plan.creates.length === 0) lines.push('nothing to create');
  for (const s of plan.skipped) lines.push(`skipped  ${s}`);
  return lines.join('\n');
}

// create_column `defaults` payload: dropdown labels sit under `settings`, a connect column takes
// its settings at the top level.
export function defaultsFor(create) {
  return JSON.stringify(create.type === 'dropdown' ? { settings: create.settings } : create.settings);
}

const BOARDS_QUERY = `query ($ids: [ID!]) { boards(ids: $ids) { id name columns { id title type settings_str } } }`;
const CREATE = `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
  create_column(board_id: $board, title: $title, column_type: $type, defaults: $defaults) { id } }`;

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nusage: MONDAY_API_TOKEN=... node contact-roles/scripts/provision-contact-roles.mjs --env sandbox|production [--execute]`);
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

  const read = async () => {
    const ids = [config.affiliations.boardId, ...config.boards.map((b) => b.boardId)];
    return (await gql.request(BOARDS_QUERY, { ids })).boards;
  };
  const boards = await read();
  const aff = boards.find((b) => String(b.id) === String(config.affiliations.boardId));
  const person = aff?.columns.find((c) => bareTitle(c.title) === config.affiliations.personColumn);
  if (!person) throw new Error(`Affiliations "${config.affiliations.personColumn}" column not found`);
  const peopleBoardIds = (JSON.parse(person.settings_str).boardIds ?? []).map(String);

  const plan = planProvision(boards, { config, peopleBoardIds });
  console.log(`People boards for Contacts: ${peopleBoardIds.join(', ')}`);
  console.log(formatPlan(plan, args));
  if (args.execute) {
    for (const c of plan.creates) {
      await gql.request(CREATE, { board: c.boardId, title: c.title, type: c.type, defaults: defaultsFor(c) }, { idempotent: false });
      console.log(`created  board ${c.boardId}: "${c.title}"`);
    }
    const left = planProvision(await read(), { config, peopleBoardIds }).creates;
    console.log(left.length === 0 ? 're-read confirms nothing left to create' : `${left.length} column(s) still missing after --execute`);
    if (left.length > 0) return 2;
  }
  console.log(UI_STEPS.join('\n'));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    console.error(e.message);
    process.exit(2);
  });
}
