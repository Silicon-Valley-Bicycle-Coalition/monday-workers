#!/usr/bin/env node
// Moves purchased wealth-screening (Windfall) data off the two Monday People boards onto a private
// Wealth Screening board, proves the copy, then deletes the source columns. One-time; run by David
// with his own token, never a Worker's. Design:
// docs/superpowers/specs/2026-11-06-windfall-private-board-design.md
//
//   # every board in any state with a Windfall ID column
//   MONDAY_API_TOKEN=... node scripts/windfall-board.mjs inventory --workspace 111 --workspace 222
//   # create the private board, its columns and one item per person with a value; dry run by default
//   MONDAY_API_TOKEN=... node scripts/windfall-board.mjs copy --workspace 111 --people 201 --historical 202 [--apply]
//   # resume or top up an existing board; a re-run skips anyone already linked by Person
//   ... copy --workspace 111 --people 201 --historical 202 --board 9001 [--name "Wealth Screening"] [--apply]
//   # value-for-value check plus who can see the board. --subscriber is the exact expected list, the
//   # board owner included
//   ... verify --people 201 --historical 202 --board 9001 --subscriber 1 --subscriber 2
//   # runs all of verify, then lists (dry run) or deletes (--apply) the 11 columns on both boards
//   ... delete-people-columns --people 201 --historical 202 --board 9001 --subscriber 1 --subscriber 2 [--apply]
//
// Values never reach the console or disk. Reports hold counts and Monday ids only, not even item
// names, and a Monday error's message is never forwarded, since it can echo the write it refused.
// Only its status and code are printed.
//
// Archived items are not read: items_page skips them and they report empty board_relation values
// (donation-rollups/scripts/bootstrap-links-from-artifacts.mjs). Every command that compares says so.
//
// The delete has one gate. deleteVerifiedColumns() is the only caller of delete_column, it takes
// only what verifyAll() returned in this process, and it re-reads each column's title just before
// deleting that column id. After a partial delete, verify fails by design on the missing titles,
// so the rest is finished by hand in Monday.
//
// Exit 0: nothing wrong. Exit 1: a check failed. Exit 2: usage or API error, or a write whose
// outcome is unknown. Dry runs send no mutation.

import { fileURLToPath } from 'node:url';
import { AmbiguousWriteError, MondayApiError, MondayGraphQL } from '../monday-backup/src/monday/graphql.ts';
import { bareTitle } from './lib/column-titles.mjs';
import { FORBIDDEN_USERS, WINDFALL_TITLES, formatReport, isClean, planItems, reconcile, valueToWrite } from './lib/windfall-board.mjs';

const API_URL = 'https://api.monday.com/v2';
const ITEM_PAGE_SIZE = 500;
export const MAX_ITEM_PAGES = 100; // 50,000 items: well past either People board
const BOARD_PAGE_SIZE = 100;
const MAX_BOARD_PAGES = 50;
const PERSON_TITLE = 'Person';
const BOARD_NAME = 'Wealth Screening';
const CURRENCY_TITLES = new Set(['Net Worth', 'Net Worth Low', 'Net Worth High']);
const CURRENCY_DEFAULTS = JSON.stringify({ unit: { symbol: '$', direction: 'left', precision: 2 } });
const ARCHIVED_NOTE = "Archived People items aren't read, so their values are neither copied nor compared.";

const USAGE = `usage: MONDAY_API_TOKEN=... node scripts/windfall-board.mjs <command>
  inventory --workspace <id>...
  copy --workspace <id> --people <id> --historical <id> [--board <id>] [--name "${BOARD_NAME}"] [--apply]
  verify --people <id> --historical <id> --board <id> --subscriber <userId>...
  delete-people-columns --people <id> --historical <id> --board <id> --subscriber <userId>... [--apply]`;

