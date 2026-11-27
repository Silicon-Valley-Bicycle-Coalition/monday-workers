#!/usr/bin/env node
// Step 1 of IT Requests "funraise-sync should re-read each gift from Funraise instead of trusting
// the webhook body": one read-only GET /api/v1/crm/donation/{id} for a gift whose webhook payload
// D1 still holds, compared path by path with that payload. Prints paths and verdicts only, never
// values (both sides are donor PII), so the output can be pasted into the ticket.
//
// Usage (from funraise-sync/):
//   FUNRAISE_API_KEY=<production key> node scripts/compare-donation-shape.mjs [--id <transaction id>] [--env sandbox]
//
// Without --id it takes the newest `written` transaction in the D1 (svbc-funraise-sync, or the
// sandbox one with --env sandbox), read with `wrangler d1 execute --remote` using the local
// wrangler login. Exit 0 = every path the consumer maps lines up, 1 = something differs or is
// missing (read the report), 2 = bad usage or a failed read.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeWranglerFailure } from './replay-window-lib.mjs';
import { mappedPaths, compareShapes, formatRow, latestWrittenSql, byIdSql } from './compare-donation-shape-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argValue = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const fail = (m) => {
  console.error(`compare-donation-shape: ${m}`);
  process.exit(2);
};

const apiKey = process.env.FUNRAISE_API_KEY;
if (!apiKey) fail('FUNRAISE_API_KEY is required');
const env = argValue('--env', 'production');
if (env !== 'production' && env !== 'sandbox') fail('--env must be sandbox or production');
const id = argValue('--id', null);

const config = JSON.parse(readFileSync(join(HERE, '..', 'config', env === 'sandbox' ? 'sandbox.json' : 'svbc.json'), 'utf8'));
const database = env === 'sandbox' ? 'svbc-funraise-sync-sandbox' : 'svbc-funraise-sync';
const baseUrl = 'https://api.funraise.io'; // src/index.ts FUNRAISE_API_URL

let sql;
try {
  sql = id === null ? latestWrittenSql() : byIdSql(id);
} catch (err) {
  fail(err.message);
}
const args = ['wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql];
if (env === 'sandbox') args.push('--env', 'sandbox');
let row;
try {
  const out = execFileSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: join(HERE, '..') });
  row = JSON.parse(out)[0].results[0];
} catch (err) {
  fail(`could not read ${database}: ${describeWranglerFailure(err)}`);
}
if (!row) fail(`no transaction with a stored payload in ${database}${id ? ` for id ${id}` : ''}`);
const webhookData = JSON.parse(row.raw_payload);

const res = await fetch(new URL(`/api/v1/crm/donation/${row.entity_id}`, baseUrl), {
  headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
  signal: AbortSignal.timeout(15_000),
});
console.log(`transaction ${row.entity_id} (sent ${row.sent_at ? new Date(Number(row.sent_at)).toISOString() : 'unknown'})`);
console.log(`GET /api/v1/crm/donation/${row.entity_id} → HTTP ${res.status}`);
if (!res.ok) {
  console.log(res.status === 404 ? 'Not found: the donation API does not use the webhook transaction id.' : 'Read failed.');
  process.exit(res.status === 404 ? 1 : 2);
}
const apiRecord = await res.json();
if (typeof apiRecord !== 'object' || apiRecord === null || Array.isArray(apiRecord)) fail('expected a JSON object');

const report = compareShapes(webhookData, apiRecord, mappedPaths(config.funraiseSync));
console.log('\nPaths the consumer maps:');
report.mapped.forEach((r) => console.log(formatRow(r)));
console.log('\nEverything else:');
report.other.forEach((r) => console.log(formatRow(r)));
console.log(`\n${report.linesUp ? 'LINES UP: every mapped path matches.' : 'DOES NOT LINE UP: see the mapped paths above.'}`);
process.exit(report.linesUp ? 0 : 1);
