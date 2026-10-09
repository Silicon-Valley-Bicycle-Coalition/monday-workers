#!/usr/bin/env node
// Makes the production donor boards private after the cutover load, and prints who is subscribed
// to each, so the operator can subscribe only the users that need them (#41, follow-up to #18).
//
// Why: Monday shows every Main board in every open workspace to every team member, and by default
// lets them edit it. `salesforce-import` creates its boards `board_kind: public`, so after the
// load every member token — the shared Sandbox Integration user and the public-facing
// `member-portal` user included — can read and edit the donor boards. Only a *private* board is
// limited to its subscribers. See the root README, "A Monday user's access is wider than it looks".
//
//   # dry run (default): list the matching boards, their kind and subscribers; change nothing
//   MONDAY_API_TOKEN=... node scripts/make-boards-private.mjs --workspace 123 --prefix "SVBC "
//   # same, explicit board ids
//   MONDAY_API_TOKEN=... node scripts/make-boards-private.mjs --workspace 123 --board 111 --board 222
//   # change them to private, then re-read and print the result
//   MONDAY_API_TOKEN=... node scripts/make-boards-private.mjs --workspace 123 --prefix "SVBC " --apply
//   # also fail if the Sandbox Integration user is subscribed to any selected board
//   ... --sandbox-user 12345678
//
// The token must belong to a user who can change the boards' kind (the board owner or an admin);
// use the load's own user or an admin, not a Worker integration user.
//
// Mutation (verified against the Monday GraphQL schema, 2026-10-09): `change_board_kind(board_id:
// ID!, kind: BoardKindInput!)` with kind PUBLIC | PRIVATE | SHARE, returning { id board_kind }.
// `update_board` cannot do this — its `BoardAttributes` enum is only communication, description,
// item_nickname and name. Changing a board to private leaves existing subscribers in place;
// adding or removing subscribers is a separate step (this script only reports them).
//
// Exit 0: nothing wrong. Exit 1: the Sandbox Integration user is subscribed to a selected board,
// or --apply left a board not private. Exit 2: usage or API error. Dry-run writes nothing; --apply
// writes only `change_board_kind` for boards that are not already private.

import { fileURLToPath } from 'node:url';
// The repo's single API-Version pin (#39), from the canonical transport.
import { MONDAY_API_VERSION } from '../monday-backup/src/monday/graphql.ts';

const API_URL = 'https://api.monday.com/v2';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

const USAGE =
  'usage: MONDAY_API_TOKEN=... node scripts/make-boards-private.mjs --workspace <id> (--prefix <text> | --board <id>)... [--sandbox-user <id>] [--apply]';