const BOARDS_TRIO = ['--people', '--historical', '--board'];
const COMMANDS = {
  inventory: { required: ['--workspace'], optional: [] },
  copy: { required: ['--workspace', '--people', '--historical'], optional: ['--board', '--name', '--apply'] },
  verify: { required: [...BOARDS_TRIO, '--subscriber'], optional: [] },
  'delete-people-columns': { required: [...BOARDS_TRIO, '--subscriber'], optional: ['--apply'] },
};
const LIST_FLAGS = new Set(['--workspace', '--subscriber']);

const numeric = (v, flag) => {
  if (!/^\d+$/.test(v)) throw new Error(`${flag} must be numeric, got "${v}"`);
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
    if (flag === '--apply') {
      seen.set(flag, true);
      continue;
    }
    if (seen.has(flag) && !LIST_FLAGS.has(flag)) throw new Error(`${flag} can only be given once`);
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--name') {
      if (argv[i + 1].trim() === '') throw new Error('--name must not be empty');
      seen.set(flag, argv[++i]);
    } else if (LIST_FLAGS.has(flag)) {
      const values = seen.get(flag) ?? [];
      do values.push(numeric(argv[++i], flag));
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--'));
      seen.set(flag, values);
    } else {
      seen.set(flag, numeric(argv[++i], flag));
    }
  }
  for (const flag of spec.required) if (!seen.has(flag)) throw new Error(`${flag} is required for ${command}`);

  const args = {
    command,
    workspaces: seen.get('--workspace') ?? [],
    people: seen.get('--people') ?? null,
    historical: seen.get('--historical') ?? null,
    board: seen.get('--board') ?? null,
    name: seen.get('--name') ?? BOARD_NAME,
    subscribers: seen.get('--subscriber') ?? [],
    apply: seen.get('--apply') === true,
  };
  if (command === 'copy' && args.workspaces.length !== 1) throw new Error('--workspace takes exactly one id for copy');
  const roles = [args.people, args.historical, args.board].filter((id) => id !== null);
  if (new Set(roles).size !== roles.length) throw new Error('--people, --historical and --board must be different boards');
  return args;
}

// A failed check: the message is ours, ids and titles only. Exit 1.
class CheckFailed extends Error {}
// A stop that isn't a check, such as a page cap: the message is ours. Exit 2.
class Stopped extends Error {}

// Never a Monday message: it can echo the variables of the call that failed.
function describeFailure(error) {
  if (error instanceof Stopped) return error.message;
  const facts = [];
  if (error instanceof MondayApiError) {
    if (error.httpStatus !== undefined) facts.push(`HTTP ${error.httpStatus}`);
    if (typeof error.code === 'string' && /^\w{1,64}$/.test(error.code)) facts.push(error.code);
  }
  return `Monday call failed${facts.length > 0 ? ` (${facts.join(', ')})` : ''}; its message is withheld because it can echo a value.`;
}

const ids = (list) => (list ?? []).map((x) => String(x.id));

async function readBoard(gql, id) {
  const data = await gql(
    `query ($ids: [ID!]) {
       boards(ids: $ids) {
         id board_kind
         subscribers { id }
         team_subscribers { id }
         columns { id title type }
       }
     }`,
    { ids: [id] },
  );
  const b = data.boards?.[0];
  if (!b) return null;
  return {
    id: String(b.id),
    kind: b.board_kind,
    subscribers: ids(b.subscribers),
    teams: ids(b.team_subscribers),
    columns: (b.columns ?? []).map((c) => ({ id: String(c.id), title: c.title, type: c.type })),
  };
}

async function listWorkspaceBoards(gql, workspace, fields) {
  const boards = [];
  for (let page = 1; page <= MAX_BOARD_PAGES; page++) {
    const data = await gql(
      `query ($ws: [ID!], $limit: Int, $page: Int) {
         boards(workspace_ids: $ws, limit: $limit, page: $page, state: all) { ${fields} }
       }`,
      { ws: [workspace], limit: BOARD_PAGE_SIZE, page },
    );
    boards.push(...data.boards);
    if (data.boards.length < BOARD_PAGE_SIZE) return boards;
  }
  throw new Stopped(`Workspace ${workspace} has more boards than the page cap (${MAX_BOARD_PAGES} pages); nothing was truncated, the run stopped.`);
}

