#!/usr/bin/env node
// Writes the Send event email link on every Eventbrite event on the Events board that lacks it or
// still has an older one (such as "Send class email", or a link only Public events used to get).
// The Worker writes the same link whenever it processes an event; this reaches the events it won't
// process again, such as ones that have already happened. The Worker's daily sweep
// (src/sendLinks/sweep.ts) now does the same; this is for running it by hand. Skips what's current,
// so stopping and re-running is safe. Prints counts and item ids, never names.
//
// Usage (from eventbrite-sync/):
//   MONDAY_API_TOKEN=... node scripts/backfill-send-links.mjs --dry-run
//   MONDAY_API_TOKEN=... node scripts/backfill-send-links.mjs
//     [--env sandbox]    use config/sandbox.json (the token must reach that workspace)
//     [--limit 50]       stop after this many writes
//     [--pause-ms 100]   wait between writes

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MondayGraphQL } from '../src/monday/graphql.ts';
import { readArg } from './backfill-orders-lib.mjs';
import { parseLink, planSendLinks } from './backfill-send-links-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const token = process.env.MONDAY_API_TOKEN;
if (!token) {
  console.error('backfill-send-links: MONDAY_API_TOKEN is required');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
const limit = Number(readArg(process.argv, '--limit', Infinity));
const pauseMs = Number(readArg(process.argv, '--pause-ms', 100));
const configFile = readArg(process.argv, '--env', null) === 'sandbox' ? 'sandbox.json' : 'svbc.json';
const config = JSON.parse(readFileSync(join(HERE, '..', 'config', configFile), 'utf8'));

const { events: eventsBoard } = config.monday.boards;
const { eventbriteIdColumn, sendLinkColumn } = config.attendeeSync.events;
const { pageUrl } = config.attendeeSync.classEmails;
if (!pageUrl) {
  console.error(`backfill-send-links: attendeeSync.classEmails.pageUrl is not set in ${configFile}, so there is no page to link to`);
  process.exit(1);
}
const client = new MondayGraphQL('https://api.monday.com/v2', token);
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readEvents() {
  const fields = `cursor items { id column_values(ids: ["${eventbriteIdColumn}", "${sendLinkColumn}"]) { id text value } }`;
  const rows = [];
  let cursor = null;
  do {
    const page = cursor
      ? (await client.request(`query ($c: String!) { next_items_page(cursor: $c, limit: 500) { ${fields} } }`, { c: cursor })).next_items_page
      : (await client.request(`query ($b: ID!) { boards(ids: [$b]) { items_page(limit: 500) { ${fields} } } }`, { b: eventsBoard })).boards[0].items_page;
    for (const item of page.items) {
      const col = (id) => item.column_values.find((c) => c.id === id);
      rows.push({ itemId: item.id, eventbriteId: col(eventbriteIdColumn)?.text ?? '', link: parseLink(col(sendLinkColumn)?.value) });
    }
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

const plan = planSendLinks(await readEvents(), pageUrl);
log(`to write ${plan.toWrite.length}; already current ${plan.current}; not an Eventbrite event ${plan.notEventbrite}`);
if (dryRun) process.exit(0);

let done = 0;
const failed = [];
for (const { itemId, link } of plan.toWrite.slice(0, limit)) {
  try {
    await client.request(
      `mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }`,
      { b: eventsBoard, i: itemId, v: JSON.stringify({ [sendLinkColumn]: link }) },
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
