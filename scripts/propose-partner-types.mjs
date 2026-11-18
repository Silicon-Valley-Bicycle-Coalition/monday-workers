#!/usr/bin/env node
// Builds the Partner Type review CSV (GL#55): one row per Organizations item, with the migrated
// value, a proposed value from the approved ten, and an empty Reviewed Type column. Reads a saved
// export and writes one local file. It never calls Monday, so nothing changes on a board.
//
//   node scripts/propose-partner-types.mjs --input orgs.json --out partner-type-review.csv
//
// --input is a JSON file { items: [{ id, name, url, column_values: { <column id>: text } }] }, as
// the Monday MCP's get_board_items_page returns it. Fetch all items with the COLUMNS below; the
// ids are SVBC's production Organizations board.
//
// The output holds real organization and some personal names: keep it out of the repo (data/ is
// ignored). Exit 0: written. Exit 2: usage or unreadable input.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { proposePartnerType } from './lib/partner-type-rules.mjs';

const COLUMNS = {
  partnerType: 'text_mm8nbhwa',
  website: 'link_mm8nwkyg',
  city: 'text_mm8nsrw9',
  salesforceId: 'text_mm8njjg8',
  salesforceOwner: 'text_mm8n8w1z',
  lifetimeGiving: 'numeric_mm8naf1t',
  lastGift: 'date_mm8pp5pp',
};

export const HEADER = [
  'Reviewed Type', 'Proposed Type', 'Confidence', 'Current Partner Type', 'Name', 'Basis', 'Flags',
  'City', 'Website', 'Lifetime Giving', 'Last Gift', 'Salesforce Owner', 'Salesforce ID',
  'Item ID', 'Monday Link',
];

const CONFIDENCE_ORDER = ['none', 'low', 'medium', 'high'];

export function reviewRows(items) {
  return items
    .map((item) => {
      const values = item.column_values ?? {};
      const current = values[COLUMNS.partnerType] ?? '';
      const website = values[COLUMNS.website] ?? '';
      const giving = Number(values[COLUMNS.lifetimeGiving] ?? 0) || 0;
      const proposal = proposePartnerType({ name: item.name, current, website });
      return {
        confidence: proposal.confidence,
        giving,
        row: [
          '', proposal.proposed, proposal.confidence, current, item.name, proposal.basis,
          proposal.flags, values[COLUMNS.city] ?? '', website, values[COLUMNS.lifetimeGiving] ?? '',
          values[COLUMNS.lastGift] ?? '', values[COLUMNS.salesforceOwner] ?? '',
          values[COLUMNS.salesforceId] ?? '', item.id, item.url ?? '',
        ],
      };
    })
    .sort((a, b) =>
      CONFIDENCE_ORDER.indexOf(a.confidence) - CONFIDENCE_ORDER.indexOf(b.confidence)
      || b.giving - a.giving)
    .map(({ row }) => row);
}

// A leading = + - @ would run as a formula in a spreadsheet, and some names came from web forms.
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

export function summarize(rows) {
  const index = (title) => HEADER.indexOf(title);
  const byConfidence = {};
  const byType = {};
  let unmapped = 0;
  for (const row of rows) {
    const confidence = row[index('Confidence')];
    const type = row[index('Proposed Type')] || '(none)';
    byConfidence[confidence] = (byConfidence[confidence] ?? 0) + 1;
    byType[type] = (byType[type] ?? 0) + 1;
    if (row[index('Flags')].includes('Unmapped value')) unmapped += 1;
  }
  return { total: rows.length, byConfidence, byType, unmapped };
}

function main(argv) {
  const arg = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const input = arg('--input');
  const out = arg('--out');
  if (!input || !out) {
    console.error('Usage: propose-partner-types.mjs --input orgs.json --out review.csv');
    return 2;
  }
  let items;
  try {
    items = JSON.parse(readFileSync(input, 'utf8')).items;
  } catch (error) {
    console.error(`Could not read ${input}: ${error.message}`);
    return 2;
  }
  if (!Array.isArray(items) || items.length === 0) {
    console.error(`${input} holds no items`);
    return 2;
  }
  const rows = reviewRows(items);
  writeFileSync(out, toCsv([HEADER, ...rows]));
  console.log(JSON.stringify(summarize(rows), null, 2));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