const ITEM_FIELDS = `cursor items {
  id name
  column_values(ids: $cols) { id type value ... on BoardRelationValue { linked_item_ids } }
}`;

// Every item with every requested cell. A cell Monday left out would read as empty and could pass a
// comparison on nothing, so it stops the run instead.
async function readItems(gql, boardId, cols) {
  const first = await gql(
    `query ($ids: [ID!], $cols: [String!]) { boards(ids: $ids) { items_page(limit: ${ITEM_PAGE_SIZE}) { ${ITEM_FIELDS} } } }`,
    { ids: [boardId], cols },
  );
  let page = first.boards?.[0]?.items_page;
  if (!page) throw new Stopped(`Board ${boardId} returned no items page.`);
  const items = [...page.items];
  let pages = 1;
  while (page.cursor) {
    if (pages >= MAX_ITEM_PAGES) {
      throw new Stopped(`Board ${boardId} goes past the page cap (${MAX_ITEM_PAGES} pages of ${ITEM_PAGE_SIZE}); nothing was truncated, the run stopped.`);
    }
    const next = await gql(
      `query ($cursor: String!, $cols: [String!]) { next_items_page(limit: ${ITEM_PAGE_SIZE}, cursor: $cursor) { ${ITEM_FIELDS} } }`,
      { cursor: page.cursor, cols },
    );
    page = next.next_items_page;
    items.push(...page.items);
    pages += 1;
  }
  for (const item of items) {
    const got = new Set((item.column_values ?? []).map((c) => c.id));
    if (cols.some((c) => !got.has(c))) throw new Stopped(`Board ${boardId} item ${item.id}: Monday left out a requested column.`);
  }
  return items;
}

// The one column per title on a board, plus what's wrong. `title -> column`, never by exact title.
function resolveTitles(board, titles) {
  const byTitle = new Map();
  const failures = [];
  const missing = [];
  for (const title of titles) {
    const matches = board.columns.filter((c) => bareTitle(c.title) === title);
    if (matches.length === 1) byTitle.set(title, matches[0]);
    else if (matches.length === 0) missing.push(title);
    else failures.push(`Board ${board.id}: "${title}" is on ${matches.length} columns (${matches.map((c) => c.id).join(', ')}).`);
  }
  return { byTitle, missing, failures };
}

// Both People boards: each title on exactly one column of each, and the same type on both.
function resolveSources(boards) {
  const failures = [];
  const sources = [];
  for (const board of boards) {
    const r = resolveTitles(board, WINDFALL_TITLES);
    failures.push(...r.failures);
    for (const title of r.missing) failures.push(`Board ${board.id}: no "${title}" column.`);
    sources.push({ boardId: board.id, byTitle: r.byTitle });
  }
  const types = new Map();
  for (const title of WINDFALL_TITLES) {
    const found = sources.map((s) => s.byTitle.get(title)?.type).filter((t) => t !== undefined);
    if (new Set(found).size > 1) failures.push(`"${title}" has different types on the People boards: ${found.join(', ')}.`);
    if (found.length > 0) types.set(title, found[0]);
  }
  return { sources, types, failures };
}

