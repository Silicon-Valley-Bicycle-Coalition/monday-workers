#!/usr/bin/env node
// Loads the match history from salesforce-import's run artifacts into impact-attribution's D1
// `matches` table, once (spec "Where the evidence comes from"). Most historical gifts are ARCHIVED
// on Monday, and an archived item's connect columns (Donor, Matched By) read empty through the API,
// so the board can't supply this history; the importer's artifacts are the authoritative record.
// Same method as donation-rollups/scripts/bootstrap-links-from-artifacts.mjs.
//
// The artifacts are gitignored and irreplaceable; this script only reads them.
//
// Usage:
//   node scripts/bootstrap-matches.mjs \
//     --payloads <data>/transform/payloads.ndjson --ledger <data>/load/ledger.ndjson \
//     --boards <data>/load/boards.json [--out bootstrap.sql]
//   npx wrangler d1 execute svbc-impact-attribution --remote --file=bootstrap.sql
//
// Emits SQL with INSERT OR IGNORE, so a re-run never overwrites a row the nightly board read has
// since refreshed. The output holds item ids, dates and amounts only — no names or emails.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MATCHING_GIFT_TYPE = 'Matching Donation';
const PEOPLE_BOARDS = new Set(['people-live', 'people-historical']);
const BATCH = 500;

// Returns { rows, counts }. rows: { donationItemId, personItemId, orgItemId, matchDate, amountCents }.
export function buildRows({ payloads, ledger, boards }) {
  if (!boards.organizations) throw new Error('boards.json has no "organizations" board');
  // Ledger replay: a later success supersedes an earlier one for the same Salesforce id.
  const bySfId = new Map();
  for (const e of ledger) if (e.kind === 'success') bySfId.set(e.sfId, { board: e.board, itemId: String(e.itemId) });

  const counts = { matching: 0, stored: 0, orgDonor: 0, noDonor: 0, noMatchedBy: 0, notLoaded: 0, noDate: 0 };
  const rows = [];
  for (const p of payloads) {
    if (p.board !== 'donations' || p.columns?.['Gift Type'] !== MATCHING_GIFT_TYPE) continue;
    counts.matching++;
    const gift = bySfId.get(p.sfId);
    if (!gift) { counts.notLoaded++; continue; }
    const link = (column) => (p.links ?? []).find((l) => l.column === column)?.targetSfIds ?? [];
    const donors = link('Donor').map((id) => bySfId.get(id)).filter(Boolean);
    if (donors.length !== 1) { counts.noDonor++; continue; }
    if (donors[0].board === 'organizations') { counts.orgDonor++; continue; }
    if (!PEOPLE_BOARDS.has(donors[0].board)) { counts.noDonor++; continue; }
    const orgs = link('Matched By').map((id) => bySfId.get(id)).filter((t) => t?.board === 'organizations');
    if (orgs.length !== 1) { counts.noMatchedBy++; continue; }
    const date = /^\d{4}-\d{2}-\d{2}/.exec(p.columns?.Date?.date ?? '')?.[0];
    if (!date) { counts.noDate++; continue; }
    const raw = p.columns?.Amount;
    const amount = raw === null || raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
    rows.push({
      donationItemId: gift.itemId, personItemId: donors[0].itemId, orgItemId: orgs[0].itemId, matchDate: date,
      amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    });
    counts.stored++;
  }
  return { rows, counts };
}

const id = (v) => {
  if (!/^\d+$/.test(String(v))) throw new Error(`refusing a non-numeric item id in SQL output`);
  return `'${v}'`;
};

export function toSql(rows, seenAt) {
  if (!/^[0-9TZ:.\-]+$/.test(seenAt)) throw new Error('seenAt must be an ISO timestamp');
  const lines = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const values = rows.slice(i, i + BATCH).map((r) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.matchDate)) throw new Error('matchDate must be YYYY-MM-DD');
      const cents = r.amountCents === null ? 'NULL' : String(Math.trunc(r.amountCents));
      return `(${id(r.donationItemId)}, ${id(r.personItemId)}, ${id(r.orgItemId)}, '${r.matchDate}', ${cents}, 'bootstrap', '${seenAt}')`;
    });
    lines.push(
      'INSERT OR IGNORE INTO matches (donation_item_id, person_item_id, org_item_id, match_date, amount_cents, source, seen_at) VALUES\n' +
        values.join(',\n') + ';',
    );
  }
  return lines.join('\n') + '\n';
}

function main() {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  const payloadsPath = arg('--payloads'), ledgerPath = arg('--ledger'), boardsPath = arg('--boards');
  const out = arg('--out') ?? 'bootstrap.sql';
  if (!payloadsPath || !ledgerPath || !boardsPath) {
    console.error('usage: bootstrap-matches.mjs --payloads <payloads.ndjson> --ledger <ledger.ndjson> --boards <boards.json> [--out file.sql]');
    process.exit(1);
  }
  const ndjson = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const { rows, counts } = buildRows({
    payloads: ndjson(payloadsPath), ledger: ndjson(ledgerPath), boards: JSON.parse(readFileSync(boardsPath, 'utf8')),
  });
  writeFileSync(out, toSql(rows, new Date().toISOString()));
  console.log(JSON.stringify({ out, ...counts }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
