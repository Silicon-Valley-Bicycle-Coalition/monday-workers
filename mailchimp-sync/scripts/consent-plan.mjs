#!/usr/bin/env node
// Read-only rehearsal of the hourly consent sync (src/consent/run.ts): reads every Mailchimp
// member's status and each configured board's address and consent columns, then prints what the
// run would change, per board, column and transition, and what the cap would hold. Writes nothing,
// and runs whether or not consent.enabled is set — it is how production is checked before the
// switch, since the Worker-wide write switch can't go to `off` there without dropping live syncs.
//
//   MAILCHIMP_API_KEY=... MONDAY_API_TOKEN=... node scripts/consent-plan.mjs --env sandbox|production
//
// Prints board names, column ids and counts only; never an address.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MondayGraphQL } from '../src/monday/graphql.ts';
import { applyGuard, planBoard, summarize } from '../src/consent/plan.ts';
import { createConsentMonday, readMailchimpStatuses } from '../src/consent/sources.ts';

const CONFIG_FILES = { sandbox: 'sandbox.json', production: 'svbc.json' };

function usage(message) {
  console.error(`${message}\nusage: node scripts/consent-plan.mjs --env sandbox|production`);
  process.exit(2);
}

async function main() {
  const envIdx = process.argv.indexOf('--env');
  const envName = envIdx >= 0 ? process.argv[envIdx + 1] : undefined;
  if (!envName || !(envName in CONFIG_FILES)) usage('--env is required');
  for (const name of ['MAILCHIMP_API_KEY', 'MONDAY_API_TOKEN']) {
    if (!process.env[name]) usage(`${name} is not set`);
  }
  const config = JSON.parse(readFileSync(fileURLToPath(new URL(`../config/${CONFIG_FILES[envName]}`, import.meta.url)), 'utf8'));
  const started = Date.now();

  const statuses = await readMailchimpStatuses({
    fetchFn: fetch,
    apiBaseUrl: config.mailchimp.apiBaseUrl,
    apiKey: process.env.MAILCHIMP_API_KEY,
    audienceId: config.mailchimp.audienceId,
  });
  const byStatus = {};
  for (const status of statuses.values()) byStatus[status] = (byStatus[status] ?? 0) + 1;
  console.log(`Mailchimp audience ${config.mailchimp.audienceId}: ${statuses.size} members`, byStatus);

  const transport = new MondayGraphQL(config.monday.apiUrl, process.env.MONDAY_API_TOKEN);
  const monday = createConsentMonday((query, variables) => transport.request(query, variables));
  const changes = [];
  for (const board of config.consent.boards) {
    const items = await monday.readBoard(board);
    console.log(`${board.name} (${board.boardId}): ${items.length} items`);
    changes.push(...planBoard(board, items, statuses));
  }

  const { allowed, held, tripped } = applyGuard(changes, config.consent.maxChangesPerRun);
  console.log(`\nPlanned changes: ${changes.length} (consent.enabled is ${config.consent.enabled})`);
  for (const [key, n] of Object.entries(summarize(changes)).sort()) console.log(`  ${String(n).padStart(6)}  ${key}`);
  console.log(tripped
    ? `\nCap tripped: ${held.length} changes toward a sendable value exceed ${config.consent.maxChangesPerRun}; the run would write only the ${allowed.length} opt-outs.`
    : `\nCap not tripped (limit ${config.consent.maxChangesPerRun}); the run would write all ${allowed.length}.`);
  console.log(`Took ${((Date.now() - started) / 1000).toFixed(1)} s.`);
}

main().catch((err) => {
  console.error(`consent-plan: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
  process.exit(1);
});
