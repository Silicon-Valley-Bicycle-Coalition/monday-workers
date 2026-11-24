#!/usr/bin/env node
// Lists the employers on Matching Donations of the last three fiscal years with their gift counts, to
// start config outreach.matchingEmployers from. Reads Monday and prints; writes nothing anywhere. A
// person adds each request URL and deadline by hand (README, "Post-gift email").
//
// Usage (from dtd-sync/):
//   MONDAY_API_TOKEN=... node scripts/seed-matching-employers.mjs [--config config/svbc.json]

import { readFileSync } from 'node:fs';
import { countEmployers, formatEmployers, sinceDate } from './seed-matching-employers-lib.mjs';

const at = process.argv.indexOf('--config');
const configPath = at > 0 ? process.argv[at + 1] : new URL('../config/svbc.json', import.meta.url);
const token = process.env.MONDAY_API_TOKEN;
if (!token || !configPath) {
  console.error('seed-matching-employers: MONDAY_API_TOKEN is required (and --config needs a path)');
  process.exit(1);
}

const { boards, donations } = JSON.parse(readFileSync(configPath, 'utf8'));
const { MondayGraphQL } = await import('../src/monday/graphql.ts');
const monday = new MondayGraphQL('https://api.monday.com/v2', token);
const fields = `cursor items { name column_values(ids: ${JSON.stringify([donations.giftType, donations.date, donations.matchedBy])}) { id text ... on BoardRelationValue { display_value } } }`;

const since = sinceDate(new Date());
let page = (await monday.request(
  `query ($board: [ID!], $since: CompareValue!, $type: CompareValue!) { boards(ids: $board) { items_page(limit: 500, query_params: { rules: [
    { column_id: "${donations.date}", compare_value: $since, operator: greater_than_or_equals },
    { column_id: "${donations.giftType}", compare_value: $type, operator: contains_text } ] }) { ${fields} } } }`,
  { board: [boards.donations], since: ['EXACT', since], type: ['Matching Donation'] },
)).boards[0]?.items_page;
if (!page) throw new Error(`seed-matching-employers: board ${boards.donations} is not readable`);

const matches = [];
for (;;) {
  for (const item of page.items) {
    const byId = new Map(item.column_values.map((cv) => [cv.id, cv]));
    if (byId.get(donations.giftType)?.text !== 'Matching Donation') continue;
    matches.push({ name: item.name, matchedBy: byId.get(donations.matchedBy)?.display_value ?? null });
  }
  if (page.cursor === null) break;
  page = (await monday.request(`query ($cursor: String!) { next_items_page(limit: 500, cursor: $cursor) { ${fields} } }`, { cursor: page.cursor })).next_items_page;
}

console.error(`seed-matching-employers: ${matches.length} Matching Donations since ${since}`);
console.log(formatEmployers(countEmployers(matches)));
