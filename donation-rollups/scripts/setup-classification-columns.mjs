#!/usr/bin/env node
// Ensures a Donations board has the four status columns the custodian's classify duty writes
// (spec 2026-09-29 §10.1), creating any that are missing, and prints a config-ready
// `classification` block for donationBoards[].columns. Fiscal-period labels are created on
// first write (create_labels_if_missing), so only the fixed vocabularies are pre-seeded.
//
// Usage: MONDAY_API_TOKEN=... node scripts/setup-classification-columns.mjs <donationsBoardId>

import { MONDAY_API_VERSION } from '../src/monday/graphql.ts';
import { bareTitle } from '../../scripts/lib/column-titles.mjs';

const token = process.env.MONDAY_API_TOKEN;
const boardId = process.argv[2];
if (!token || !/^\d+$/.test(boardId ?? '')) {
  console.error('usage: MONDAY_API_TOKEN=... node scripts/setup-classification-columns.mjs <donationsBoardId>');
  process.exit(1);
}
// Keyed 0..4, 6..n: Monday shows label id 5's text for an EMPTY status cell, so a real label there
// makes every unclassified gift read as that label (and classify's text diff then skips it).
const labels = (list) => JSON.stringify({ labels: Object.fromEntries(list.map((l, i) => [i < 5 ? i : i + 1, l])) });
const FIELDS = {
  fundingStream: { title: 'Funding Stream', defaults: labels(['Individual Giving', 'Membership', 'Sponsorships', 'Grants & Contracts', 'Matching Donations', 'Other Program Revenue', 'Donor Advised Funds', 'Event Tickets', 'Foundation & Corporate Gifts']) },
  giftSize: { title: 'Gift Size', defaults: labels(['< $100', '$100–199', '$200–999', '$1k–4.9k', '$5k+']) },
  fiscalQuarter: { title: 'Fiscal Quarter' },
  giftFiscalYear: { title: 'Gift Fiscal Year' },
};

async function graphql(query, variables) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': MONDAY_API_VERSION },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const { boards } = await graphql('query ($id: [ID!]) { boards(ids: $id) { columns { id title } } }', { id: [boardId] });
const byTitle = new Map(boards[0].columns.map((c) => [bareTitle(c.title), c.id]));
const out = {};
for (const [key, spec] of Object.entries(FIELDS)) {
  let id = byTitle.get(spec.title);
  if (!id) {
    const created = await graphql(
      `mutation ($board: ID!, $title: String!, $defaults: JSON) {
         create_column(board_id: $board, title: $title, column_type: status, defaults: $defaults) { id } }`,
      { board: boardId, title: spec.title, defaults: spec.defaults });
    id = created.create_column.id;
    console.error(`setup-classification-columns: created "${spec.title}" → ${id}`);
  }
  out[key] = id;
}
console.log(JSON.stringify({ classification: out }, null, 2));
