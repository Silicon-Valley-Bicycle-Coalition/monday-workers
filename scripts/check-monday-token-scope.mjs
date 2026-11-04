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
import { listBoards, summarizeScope } from './lib/token-scope.mjs';
// The repo's single API-Version pin (#39), from the canonical transport.
import { MONDAY_API_VERSION } from '../monday-backup/src/monday/graphql.ts';

const API_URL = 'https://api.monday.com/v2';

// Re-exported so existing importers (and tests) keep working; the logic lives in lib/token-scope.mjs,
// which the monday-auth Worker also imports (it cannot pull in this script's Node-only entry point).
export { summarizeScope };

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
    summary = summarizeScope(await listBoards((graphql) => query(token, graphql)), args.workspaces);
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
