#!/usr/bin/env node
// Reports what a Monday API token can actually reach, and fails if that is more than the
// workspaces it is meant for (see the root README, "Least-privilege Monday tokens", and #18).
//
// Why this exists: a Monday token carries its user's whole view of the account, and on a
// non-Enterprise plan a *member* sees — and by default can edit — every Main board in every
// workspace, whether or not they were ever added to it. "This integration user only has access
// to workspace X" is therefore a claim to measure, not to assume. Run it against any token
// before trusting it as scoped: the shared sandbox token, and each production integration token
// at cutover.
//
//   MONDAY_API_TOKEN=... node scripts/check-monday-token-scope.mjs --workspace 17141226
//   MONDAY_API_TOKEN=... node scripts/check-monday-token-scope.mjs --workspace 111 --workspace 222
//
// Exit 0: every board the token reaches is in an allowed workspace. Exit 1: it reaches boards
// outside them (listed by workspace). Archived and deleted (in trash, restorable) boards count:
// they keep their items and stay readable, so they are reported, separately, rather than skipped
// (#71). Exit 2: usage or API error. Read-only — two queries
// (`me`, `workspaces`) and a paged `boards` listing; nothing is written and no item is read.

import { fileURLToPath } from 'node:url';
// The repo's single API-Version pin (#39), from the canonical transport.
import { MONDAY_API_VERSION } from '../monday-backup/src/monday/graphql.ts';

const API_URL = 'https://api.monday.com/v2';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export function parseArgs(argv) {
  const workspaces = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--workspace') throw new Error(`unknown argument "${argv[i]}"`);
    const id = argv[++i];
    if (id === undefined) throw new Error('--workspace needs a workspace id');
    if (!/^\d+$/.test(id)) throw new Error(`--workspace id must be numeric, got "${id}"`);
    workspaces.push(id);
  }
  if (workspaces.length === 0) throw new Error('at least one --workspace <id> is required');
  return { workspaces };
}

// Pure: `boards` is what the boards query returned ({ id, workspace_id, board_kind, permissions,
// state }). `permissions: "everyone"` means any team member — this token's user included — can
// edit. `state` is active, archived or deleted; a board without one counts as active.
export function summarizeScope(boards, allowedWorkspaceIds) {
  const allowed = new Set(allowedWorkspaceIds.map(String));
  const byWorkspace = new Map();
  const byKind = {};
  const byState = {};
  let inside = 0;
  let editableByEveryone = 0;
  for (const board of boards) {
    const workspaceId = board.workspace_id === null || board.workspace_id === undefined ? '(none)' : String(board.workspace_id);
    if (allowed.has(workspaceId)) {
      inside++;
      continue;
    }
    const everyone = board.permissions === 'everyone';
    const state = board.state ?? 'active';
    if (everyone) editableByEveryone++;
    byKind[board.board_kind] = (byKind[board.board_kind] ?? 0) + 1;
    byState[state] = (byState[state] ?? 0) + 1;
    const entry = byWorkspace.get(workspaceId) ?? { workspaceId, boards: 0, editableByEveryone: 0, notActive: 0 };
    entry.boards++;
    if (everyone) entry.editableByEveryone++;
    if (state !== 'active') entry.notActive++;
    byWorkspace.set(workspaceId, entry);
  }
  const workspaces = [...byWorkspace.values()].sort((a, b) => b.boards - a.boards || a.workspaceId.localeCompare(b.workspaceId));
  return {
    total: boards.length,
    inside,
    outside: { boards: boards.length - inside, editableByEveryone, byKind, byState, workspaces },
  };
}

async function query(token, graphql) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': MONDAY_API_VERSION },
    body: JSON.stringify({ query: graphql }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body === null || body.errors || !body.data) {
    throw new Error(`monday API: HTTP ${res.status}: ${JSON.stringify(body?.errors ?? body?.error_message ?? body).slice(0, 300)}`);
  }
  return body.data;
}

async function listBoards(token) {
  const boards = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await query(token, `{ boards(limit: ${PAGE_SIZE}, page: ${page}, state: all) { id workspace_id board_kind permissions state } }`);
    boards.push(...data.boards);
    if (data.boards.length < PAGE_SIZE) return boards;
  }
  throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} boards; raise MAX_PAGES`);
}

async function main() {
  const token = process.env.MONDAY_API_TOKEN;
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!token) throw new Error('MONDAY_API_TOKEN is not set');
  } catch (err) {
    console.error(`${err.message}\nusage: MONDAY_API_TOKEN=... node scripts/check-monday-token-scope.mjs --workspace <id> [--workspace <id> ...]`);
    return 2;
  }

  let who, names, summary;
  try {
    const data = await query(token, '{ me { id name } workspaces(limit: 500) { id name } }');
    who = data.me;
    names = new Map(data.workspaces.map((w) => [String(w.id), w.name]));
    summary = summarizeScope(await listBoards(token), args.workspaces);
  } catch (err) {
    // Node reports a network failure as a bare "fetch failed"; the cause says why.
    console.error(err.cause ? `${err.message}: ${err.cause.message ?? err.cause}` : err.message);
    return 2;
  }

  console.log(`Token user: ${who.name} (id ${who.id})`);
  console.log(`Allowed workspaces: ${args.workspaces.map((id) => `${id}${names.has(id) ? ` ${names.get(id)}` : ''}`).join(', ')}`);
  console.log(`Boards reachable (any state): ${summary.total} — ${summary.inside} inside the allowed workspaces, ${summary.outside.boards} outside`);
  if (summary.outside.boards === 0) {
    console.log('OK: this token reaches nothing outside the allowed workspaces.');
    return 0;
  }
  const kinds = Object.entries(summary.outside.byKind).map(([kind, n]) => `${n} ${kind}`).join(', ');
  const states = Object.entries(summary.outside.byState).map(([state, n]) => `${n} ${state}`).join(', ');
  console.log(`Outside: ${kinds}; ${states}; ${summary.outside.editableByEveryone} editable by every team member`);
  for (const w of summary.outside.workspaces) {
    const notActive = w.notActive > 0 ? `, ${w.notActive} archived/deleted` : '';
    console.log(`  ${w.workspaceId.padEnd(10)} ${String(w.boards).padStart(4)} boards (${w.editableByEveryone} editable${notActive})  ${names.get(w.workspaceId) ?? ''}`);
  }
  console.log('FAIL: this token reaches boards outside the allowed workspaces.');
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
