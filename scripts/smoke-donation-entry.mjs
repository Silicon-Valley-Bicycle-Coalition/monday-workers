#!/usr/bin/env node
// Smoke test for manual donation entry, against a SANDBOX Donations board only. Creates the same
// items the "Enter a gift" form creates (a person's check, an anonymous cash gift), checks what the
// board does with them (Acknowledgment Tier, Status, the donor link), optionally checks that the
// donor's Lifetime Giving moves (donation-rollups), then deletes everything it created.
//
//   MONDAY_API_TOKEN=... node scripts/smoke-donation-entry.mjs --board 18437342657 --donor <People item id>
//   MONDAY_API_TOKEN=... node scripts/smoke-donation-entry.mjs --board 18437342657 --donor 13397907956 --rollups
//
// Why it does not submit the form itself: the monday GraphQL API can edit a form but has no
// mutation to submit one. The form's own shape is checked by scripts/check-donation-form.mjs.
//
// Refuses any board or donor board whose name does not contain "sandbox". --rollups waits up to
// --wait seconds (default 90) for donation-rollups to move the donor's Lifetime Giving; if the
// Worker's write switch is off (donation-rollups:writes) that check fails by design.
// Exit 0: every check passed. Exit 1: a check failed (listed). Exit 2: usage or API error.
// Test items are deleted in all cases, including after a failed check (Monday keeps deleted items
// in the trash for 30 days).

import { fileURLToPath } from 'node:url';
import { MONDAY_API_VERSION } from '../monday-backup/src/monday/graphql.ts';
import { bareTitle } from './lib/column-titles.mjs';
import { SCENARIOS, resolveColumns, columnValues, checkItem, rollupMoved } from './lib/donation-smoke.mjs';

const API_URL = 'https://api.monday.com/v2';

export function parseArgs(argv) {
  const args = { board: null, donor: null, rollups: false, wait: 90 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rollups') { args.rollups = true; continue; }
    if (a !== '--board' && a !== '--donor' && a !== '--wait') throw new Error(`unknown argument "${a}"`);
    const v = argv[++i];
    if (v === undefined || !/^\d+$/.test(v)) throw new Error(`${a} needs a numeric value`);
    if (a === '--board') args.board = v;
    else if (a === '--donor') args.donor = v;
    else args.wait = Number(v);
  }
  if (!args.board) throw new Error('--board <Donations board id> is required');
  if (!args.donor) throw new Error('--donor <People item id> is required');
  return args;
}

export function isSandboxName(name) {
  return /sandbox/i.test(name ?? '');
}

async function query(token, graphql, variables = {}) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readItem(token, itemId) {
  const data = await query(token, `query($ids:[ID!]){ items(ids:$ids){ id column_values { id text ... on BoardRelationValue { linked_item_ids } } } }`, { ids: [itemId] });
  const item = data.items[0];
  const text = new Map(item.column_values.map((c) => [c.id, c.text ?? '']));
  const relations = new Map(item.column_values.filter((c) => Array.isArray(c.linked_item_ids)).map((c) => [c.id, c.linked_item_ids]));
  return { text, relations };
}

async function lifetimeGiving(token, donorId) {
  const data = await query(token, `query($ids:[ID!]){ items(ids:$ids){ board { id name } column_values { id text column { title } } } }`, { ids: [donorId] });
  const item = data.items[0];
  if (!item) throw new Error(`donor item ${donorId} not found`);
  if (!isSandboxName(item.board.name)) throw new Error(`donor item is on board "${item.board.name}", not a sandbox board`);
  const col = item.column_values.find((c) => bareTitle(c.column.title) === 'Lifetime Giving');
  if (!col) throw new Error(`board "${item.board.name}" has no Lifetime Giving column`);
  return Number((col.text || '0').replace(/[$,]/g, ''));
}

