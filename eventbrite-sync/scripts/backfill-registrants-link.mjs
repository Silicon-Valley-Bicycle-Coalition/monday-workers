#!/usr/bin/env node
// Fills the Registrants link column on existing Event Registrations items, from each one's Event
// link, so they show on their event's card. A one-off for what was registered before the Worker
// wrote this column. Skips what's already linked, so stopping and re-running is safe. Prints counts
// and item ids, never names or addresses.
//
// Usage (from eventbrite-sync/):
//   MONDAY_API_TOKEN=... node scripts/backfill-registrants-link.mjs --dry-run
//   MONDAY_API_TOKEN=... node scripts/backfill-registrants-link.mjs
//     [--env sandbox]    use config/sandbox.json (the token must reach that workspace)
//     [--limit 50]       stop after this many writes
//     [--pause-ms 100]   wait between writes

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MondayGraphQL } from '../src/monday/graphql.ts';
import { readArg } from './backfill-orders-lib.mjs';
import { planRegistrantsLinks } from './backfill-registrants-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const token = process.env.MONDAY_API_TOKEN;
if (!token) {
  console.error('backfill-registrants-link: MONDAY_API_TOKEN is required');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
const limit = Number(readArg(process.argv, '--limit', Infinity));
const pauseMs = Number(readArg(process.argv, '--pause-ms', 100));
const configFile = readArg(process.argv, '--env', null) === 'sandbox' ? 'sandbox.json' : 'svbc.json';
const config = JSON.parse(readFileSync(join(HERE, '..', 'config', configFile), 'utf8'));

const { events, 'event-registrations': registrations } = config.monday.boards;
const { eventLinkColumn, registrantsLinkColumn } = config.attendeeSync.registrations;
const { eventbriteIdColumn } = config.attendeeSync.events;
const client = new MondayGraphQL('https://api.monday.com/v2', token);
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function excludedEventItemIds() {
  const ids = [];
  for (const eventId of config.attendeeSync.registrantsLinkExcludedEventIds) {
    const data = await client.request(
      `query ($board: ID!, $column: String!, $value: String!) {
        items_page_by_column_values(board_id: $board, limit: 5, columns: [{ column_id: $column, column_values: [$value] }]) { items { id } }
      }`,
      { board: events, column: eventbriteIdColumn, value: eventId },
    );
    ids.push(...data.items_page_by_column_values.items.map((i) => i.id));
  }
  return ids;
}

async function readRegistrations() {
  const fields = `cursor items { id column_values(ids: ["${eventLinkColumn}", "${registrantsLinkColumn}"]) { id ... on BoardRelationValue { linked_item_ids } } }`;
  const rows = [];
  let cursor = null;
  do {
    const page = cursor
      ? (await client.request(`query ($c: String!) { next_items_page(cursor: $c, limit: 500) { ${fields} } }`, { c: cursor })).next_items_page
      : (await client.request(`query ($b: ID!) { boards(ids: [$b]) { items_page(limit: 500) { ${fields} } } }`, { b: registrations })).boards[0].items_page;
    for (const item of page.items) {
      const linked = (id) => item.column_values.find((c) => c.id === id)?.linked_item_ids ?? [];
      rows.push({ itemId: item.id, eventItemId: linked(eventLinkColumn)[0] ?? null, registrantsLinked: linked(registrantsLinkColumn).length > 0 });
    }
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

const excluded = await excludedEventItemIds();
const plan = planRegistrantsLinks(await readRegistrations(), excluded);
log(`to link ${plan.toLink.length}; already linked ${plan.alreadyLinked}; excluded event ${plan.excluded}; no event ${plan.noEvent}`);
if (dryRun) process.exit(0);

let done = 0;
const failed = [];
for (const { itemId, eventItemId } of plan.toLink.slice(0, limit)) {
  try {
    await client.request(
      `mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }`,
      { b: registrations, i: itemId, v: JSON.stringify({ [registrantsLinkColumn]: { item_ids: [Number(eventItemId)] } }) },
    );
    done++;
  } catch (err) {
    failed.push(itemId);
    log(`item ${itemId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if ((done + failed.length) % 100 === 0) log(`written ${done}, failed ${failed.length}`);
  await sleep(pauseMs);
}
log(`done: written ${done}, failed ${failed.length}. Re-run to pick up anything left.`);
process.exit(failed.length > 0 ? 1 : 0);
