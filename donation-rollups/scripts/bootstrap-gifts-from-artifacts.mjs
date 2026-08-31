#!/usr/bin/env node
// Populates the gifts ledger (migrations/0004_gifts.sql, docs/20 §5.1) from salesforce-import's
// run artifacts — the only complete record of gift history under archive-in-place, for the
// same reason as bootstrap-links-from-artifacts.mjs: archived items are invisible to
// items_page and unreadable via board_relation. Carries the full provenance the webhook path
// can never see (gift type, Funraise id, Salesforce id, archived state).
//
// Guardrails (this script replaces the ENTIRE authoritative ledger, ~37k gifts):
// - refuses when the artifacts produce 0 gift rows or reference board ids outside
//   config/svbc.json (both mean a superseded board generation); --force overrides.
// - the generated SQL stages all rows into gifts_bootstrap first and only swaps into
//   `gifts` at the end, so a mid-run failure can't leave the ledger emptied.
// Guard + SQL logic lives in bootstrap-gifts-lib.mjs (unit-tested).
//
// Usage:
//   node scripts/bootstrap-gifts-from-artifacts.mjs \
//     --payloads <path>/payloads.ndjson --ledger <path>/ledger.ndjson \
//     --boards <path>/boards.json [--out bootstrap-gifts.sql] [--force]
//   wrangler d1 execute <database-name> --remote --file=bootstrap-gifts.sql -y
//
// (-y matters: without a TTY, wrangler's confirm prompt silently cancels with exit 0.)

import { readFileSync, writeFileSync } from 'node:fs';
import { buildGiftRows, checkArtifactGuards, renderSql } from './bootstrap-gifts-lib.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const payloadsPath = arg('--payloads'), ledgerPath = arg('--ledger'), boardsPath = arg('--boards');
const OUT = arg('--out') ?? 'bootstrap-gifts.sql';
const force = process.argv.includes('--force');
if (!payloadsPath || !ledgerPath || !boardsPath) {
  console.error('usage: bootstrap-gifts-from-artifacts.mjs --payloads <payloads.ndjson> --ledger <ledger.ndjson> --boards <boards.json> [--out file.sql] [--force]');
  process.exit(1);
}

const ndjson = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const now = new Date().toISOString();
const { rows, skippedNoOwner, donationBoardIds, ownerBoardIds } = buildGiftRows({
  payloads: ndjson(payloadsPath),
  ledgerEntries: ndjson(ledgerPath),
  boards: JSON.parse(readFileSync(boardsPath, 'utf8')),
  now,
});

const config = JSON.parse(readFileSync(new URL('../config/svbc.json', import.meta.url), 'utf8'));
const errors = checkArtifactGuards({ rows, donationBoardIds, ownerBoardIds, config });
if (errors.length > 0) {
  for (const e of errors) console.error(`bootstrap-gifts-from-artifacts: ${e}`);
  if (!force) {
    console.error('bootstrap-gifts-from-artifacts: no SQL written (pass --force to override — only if you are CERTAIN these artifacts match the live boards).');
    process.exit(1);
  }
  console.error('bootstrap-gifts-from-artifacts: --force given, proceeding anyway.');
}

writeFileSync(OUT, renderSql(rows, now), 'utf8');
console.error(`bootstrap-gifts-from-artifacts: ${rows.length} gifts → ${OUT} ` +
  `(${skippedNoOwner} without a migrated owner skipped)`);
