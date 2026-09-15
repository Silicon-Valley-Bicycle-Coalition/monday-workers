#!/usr/bin/env node
// Populates the gifts ledger (migrations/0004_gifts.sql, docs/20 §5.1) and the affiliations
// table (migrations/0005_affiliations.sql) from salesforce-import's run artifacts — the only
// complete record of gift and affiliation history under archive-in-place, for the same reason
// as bootstrap-links-from-artifacts.mjs: archived items are invisible to items_page and
// unreadable via board_relation. Carries the full provenance the webhook path can never see
// (gift type, Funraise id, Salesforce id, archived state, acting-for affiliation).
//
// Guardrails (this script replaces the ENTIRE authoritative ledger, ~37k gifts):
// - refuses when the artifacts produce 0 gift rows, reference board ids outside
//   config/svbc.json, or reference an "Acting for" affiliation the ledger lacks (all mean a
//   superseded/incomplete artifact set); --force overrides.
// - the generated SQL stages all rows into gifts_bootstrap / affiliations_bootstrap first and
//   only swaps into `gifts` / `affiliations` at the end, so a mid-run failure can't leave
//   either table emptied.
// Guard + SQL logic lives in bootstrap-gifts-lib.mjs (unit-tested).
//
// Usage:
//   node scripts/bootstrap-gifts-from-artifacts.mjs \
//     --payloads <path>/payloads.ndjson --ledger <path>/ledger.ndjson \
//     --boards <path>/boards.json [--out bootstrap-gifts.sql] \
//     [--out-affiliations bootstrap-affiliations.sql] [--force]
//   wrangler d1 execute <database-name> --remote --file=bootstrap-gifts.sql -y
//   wrangler d1 execute <database-name> --remote --file=bootstrap-affiliations.sql -y
//
// (-y matters: without a TTY, wrangler's confirm prompt silently cancels with exit 0.)

import { readFileSync, writeFileSync } from 'node:fs';
import {
  buildGiftRows, checkArtifactGuards, renderSql,
  buildAffiliationRows, renderAffiliationsSql,
} from './bootstrap-gifts-lib.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const payloadsPath = arg('--payloads'), ledgerPath = arg('--ledger'), boardsPath = arg('--boards');
const OUT = arg('--out') ?? 'bootstrap-gifts.sql';
const OUT_AFF = arg('--out-affiliations') ?? 'bootstrap-affiliations.sql';
const force = process.argv.includes('--force');
if (!payloadsPath || !ledgerPath || !boardsPath) {
  console.error('usage: bootstrap-gifts-from-artifacts.mjs --payloads <payloads.ndjson> --ledger <ledger.ndjson> --boards <boards.json> [--out file.sql] [--out-affiliations file.sql] [--force]');
  process.exit(1);
}

const ndjson = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const now = new Date().toISOString();
const payloads = ndjson(payloadsPath);
const ledgerEntries = ndjson(ledgerPath);
const boards = JSON.parse(readFileSync(boardsPath, 'utf8'));

const { rows, skippedNoOwner, skippedActingFor, donationBoardIds, ownerBoardIds } = buildGiftRows({
  payloads, ledgerEntries, boards, now,
});
const { rows: affRows, skippedNoPerson } = buildAffiliationRows({ payloads, ledgerEntries, boards });

const config = JSON.parse(readFileSync(new URL('../config/svbc.json', import.meta.url), 'utf8'));
const errors = checkArtifactGuards({ rows, skippedActingFor, donationBoardIds, ownerBoardIds, config });
if (errors.length > 0) {
  for (const e of errors) console.error(`bootstrap-gifts-from-artifacts: ${e}`);
  if (!force) {
    console.error('bootstrap-gifts-from-artifacts: no SQL written (pass --force to override — only if you are CERTAIN these artifacts match the live boards).');
    process.exit(1);
  }
  console.error('bootstrap-gifts-from-artifacts: --force given, proceeding anyway.');
}

writeFileSync(OUT, renderSql(rows, now), 'utf8');
writeFileSync(OUT_AFF, renderAffiliationsSql(affRows, now), 'utf8');
console.error(`bootstrap-gifts-from-artifacts: ${rows.length} gifts → ${OUT} ` +
  `(${skippedNoOwner} without a migrated owner skipped)`);
console.error(`bootstrap-gifts-from-artifacts: ${affRows.length} affiliations → ${OUT_AFF} ` +
  `(${skippedNoPerson} without a migrated person skipped)`);