// The private board's columns against the sources' types. `missing` is for copy to create; verify
// treats it as a failure.
function resolveTarget(board, types) {
  const r = resolveTitles(board, [...WINDFALL_TITLES, PERSON_TITLE]);
  const failures = [...r.failures];
  for (const title of WINDFALL_TITLES) {
    const col = r.byTitle.get(title);
    if (col && col.type !== types.get(title)) {
      failures.push(`Board ${board.id}: "${title}" is ${col.type}, the People boards have ${types.get(title)}.`);
    }
  }
  const person = r.byTitle.get(PERSON_TITLE) ?? null;
  r.byTitle.delete(PERSON_TITLE);
  if (person && person.type !== 'board_relation') failures.push(`Board ${board.id}: "${PERSON_TITLE}" is ${person.type}, not board_relation.`);
  return { byTitle: r.byTitle, person, missing: r.missing, failures };
}

const cellsOf = (item, titleById) => {
  const values = {};
  for (const c of item.column_values) {
    const title = titleById.get(c.id);
    if (title) values[title] = { type: c.type, value: c.value };
  }
  return values;
};

const titleByIdOf = (byTitle) => new Map([...byTitle].map(([title, col]) => [col.id, title]));

async function readPeople(gql, source) {
  const titleById = titleByIdOf(source.byTitle);
  const items = await readItems(gql, source.boardId, [...titleById.keys()]);
  return items.map((item) => ({ itemId: String(item.id), name: item.name, values: cellsOf(item, titleById) }));
}

async function readAllPeople(gql, sources, out) {
  const people = [];
  for (const source of sources) {
    const rows = await readPeople(gql, source);
    out(`Board ${source.boardId}: ${rows.length} People row(s) read.`);
    people.push(...rows);
  }
  out(ARCHIVED_NOTE);
  return people;
}

const personIdsOf = (item, personColumnId) => {
  const cell = item.column_values.find((c) => c.id === personColumnId);
  return (cell?.linked_item_ids ?? []).map(String);
};

async function readBoardRows(gql, boardId, target) {
  const titleById = titleByIdOf(target.byTitle);
  const items = await readItems(gql, boardId, [...titleById.keys(), target.person.id]);
  return items.map((item) => ({
    personIds: personIdsOf(item, target.person.id),
    values: cellsOf(item, titleById),
  }));
}

// Everything that has to hold before the delete. Failures are ids and titles only.
async function verifyAll(args, { gql, out, err }) {
  const failures = [];
  const found = async (id) => {
    const board = await readBoard(gql, id);
    if (!board) failures.push(`Board ${id} not found, or not visible to this token.`);
    return board;
  };
  const peopleBoard = await found(args.people);
  const historicalBoard = await found(args.historical);
  const board = await found(args.board);

  let sources = [];
  let result = null;
  if (peopleBoard && historicalBoard && board) {
    const resolved = resolveSources([peopleBoard, historicalBoard]);
    const target = resolveTarget(board, resolved.types);
    const columnFailures = [...resolved.failures, ...target.failures];
    for (const title of target.missing) columnFailures.push(`Board ${board.id}: no "${title}" column.`);
    failures.push(...columnFailures);
    sources = resolved.sources;
    if (columnFailures.length === 0) {
      const people = await readAllPeople(gql, sources, out);
      const items = await readBoardRows(gql, board.id, target);
      result = reconcile(people, items);
      out(formatReport(result));
      if (!isClean(result)) failures.push('The reconciliation is not clean.');
      if (people.length === 0) failures.push('Read zero people in total, so there is nothing to prove.');
      if (items.length === 0) failures.push(`Board ${board.id} has zero items, so there is nothing to prove.`);
    }
  }

  if (board) {
    failures.push(...privacyFailures(board, args.subscribers));
    const data = await gql('query ($ids: [ID!]) { users(ids: $ids) { id is_admin } }', { ids: FORBIDDEN_USERS });
    const users = new Map((data.users ?? []).map((u) => [String(u.id), u]));
    // Each id probably exists in only one account, so one absent is expected. Neither proves nothing.
    if (!FORBIDDEN_USERS.some((id) => users.has(id))) {
      failures.push('The API returned neither forbidden user, so the admin check proves nothing.');
    }
    for (const id of FORBIDDEN_USERS) {
      if (!users.has(id)) out(`Forbidden user ${id} not found by the API; that's only a failure if subscribed.`);
      else if (users.get(id).is_admin !== false) failures.push(`Forbidden user ${id} is an account admin, or the API wouldn't say.`);
    }
  }

  for (const failure of failures) err(`FAIL: ${failure}`);
  const ok = failures.length === 0 && result !== null && isClean(result);
  out(ok ? 'Verify: passed.' : `Verify: FAILED (${failures.length}).`);
  return { ok, sources };
}