async function cleanup(token, created) {
  for (const c of created) {
    try {
      await query(token, `mutation($i:ID!){ delete_item(item_id:$i){ id } }`, { i: c.id });
      console.log(`Deleted item ${c.id}`);
    } catch (err) {
      console.error(`could not delete test item ${c.id} (${c.scenario.name}): ${err.message}`);
    }
  }
}

async function main() {
  const token = process.env.MONDAY_API_TOKEN;
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!token) throw new Error('MONDAY_API_TOKEN is not set');
  } catch (err) {
    console.error(`${err.message}\nusage: MONDAY_API_TOKEN=... node scripts/smoke-donation-entry.mjs --board <id> --donor <item id> [--rollups] [--wait <seconds>]`);
    return 2;
  }

  const created = [];
  const problems = [];
  try {
    const data = await query(token, `query($ids:[ID!]){ boards(ids:$ids){ name columns { id title } } }`, { ids: [args.board] });
    const board = data.boards[0];
    if (!board) throw new Error(`board ${args.board} not found`);
    if (!isSandboxName(board.name)) throw new Error(`refusing: board "${board.name}" is not a sandbox board`);
    const { byTitle, missing } = resolveColumns(board.columns);
    if (missing.length > 0) throw new Error(`board is missing columns: ${missing.join(', ')}`);
    const donorBefore = args.rollups ? await lifetimeGiving(token, args.donor) : null;
    console.log(`Board: ${board.name} (${args.board})`);

    const dateISO = new Date().toISOString().slice(0, 10);
    for (const scenario of SCENARIOS) {
      const res = await query(token, `mutation($b:ID!,$n:String!,$v:JSON!){ create_item(board_id:$b, item_name:$n, column_values:$v){ id } }`,
        { b: args.board, n: scenario.name, v: JSON.stringify(columnValues(byTitle, scenario, { donorItemId: args.donor, dateISO })) });
      created.push({ id: res.create_item.id, scenario });
      console.log(`Created ${scenario.name} ($${scenario.amount}) as item ${res.create_item.id}`);
    }

    // The board's automations run within seconds; poll for the tier rather than sleeping blindly.
    const tierCol = byTitle.get('Acknowledgment Tier');
    for (let waited = 0; waited < 30; waited += 2) {
      const reads = await Promise.all(created.map((c) => readItem(token, c.id)));
      if (reads.every((r) => (r.text.get(tierCol) ?? '') !== '')) break;
      await sleep(2000);
    }
    for (const c of created) {
      const r = await readItem(token, c.id);
      const donorIds = r.relations.get(byTitle.get('Donor')) ?? [];
      const found = checkItem(byTitle, c.scenario, { text: r.text, donorIds });
      problems.push(...found);
      console.log(`${found.length === 0 ? 'OK  ' : 'FAIL'} ${c.scenario.name}`);
    }

    if (args.rollups) {
      const person = SCENARIOS.find((s) => s.donor);
      let after = donorBefore;
      for (let waited = 0; waited < args.wait; waited += 5) {
        after = await lifetimeGiving(token, args.donor);
        if (rollupMoved(donorBefore, after, person.amount)) break;
        await sleep(5000);
      }
      if (rollupMoved(donorBefore, after, person.amount)) {
        console.log(`OK   donor Lifetime Giving moved ${donorBefore} -> ${after}`);
      } else {
        problems.push(`donor Lifetime Giving did not rise by ${person.amount} within ${args.wait}s (${donorBefore} -> ${after}); is donation-rollups:writes on for the sandbox?`);
        console.log('FAIL donor Lifetime Giving');
      }
    }
  } catch (err) {
    console.error(err.cause ? `${err.message}: ${err.cause.message ?? err.cause}` : err.message);
    await cleanup(token, created);
    return 2;
  }
  await cleanup(token, created);
  if (problems.length === 0) {
    console.log('PASS');
    return 0;
  }
  for (const p of problems) console.log(`  - ${p}`);
  console.log('FAIL');
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