export function parseArgs(argv) {
  const args = { workspace: null, prefixes: [], boardIds: [], sandboxUser: null, apply: false };
  const value = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  const numeric = (v, flag) => {
    if (!/^\d+$/.test(v)) throw new Error(`${flag} must be numeric, got "${v}"`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--workspace':
        args.workspace = numeric(value(i++, '--workspace'), '--workspace');
        break;
      case '--prefix': {
        const prefix = value(i++, '--prefix');
        if (prefix === '') throw new Error('--prefix must not be empty');
        args.prefixes.push(prefix);
        break;
      }
      case '--board':
        args.boardIds.push(numeric(value(i++, '--board'), '--board'));
        break;
      case '--sandbox-user':
        args.sandboxUser = numeric(value(i++, '--sandbox-user'), '--sandbox-user');
        break;
      case '--apply':
        args.apply = true;
        break;
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (args.workspace === null) throw new Error('--workspace <id> is required');
  if (args.prefixes.length === 0 && args.boardIds.length === 0) {
    throw new Error('name the boards: at least one --prefix <text> or --board <id> is required');
  }
  return args;
}

// Pure: the boards `args` selects out of everything in the workspace. Never matches a board in
// another workspace, whatever its id or name.
export function selectBoards(boards, { workspace, prefixes, boardIds }) {
  const ids = new Set(boardIds.map(String));
  return boards.filter(
    (b) =>
      String(b.workspace_id) === String(workspace) &&
      (ids.has(String(b.id)) || prefixes.some((p) => b.name.startsWith(p)))
  );
}

// Pure: what to do to each selected board, and what is wrong with it. `sandboxUser` is the
// Sandbox Integration user's id; it must be on no donor board.
export function buildPlan(boards, { boardIds = [], sandboxUser = null } = {}) {
  const found = new Set(boards.map((b) => String(b.id)));
  const missing = boardIds.map(String).filter((id) => !found.has(id));
  const entries = boards.map((b) => {
    const users = b.subscribers ?? [];
    const teams = b.team_subscribers ?? [];
    return {
      id: String(b.id),
      name: b.name,
      kind: b.board_kind,
      action: b.board_kind === 'private' ? 'keep' : 'make-private',
      users,
      teams,
      sandboxUserSubscribed: sandboxUser !== null && users.some((u) => String(u.id) === String(sandboxUser)),
    };
  });
  return {
    entries,
    missing,
    toChange: entries.filter((e) => e.action === 'make-private').length,
    sandboxViolations: entries.filter((e) => e.sandboxUserSubscribed).map((e) => e.id),
  };
}

const person = (u) => `${u.name} (${u.id}${u.is_guest ? ', guest' : ''})`;

// Pure: the report. `applied` says the plan was already carried out, so kinds are the re-read ones.
export function formatPlan(plan, { apply = false, applied = false, sandboxUser = null } = {}) {
  const lines = [];
  const mode = applied ? 'APPLIED' : apply ? 'APPLY' : 'DRY RUN';
  lines.push(`${mode}: ${plan.entries.length} board(s) selected, ${plan.toChange} not private`);
  for (const e of plan.entries) {
    const verb = applied ? (e.kind === 'private' ? 'private' : `STILL ${e.kind}`) : e.action === 'keep' ? 'already private' : `${e.kind} -> private`;
    lines.push(`  ${e.id.padEnd(12)} ${e.name}  [${verb}]`);
    lines.push(`      users: ${e.users.length === 0 ? '(none)' : e.users.map(person).join(', ')}`);
    lines.push(`      teams: ${e.teams.length === 0 ? '(none)' : e.teams.map((t) => `${t.name} (${t.id})`).join(', ')}`);
    if (e.sandboxUserSubscribed) lines.push(`      !! Sandbox Integration user ${sandboxUser} is subscribed — remove them`);
  }
  for (const id of plan.missing) lines.push(`  ${id.padEnd(12)} NOT FOUND in the workspace (wrong id, archived, or not visible to this token)`);
  if (sandboxUser === null) lines.push('Sandbox Integration user check skipped: pass --sandbox-user <id> to enforce it.');
  if (!apply && !applied && plan.toChange > 0) lines.push('Re-run with --apply to change them. Nothing was changed.');
  return lines.join('\n');
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
    throw new Error(`monday API: HTTP ${res.status}: ${JSON.stringify(body?.errors ?? body?.error_message ?? body).slice(0, 300)}`);
  }
  return body.data;
}

async function listWorkspaceBoards(token, workspace) {
  const boards = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await query(
      token,
      `query ($ws: [ID!], $limit: Int, $page: Int) {
         boards(workspace_ids: $ws, limit: $limit, page: $page, state: active) {
           id name board_kind workspace_id
           subscribers { id name is_guest }
           team_subscribers { id name }
         }
       }`,
      { ws: [workspace], limit: PAGE_SIZE, page }
    );
    boards.push(...data.boards);
    if (data.boards.length < PAGE_SIZE) return boards;
  }
  throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} boards in the workspace; raise MAX_PAGES`);
}

async function makePrivate(token, boardId) {
  const data = await query(
    token,
    'mutation ($id: ID!) { change_board_kind(board_id: $id, kind: PRIVATE) { id board_kind } }',
    { id: boardId }
  );
  return data.change_board_kind;
}

async function main() {
  const token = process.env.MONDAY_API_TOKEN;
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!token) throw new Error('MONDAY_API_TOKEN is not set');
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  const planOptions = { boardIds: args.boardIds, sandboxUser: args.sandboxUser };

  try {
    const selected = selectBoards(await listWorkspaceBoards(token, args.workspace), args);
    const plan = buildPlan(selected, planOptions);
    console.log(formatPlan(plan, { apply: args.apply, sandboxUser: args.sandboxUser }));
    if (plan.entries.length === 0) {
      console.error('No boards matched; nothing to do.');
      return 2;
    }

    let exit = plan.sandboxViolations.length > 0 || plan.missing.length > 0 ? 1 : 0;
    if (args.apply && plan.toChange > 0) {
      for (const e of plan.entries.filter((x) => x.action === 'make-private')) {
        const result = await makePrivate(token, e.id);
        console.log(`  ${e.id}: change_board_kind -> ${result.board_kind}`);
      }
      // Re-read rather than trust the mutation's reply: this is the state that matters.
      const after = buildPlan(selectBoards(await listWorkspaceBoards(token, args.workspace), args), planOptions);
      console.log(formatPlan(after, { apply: true, applied: true, sandboxUser: args.sandboxUser }));
      if (after.entries.some((e) => e.kind !== 'private') || after.sandboxViolations.length > 0) exit = 1;
    }
    return exit;
  } catch (err) {
    // Node reports a network failure as a bare "fetch failed"; the cause says why.
    console.error(err.cause ? `${err.message}: ${err.cause.message ?? err.cause}` : err.message);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
