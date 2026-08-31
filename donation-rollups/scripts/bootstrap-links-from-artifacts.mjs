#!/usr/bin/env node
// Rebuilds the donation_links reverse index from salesforce-import's run artifacts instead of
// the Monday API. Required for the single archive-in-place Donations board (docs/20 in the
// private planning repo): most donations are ARCHIVED, and archived items are invisible to
// items_page AND report empty board_relation values — so the API-walking bootstrap
// (bootstrap-links.mjs) structurally cannot see them. The importer's artifacts are the
// authoritative record of every donation→owner link, including the archived ones.
//
// Usage:
//   node scripts/bootstrap-links-from-artifacts.mjs \
//     --payloads <path>/payloads.ndjson --ledger <path>/ledger.ndjson \
//     --boards <path>/boards.json [--out bootstrap.sql]
//   wrangler d1 execute <database-name> --remote --file=bootstrap.sql
//
// Emits SQL (same tooling path as every other D1 change here). Clears pending_recomputes
// too — at rest it's a work queue, and any pre-cutover rows reference retired boards.

import { readFileSync, writeFileSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const payloadsPath = arg('--payloads'), ledgerPath = arg('--ledger'), boardsPath = arg('--boards');
const OUT = arg('--out') ?? 'bootstrap.sql';
if (!payloadsPath || !ledgerPath || !boardsPath) {
  console.error('usage: bootstrap-links-from-artifacts.mjs --payloads <payloads.ndjson> --ledger <ledger.ndjson> --boards <boards.json> [--out file.sql]');
  process.exit(1);
}

const ndjson = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Ledger replay: a later success supersedes; deletes aren't modeled (the importer never deletes).
const itemBySfId = new Map();
for (const e of ndjson(ledgerPath)) {
  if (e.kind === 'success') itemBySfId.set(e.sfId, { board: e.board, itemId: e.itemId });
}
const boards = JSON.parse(readFileSync(boardsPath, 'utf8'));
const boardIdByKey = Object.fromEntries(Object.entries(boards).map(([k, v]) => [k, String(v.boardId)]));

const rows = [];
let missingOwner = 0, noDonor = 0;
for (const p of ndjson(payloadsPath)) {
  if (p.board !== 'donations') continue;
  const donation = itemBySfId.get(p.sfId);
  if (!donation) continue; // never landed — importer's problem, not this index's
  const donorLink = (p.links ?? []).find((l) => l.column === 'Donor');
  if (!donorLink) { noDonor++; continue; } // anonymous gifts have no owner to roll up
  const ownerSfId = donorLink.targetSfIds[0];
  const owner = itemBySfId.get(ownerSfId);
  if (!owner) { missingOwner++; continue; } // owner deliberately not migrated (excluded contact)
  const ownerBoardId = boardIdByKey[owner.board];
  if (!ownerBoardId) throw new Error(`no board id for ledger board key "${owner.board}"`);
  rows.push([donation.itemId, boardIdByKey['donations'], owner.itemId, ownerBoardId]);
}

const now = new Date().toISOString();
const lines = ['DELETE FROM donation_links;', 'DELETE FROM pending_recomputes;'];
for (let i = 0; i < rows.length; i += 500) {
  const values = rows.slice(i, i + 500)
    .map(([d, db, o, ob]) => `('${d}','${db}','${o}','${ob}','${now}')`).join(',\n');
  lines.push(`INSERT INTO donation_links (donation_item_id, donation_board_id, owner_item_id, owner_board_id, updated_at) VALUES\n${values};`);
}
writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.error(`bootstrap-links-from-artifacts: ${rows.length} links → ${OUT} ` +
  `(${noDonor} anonymous gifts skipped, ${missingOwner} owners not migrated)`);