function privacyFailures(board, expected) {
  const failures = [];
  if (board.kind !== 'private') failures.push(`Board ${board.id} is ${board.kind}, not private.`);
  const want = new Set(expected);
  const have = new Set(board.subscribers);
  for (const id of have) if (!want.has(id)) failures.push(`Board ${board.id}: user ${id} is subscribed and not in --subscriber.`);
  for (const id of want) if (!have.has(id)) failures.push(`Board ${board.id}: user ${id} is in --subscriber and not subscribed.`);
  for (const id of board.teams) failures.push(`Board ${board.id}: team ${id} is subscribed.`);
  for (const id of FORBIDDEN_USERS) if (have.has(id)) failures.push(`Board ${board.id}: forbidden user ${id} is subscribed.`);
  return failures;
}

// Copy's check on the board it's about to write to. No expected subscriber list exists yet, but
// values must never land where a Worker token could read them.
function assertSafeToWrite(board) {
  if (board.kind !== 'private') throw new CheckFailed(`Board ${board.id} reads ${board.kind}, not private. Nothing was written to it.`);
  for (const id of FORBIDDEN_USERS) {
    if (board.subscribers.includes(id)) throw new CheckFailed(`Board ${board.id}: forbidden user ${id} is subscribed. Nothing was written to it.`);
  }
}

// What each planned person's create_item will carry. Built before any write, so a cell that can't
// be read stops the copy before it starts.
function buildWrites(plan) {
  const writes = [];
  const unreadable = [];
  for (const person of plan) {
    const values = {};
    try {
      for (const title of WINDFALL_TITLES) {
        const value = valueToWrite(title, person.values[title]);
        if (value !== null) values[title] = value;
      }
      writes.push({ person, values });
    } catch {
      unreadable.push(person.itemId);
    }
  }
  if (unreadable.length > 0) {
    throw new CheckFailed(`Unreadable Windfall value on People item(s): ${unreadable.join(', ')}. Nothing was written.`);
  }
  return writes;
}

async function createColumn(gql, board, title, type, defaults) {
  await gql(
    `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
       create_column(board_id: $board, title: $title, column_type: $type, defaults: $defaults) { id }
     }`,
    { board, title, type, defaults },
    { idempotent: false },
  );
}

async function createPrivateBoard(gql, args, out) {
  const data = await gql(
    `mutation ($name: String!, $workspace: ID!) {
       create_board(board_name: $name, board_kind: private, workspace_id: $workspace) { id }
     }`,
    { name: args.name, workspace: args.workspaces[0] },
    { idempotent: false },
  );
  const id = String(data.create_board.id);
  out(`Created board ${id}.`);
  return id;
}

async function firstItemsPage(gql, boardId) {
  const data = await gql(
    `query ($ids: [ID!]) { boards(ids: $ids) { items_page(limit: ${ITEM_PAGE_SIZE}) { cursor items { id } } } }`,
    { ids: [boardId] },
  );
  const page = data.boards?.[0]?.items_page;
  if (!page) throw new Stopped(`Board ${boardId} returned no items page.`);
  return page;
}

