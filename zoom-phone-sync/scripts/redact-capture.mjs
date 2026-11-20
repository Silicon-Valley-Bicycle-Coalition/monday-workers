#!/usr/bin/env node
// Redacts captured Zoom deliveries into test fixtures (#50).
//
//   node scripts/redact-capture.mjs <capture.json>... [--out test/fixtures]
//
// Each capture is a raw delivery body (as stored by the temporary capture endpoint). All captures
// share one redactor, so a number seen in two deliveries gets the same stand-in in both. Writes
// <out>/<event without "phone.">.json (an existing file is overwritten) and lists any strings no
// rule recognized: read each before committing.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRedactor } from './redact.mjs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = outIdx === -1 ? 'test/fixtures' : args[outIdx + 1];
const files = args.filter((_, i) => i !== outIdx && i !== outIdx + 1);
if (files.length === 0 || !outDir) {
  console.error('usage: node scripts/redact-capture.mjs <capture.json>... [--out test/fixtures]');
  process.exit(2);
}

const redactor = createRedactor();
for (const file of files) {
  const delivery = JSON.parse(readFileSync(file, 'utf8'));
  const event = typeof delivery.event === 'string' ? delivery.event : path.basename(file, '.json');
  const out = path.join(outDir, `${event.replace(/^phone\./, '')}.json`);
  writeFileSync(out, `${JSON.stringify(redactor.redact(delivery), null, 2)}\n`);
  console.log(`wrote ${out}`);
}

const review = redactor.needsReview();
if (review.length > 0) {
  console.log(`\nKept unchanged, no rule matched — check each before committing:`);
  for (const p of review) console.log(`  ${p}`);
}
