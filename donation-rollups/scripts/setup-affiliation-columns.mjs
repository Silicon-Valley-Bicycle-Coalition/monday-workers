#!/usr/bin/env node
// Ensures the Affiliations board has the three rollup columns phase 2 writes (creating any
// that are missing) and locates its existing `Person` connect column, then ensures every
// People board has an `Organizational Giving` column. Mirrors setup-owner-columns.mjs's shape
// (same graphql helper, find-by-title-else-create, currency defaults) — run once per new
// environment (sandbox rebuild, production cutover), then paste the printed JSON into the
// config file's (`--config <path>`, default `config/svbc.json`) `affiliations` and
// `donationRollups.ownerColumnsByBoard[...].organizationalGiving`.
//
// Usage:
//   MONDAY_API_TOKEN=... node scripts/setup-affiliation-columns.mjs <affiliationsBoardId> <peopleBoardId> [<peopleBoardId> ...]

const token = process.env.MONDAY_API_TOKEN;
if (!token) {
  console.error('setup-affiliation-columns: MONDAY_API_TOKEN is required');
  process.exit(1);
}
const [affiliationsBoardId, ...peopleBoardIds] = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!affiliationsBoardId || peopleBoardIds.length === 0) {
  console.error('usage: node scripts/setup-affiliation-columns.mjs <affiliationsBoardId> <peopleBoardId> [<peopleBoardId> ...]');
  process.exit(1);
}

const CURRENCY = JSON.stringify({ unit: { symbol: '$', direction: 'left', precision: 2 } });

// Field key → { title, type, currency } — titles must match across boards so staff see one
// consistent vocabulary everywhere (same convention as setup-owner-columns.mjs).
const AFFILIATION_FIELDS = {
  attributedGiving: { title: 'Attributed Giving', type: 'numbers', defaults: CURRENCY },
  attributedGiftCount: { title: 'Attributed Gift Count', type: 'numbers' },
  lastAttributedGift: { title: 'Last Attributed Gift', type: 'date' },
};
const PERSON_LINK_TITLE = 'Person';
const ORGANIZATIONAL_GIVING = { title: 'Organizational Giving', type: 'numbers', defaults: CURRENCY };

async function graphql(query, variables) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2026-01' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`monday API: HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`monday API: ${json.errors.map((e) => e.message).join('; ')}`);
  return json.data;
}

async function getBoard(boardId) {
  const data = await graphql(
    'query ($ids: [ID!]) { boards(ids: $ids) { name columns { id title type } } }',
    { ids: [boardId] });
  const board = data.boards?.[0];
  if (!board) throw new Error(`setup-affiliation-columns: board ${boardId} not found`);
  return board;
}

async function ensureColumn(boardId, boardName, byTitle, spec) {
  const existing = byTitle.get(spec.title);
  if (existing) return existing.id;
  const created = await graphql(
    `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
       create_column (board_id: $board, title: $title, column_type: $type, defaults: $defaults) { id } }`,
    { board: boardId, title: spec.title, type: spec.type, defaults: spec.defaults });
  const id = created.create_column.id;
  console.error(`setup-affiliation-columns: ${boardName} (${boardId}): created "${spec.title}" → ${id}`);
  return id;
}

// Affiliations board: ensure the three attributed-giving columns, and locate (never create —
// this is the board-relation the rest of the model is built on, so a missing one means the
// board isn't ready) the Person connect column.
const affiliationsBoard = await getBoard(affiliationsBoardId);
const affiliationsByTitle = new Map(affiliationsBoard.columns.map((c) => [c.title, c]));

const affiliationColumns = {};
for (const [field, spec] of Object.entries(AFFILIATION_FIELDS)) {
  affiliationColumns[field] = await ensureColumn(affiliationsBoardId, affiliationsBoard.name, affiliationsByTitle, spec);
}

const personColumn = affiliationsByTitle.get(PERSON_LINK_TITLE);
if (!personColumn) {
  console.error(
    `setup-affiliation-columns: Affiliations board ${affiliationsBoardId} (${affiliationsBoard.name}) has no ` +
    `"${PERSON_LINK_TITLE}" column — it must already exist (board_relation to People / People Historical) ` +
    `before this script can wire up the config. This script never creates it.`);
  process.exit(1);
}
if (personColumn.type !== 'board_relation') {
  console.error(
    `setup-affiliation-columns: Affiliations board ${affiliationsBoardId}'s "${PERSON_LINK_TITLE}" column ` +
    `is type "${personColumn.type}", not board_relation — refusing to use it as personLink.`);
  process.exit(1);
}
affiliationColumns.personLink = personColumn.id;

// People boards: ensure Organizational Giving on each. Organizations boards have no
// driven-giving concept and are meant to be omitted from the argument list — this loop
// only sees what's passed on the command line.
const organizationalGivingByBoard = {};
for (const boardId of peopleBoardIds) {
  const board = await getBoard(boardId);
  const byTitle = new Map(board.columns.map((c) => [c.title, c]));
  organizationalGivingByBoard[boardId] = await ensureColumn(boardId, board.name, byTitle, ORGANIZATIONAL_GIVING);
}

// Donations board's "Acting for" column — read the board id from config, not the command
// line, since it's already recorded there and the whole point is to reduce copy/paste.
let actingForNote = null;
try {
  const configIdx = process.argv.indexOf('--config');
  const configPath = configIdx >= 0 ? process.argv[configIdx + 1] : new URL('../config/svbc.json', import.meta.url);
  const config = JSON.parse(await (await import('node:fs/promises')).readFile(configPath, 'utf8'));
  const donationBoards = config.donationRollups?.donationBoards ?? [];
  for (const b of donationBoards) {
    const board = await getBoard(b.boardId);
    const actingFor = board.columns.find((c) => c.title === 'Acting for');
    if (actingFor) {
      actingForNote = { donationsBoardId: b.boardId, actingForColumnId: actingFor.id };
      break;
    }
    console.error(`setup-affiliation-columns: Donations board ${b.boardId} (${board.name}) has no "Acting for" column — checked, not found.`);
  }
} catch (err) {
  console.error(`setup-affiliation-columns: could not read the config file to look up the Donations board's "Acting for" column: ${err instanceof Error ? err.message : String(err)}`);
}

console.log(JSON.stringify({
  affiliations: { boardId: Number(affiliationsBoardId), columns: affiliationColumns },
  organizationalGivingByBoard,
}, null, 2));

if (actingForNote) {
  console.error(
    `\nsetup-affiliation-columns: paste "${actingForNote.actingForColumnId}" into ` +
    `donationRollups.donationBoards[].columns.actingForLink for Donations board ${actingForNote.donationsBoardId} ` +
    `(it is required once "affiliations" is non-null).`);
} else {
  console.error(
    '\nsetup-affiliation-columns: could not find an "Acting for" column on any configured Donations board — ' +
    'create it there first, then set donationRollups.donationBoards[].columns.actingForLink to its id ' +
    '(required once "affiliations" is non-null).');
}