// Who the board already has, for the re-run skip. If it has rows but no links, the scan can't tell
// who's been copied (links reading empty, or no Person column), and trusting it would recreate
// everyone. So that stops the copy, dry run included. Some unlinked rows among linked ones are fine:
// they're left alone, and verify counts them as extra.
async function scanLinks(gql, board, target, out) {
  const linked = new Set();
  let rows = 0;
  let unlinked = 0;
  if (target.person) {
    for (const item of await readItems(gql, board.id, [target.person.id])) {
      const personIds = personIdsOf(item, target.person.id);
      rows += 1;
      if (personIds.length === 0) unlinked += 1;
      for (const id of personIds) linked.add(id);
    }
  } else {
    rows = (await firstItemsPage(gql, board.id)).items.length;
    unlinked = rows;
  }
  out(`Board ${board.id}: ${rows} row(s) scanned, ${unlinked} with no Person link, ${linked.size} person link(s).`);
  if (rows > 0 && linked.size === 0) {
    throw new CheckFailed(
      `Board ${board.id} has rows and no Person links, so copy can't tell who's already there and would recreate everyone. Nothing was written. Check its ${target.person ? 'Person column' : 'missing Person column'}, or clear the rows if they're unwanted.`,
    );
  }
  return linked;
}

// Only ever called on a board this run just created, before its first create_item.
async function deleteSeedItems(gql, boardId, out) {
  const page = await firstItemsPage(gql, boardId);
  if (page.cursor) throw new Stopped(`Board ${boardId} is new but holds more than one page of items.`);
  for (const item of page.items) {
    await gql('mutation ($id: ID!) { delete_item(item_id: $id) { id } }', { id: item.id }, { idempotent: false });
  }
  out(`Removed ${page.items.length} item(s) Monday seeded on the new board.`);
}

async function createItems(gql, boardId, target, writes, { out, err }) {
  let created = 0;
  for (const { person, values } of writes) {
    const columnValues = { [target.person.id]: { item_ids: [Number(person.itemId)] } };
    for (const [title, value] of Object.entries(values)) columnValues[target.byTitle.get(title).id] = value;
    try {
      await gql(
        `mutation ($board: ID!, $name: String!, $values: JSON!) {
           create_item(board_id: $board, item_name: $name, column_values: $values) { id }
         }`,
        { board: boardId, name: person.name, values: JSON.stringify(columnValues) },
        { idempotent: false },
      );
      created += 1;
    } catch (error) {
      const again = `Re-run copy with --board ${boardId}; it rescans Person links, so that's safe.`;
      if (error instanceof AmbiguousWriteError) {
        err(`The write for People item ${person.itemId} may or may not have committed. ${created} item(s) created so far. ${again}`);
      } else {
        err(`Could not create the item for People item ${person.itemId}. ${describeFailure(error)} ${created} item(s) created so far. ${again}`);
      }
      return 2;
    }
  }
  out(`Created ${created} item(s) on board ${boardId}.`);
  return 0;
}

