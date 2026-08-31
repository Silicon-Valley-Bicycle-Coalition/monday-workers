#!/usr/bin/env node
// Populates the gifts ledger (migrations/0004_gifts.sql, docs/20 §5.1) from salesforce-import's
// run artifacts — the only complete record of gift history under archive-in-place, for the
// same reason as bootstrap-links-from-artifacts.mjs: archived items are invisible to
// items_page and unreadable via board_relation. Carries the full provenance the webhook path
// can never see (gift type, Funraise id, Salesforce id, archived state).
//
// Usage:
//   node scripts/bootstrap-gifts-from-artifacts.mjs \
//     --payloads <path>/payloads.ndjson --ledger <path>/ledger.ndjson \
//     --boards <path>/boards.json [--out bootstrap-gifts.sql]
//   wrangler d1 execute <database-name> --remote --file=bootstrap-gifts.sql -y
//
// (-y matters: without a TTY, wrangler's confirm prompt silently cancels with exit 0.)

import { readFileSync, writeFileSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const payloadsPath = arg('--payloads'), ledgerPath = arg('--ledger'), boardsPath = arg('--boards');
const OUT = arg('--out') ?? 'bootstrap-gifts.sql';
if (!payloadsPath || !ledgerPath || !boardsPath) {
  console.error('usage: bootstrap-gifts-from-artifacts.mjs --payloads <payloads.ndjson> --ledger <ledger.ndjson> --boards <boards.json> [--out file.sql]');
  process.exit(1);
}

const ndjson = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const esc = (s) => String(s).replace(/'/g, "''");

const itemBySfId = new Map();
const archivedSfIds = new Set();
for (const e of ndjson(ledgerPath)) {
  if (e.kind === 'success') itemBySfId.set(e.sfId, { board: e.board, itemId: e.itemId });
  if (e.kind === 'archive') archivedSfIds.add(e.sfId);
}
const boards = JSON.parse(readFileSync(boardsPath, 'utf8'));
const boardIdByKey = Object.fromEntries(Object.entries(boards).map(([k, v]) => [k, String(v.boardId)]));

const now = new Date().toISOString();
const rows = [];
let skippedNoOwner = 0;
for (const p of ndjson(payloadsPath)) {
  if (p.board !== 'donations') continue;
  const donation = itemBySfId.get(p.sfId);
  if (!donation) continue;
  const donorLink = (p.links ?? []).find((l) => l.column === 'Donor');
  const owner = donorLink ? itemBySfId.get(donorLink.targetSfIds[0]) : undefined;
  if (!owner) { skippedNoOwner++; continue; } // anonymous or excluded-owner gifts carry no rollup weight
  const c = p.columns;
  const amountCents = Math.round(Number(c['Amount'] || 0) * 100);
  const giftDate = typeof c['Date'] === 'object' && c['Date'] !== null ? (c['Date'].date ?? '') : '';
  const fiscalYear = Number(c['Fiscal Year'] || 0);
  const status = typeof c['Status'] === 'object' && c['Status'] !== null ? (c['Status'].label ?? '') : '';
  const giftType = c['Gift Type'] || null;
  const funraiseId = typeof c['Funraise ID'] === 'object' && c['Funraise ID'] !== null
    ? (c['Funraise ID'].text ?? null) : null;
  rows.push(
    `('${esc(donation.itemId)}','${esc(owner.itemId)}','${esc(boardIdByKey[owner.board])}',` +
    `${amountCents},'${esc(giftDate)}',${fiscalYear},'${esc(status)}',` +
    `${giftType === null ? 'NULL' : `'${esc(giftType)}'`},` +
    `${funraiseId === null ? 'NULL' : `'${esc(funraiseId)}'`},'${esc(p.sfId)}',` +
    `${archivedSfIds.has(p.sfId) ? `'${now}'` : 'NULL'},'import','${now}')`);
}

const lines = ['DELETE FROM gifts;'];
for (let i = 0; i < rows.length; i += 400) {
  lines.push(
    `INSERT INTO gifts (monday_item_id, owner_item_id, owner_board_id, amount_cents, gift_date,` +
    ` fiscal_year, status, gift_type, funraise_id, sf_id, archived_at, source, updated_at) VALUES\n` +
    rows.slice(i, i + 400).join(',\n') + ';');
}
writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.error(`bootstrap-gifts-from-artifacts: ${rows.length} gifts → ${OUT} ` +
  `(${skippedNoOwner} without a migrated owner skipped)`);