async function cmdCopy(args, { gql, out, err }) {
  const [workspace] = args.workspaces;
  const boards = [];
  for (const id of [args.people, args.historical]) {
    const board = await readBoard(gql, id);
    if (!board) throw new CheckFailed(`Board ${id} not found, or not visible to this token.`);
    boards.push(board);
  }
  const resolved = resolveSources(boards);
  if (resolved.failures.length > 0) throw new CheckFailed(resolved.failures.join('\n'));

  let board = null;
  if (args.board) {
    board = await readBoard(gql, args.board);
    if (!board) throw new CheckFailed(`Board ${args.board} not found, or not visible to this token.`);
    assertSafeToWrite(board);
  } else {
    const clash = (await listWorkspaceBoards(gql, workspace, 'id name state')).find((b) => b.name === args.name);
    if (clash) {
      throw new CheckFailed(`Workspace ${workspace} already has a board of that name: ${clash.id} (${clash.state}). Pass --board ${clash.id}, or --name for a new one.`);
    }
  }

  const people = await readAllPeople(gql, resolved.sources, out);

  let target = board ? resolveTarget(board, resolved.types) : null;
  if (target && target.failures.length > 0) throw new CheckFailed(target.failures.join('\n'));
  const linked = board ? await scanLinks(gql, board, target, out) : new Set();
  const plan = planItems(people, linked);
  const writes = buildWrites(plan);

  const columnsToCreate = target ? target.missing.length : WINDFALL_TITLES.length + 1;
  if (!args.apply) {
    out(`DRY RUN: ${board ? `board ${board.id}` : 'would create a private board'}, ${columnsToCreate} column(s) to create, ${linked.size} person link(s) already there.`);
    out(`Would create ${writes.length} item(s). Re-run with --apply. Nothing was changed.`);
    return 0;
  }

  let boardId = board?.id ?? null;
  try {
    if (!board) {
      boardId = await createPrivateBoard(gql, args, out);
      // Monday may answer differently from what was requested, so re-read rather than trust it.
      board = await readBoard(gql, boardId);
      if (!board) throw new CheckFailed(`Board ${boardId} can't be read back. Nothing was written to it.`);
      assertSafeToWrite(board);
      await deleteSeedItems(gql, boardId, out);
      target = resolveTarget(board, resolved.types);
      // A column Monday seeded can clash with a title. Nothing here deletes columns: that's the
      // delete command's gate, so the operator clears it and resumes.
      if (target.failures.length > 0) {
        throw new CheckFailed(`${target.failures.join('\n')}\nRemove or rename it in Monday, then re-run copy with --board ${boardId}.`);
      }
    }

    for (const title of target.missing) {
      if (title === PERSON_TITLE) {
        const connect = JSON.stringify({ boardIds: [Number(args.people), Number(args.historical)] });
        await createColumn(gql, boardId, PERSON_TITLE, 'board_relation', connect);
      } else {
        const type = resolved.types.get(title);
        const defaults = type === 'numbers' && CURRENCY_TITLES.has(title) ? CURRENCY_DEFAULTS : undefined;
        await createColumn(gql, boardId, title, type, defaults);
      }
    }
    if (target.missing.length > 0) {
      out(`Created ${target.missing.length} column(s) on board ${boardId}.`);
      const reread = await readBoard(gql, boardId);
      if (!reread) throw new CheckFailed(`Board ${boardId} can't be read back.`);
      target = resolveTarget(reread, resolved.types);
      const problems = [...target.failures, ...target.missing.map((t) => `Board ${boardId}: no "${t}" column.`)];
      if (problems.length > 0) throw new CheckFailed(problems.join('\n'));
    }
  } catch (error) {
    if (!(error instanceof AmbiguousWriteError)) throw error;
    if (boardId === null) {
      err(`create_board may or may not have committed. Look for the board in workspace ${workspace}: re-run copy with --board <id> if it's there, or re-run as before if not.`);
    } else {
      err(`A write on board ${boardId} may or may not have committed. Re-run copy with --board ${boardId}; it re-reads the board, so that's safe.`);
    }
    return 2;
  }

  return createItems(gql, boardId, target, writes, { out, err });
}

async function cmdVerify(args, ctx) {
  return (await verifyAll(args, ctx)).ok ? 0 : 1;
}

const planned = (verified) =>
  verified.sources.flatMap((source) =>
    WINDFALL_TITLES.map((title) => ({ boardId: source.boardId, title, column: source.byTitle.get(title) })),
  );

// The only path to delete_column. It deletes exactly the ids verifyAll() resolved, each only after a
// fresh read shows that id still holds the title it was verified under.
async function deleteVerifiedColumns(gql, verified, { out, err }) {
  if (verified.ok !== true) throw new CheckFailed('Refusing to delete: verify did not pass.');
  const targets = planned(verified);
  let deleted = 0;
  const left = () => targets.slice(deleted).map((t) => t.column.id).join(', ');
  const partial = () =>
    `Deleted ${deleted} of ${targets.length} columns. Not deleted: ${left()}. Verify now fails by design on the missing titles, so finish in Monday by hand.`;
  for (const { boardId, title, column } of targets) {
    try {
      const data = await gql(
        'query ($ids: [ID!], $column: [String!]) { boards(ids: $ids) { columns(ids: $column) { id title } } }',
        { ids: [boardId], column: [column.id] },
      );
      const current = data.boards?.[0]?.columns?.[0];
      const bare = typeof current?.title === 'string' ? bareTitle(current.title) : null;
      if (bare !== title || !WINDFALL_TITLES.includes(bare)) {
        err(`Board ${boardId} column ${column.id} no longer reads "${title}". Stopped. ${partial()}`);
        return 1;
      }
      await gql(
        'mutation ($board: ID!, $column: String!) { delete_column(board_id: $board, column_id: $column) { id } }',
        { board: boardId, column: column.id },
        { idempotent: false },
      );
    } catch (error) {
      const what =
        error instanceof AmbiguousWriteError
          ? `Deleting board ${boardId} column ${column.id} may or may not have committed.`
          : `Stopped at board ${boardId} column ${column.id}. ${describeFailure(error)}`;
      err(`${what} ${partial()}`);
      return 2;
    }
    deleted += 1;
    out(`Deleted board ${boardId} column ${column.id} (${title}).`);
  }

  let remaining = 0;
  for (const { boardId } of verified.sources) {
    const board = await readBoard(gql, boardId);
    if (!board) throw new CheckFailed(`Board ${boardId} can't be read back.`);
    for (const c of board.columns) {
      if (WINDFALL_TITLES.includes(bareTitle(c.title))) {
        remaining += 1;
        err(`FAIL: board ${boardId} column ${c.id} (${c.title}) remains.`);
      }
    }
  }
  if (remaining > 0) return 1;
  out(`Deleted all ${targets.length} columns. A re-read of both People boards shows none remain.`);
  return 0;
}

async function cmdDelete(args, ctx) {
  const { gql, out, err } = ctx;
  // Run here, in this process, every time: the dry run's verify is never carried over to --apply.
  const verified = await verifyAll(args, ctx);
  if (!verified.ok) {
    err('Stopped: verify failed. Nothing was deleted.');
    return 1;
  }
  for (const { boardId, column } of planned(verified)) out(`  board ${boardId}: ${column.id}  ${column.title}`);
  if (!args.apply) {
    out('DRY RUN: re-run with --apply to delete these. Nothing was changed.');
    return 0;
  }
  return deleteVerifiedColumns(gql, verified, { out, err });
}

async function cmdInventory(args, { gql, out }) {
  const fields = 'id state board_kind subscribers { id } team_subscribers { id } columns { title }';
  let total = 0;
  for (const workspace of args.workspaces) {
    const boards = await listWorkspaceBoards(gql, workspace, fields);
    const withWindfall = boards.filter((b) => (b.columns ?? []).some((c) => bareTitle(c.title) === 'Windfall ID'));
    out(`Workspace ${workspace}: ${withWindfall.length} board(s) with a Windfall ID column, of ${boards.length}.`);
    for (const b of withWindfall) {
      out(`  ${b.id}  state=${b.state}  kind=${b.board_kind}  subscribers=[${ids(b.subscribers).join(', ')}]  teams=[${ids(b.team_subscribers).join(', ')}]`);
    }
    total += withWindfall.length;
  }
  out(`Total: ${total}.`);
  return 0;
}

const HANDLERS = {
  inventory: cmdInventory,
  copy: cmdCopy,
  verify: cmdVerify,
  'delete-people-columns': cmdDelete,
};

export async function run(args, { gql, out, err = out }) {
  try {
    return await HANDLERS[args.command](args, { gql, out, err });
  } catch (error) {
    if (error instanceof CheckFailed) {
      err(`FAIL: ${error.message}`);
      return 1;
    }
    err(describeFailure(error));
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
