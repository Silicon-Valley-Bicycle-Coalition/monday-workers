#!/usr/bin/env node
// Seeds the two Customer Journey interests for current members: every subscribed member tagged
// `active-member` (mailchimp.tags.activeMember, kept by the outbound sync from Membership Status)
// gets Welcome Drip and Renewal Reminders turned on, except Renewal Reminders for anyone tagged
// `renewal-opt-out` (scripts/renewal-opt-out.mjs). Add-only: nothing is turned off and no status
// changes, so a member who later unticks an interest stays unticked on a re-run only if they're
// no longer active; re-run deliberately, not on a schedule.
//
// Turning an interest on can itself start a Journey whose trigger is "joins a group", so seed
// before building the Journeys, and trigger them on MEMBSINCE/MEMBUNTIL dates, not on joining.
//
// DRY RUN BY DEFAULT. Output is counts only, never an address.
//
//   MAILCHIMP_API_KEY=... node scripts/seed-journey-interests.mjs --env production|sandbox \
//     --welcome <interest id> --renewal <interest id> [--apply]
//   (production: --welcome be943454d9 --renewal 986d6c84bf)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { subscriberHash } from './renewal-opt-out-lib.mjs';
import { planMember, summarize } from './seed-journey-interests-lib.mjs';

const CONFIG_FILES = { sandbox: 'sandbox.json', production: 'svbc.json' };
const argIdx = (name) => process.argv.indexOf(name);
const argValue = (name, dflt) => (argIdx(name) >= 0 ? process.argv[argIdx(name) + 1] : dflt);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(message) {
  console.error(`${message}\nusage: node scripts/seed-journey-interests.mjs --env production|sandbox --welcome <id> --renewal <id> [--apply]`);
  process.exit(2);
}

async function main() {
  const envName = argValue('--env');
  if (!envName || !(envName in CONFIG_FILES)) usage('--env is required');
  const welcomeId = argValue('--welcome');
  const renewalId = argValue('--renewal');
  if (!welcomeId || !renewalId) usage('--welcome and --renewal are required');
  if (!process.env.MAILCHIMP_API_KEY) usage('MAILCHIMP_API_KEY is not set');
  const apply = argIdx('--apply') >= 0;
  const config = JSON.parse(readFileSync(fileURLToPath(new URL(`../config/${CONFIG_FILES[envName]}`, import.meta.url)), 'utf8'));
  const opts = { activeTag: config.mailchimp.tags.activeMember, optOutTag: 'renewal-opt-out', welcomeId, renewalId };
  const auth = `Basic ${Buffer.from(`anystring:${process.env.MAILCHIMP_API_KEY}`).toString('base64')}`;
  const base = `${config.mailchimp.apiBaseUrl}/lists/${config.mailchimp.audienceId}`;
  const call = async (method, path, body) => {
    for (let attempt = 1; ; attempt += 1) {
      const res = await fetch(base + path, {
        method,
        headers: { Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await sleep(Math.max(Number(res.headers.get('retry-after')) || 0, 2 ** attempt) * 1000);
        continue;
      }
      return res;
    }
  };

  // A mistyped interest id would otherwise read as "off" for everyone and PATCH a dead key.
  for (const id of [welcomeId, renewalId]) {
    const res = await call('GET', `/interest-categories/${config.mailchimp.interestCategoryIds[0]}/interests/${id}?fields=name`);
    if (!res.ok) throw new Error(`interest ${id} not found in category ${config.mailchimp.interestCategoryIds[0]} (HTTP ${res.status})`);
  }

  const members = [];
  let total = null;
  for (let offset = 0; total === null || offset < total; offset += 1000) {
    const res = await call('GET', `/members?status=subscribed&count=1000&offset=${offset}&fields=total_items,members.email_address,members.status,members.tags,members.interests`);
    if (!res.ok) throw new Error(`list members: HTTP ${res.status} at offset ${offset}`);
    const page = await res.json();
    if (total !== null && page.total_items !== total) throw new Error(`audience changed while paging (${total} → ${page.total_items}); re-run`);
    total = page.total_items;
    members.push(...page.members);
    if (page.members.length === 0) break;
  }

  const plans = members.map((m) => ({ email: m.email_address, turnOn: planMember(m, opts) })).filter((p) => p.turnOn);
  const s = summarize(members, plans, opts);
  console.log(`Audience ${config.mailchimp.audienceId}: ${members.length} subscribed, ${s.activeSubscribed} tagged ${opts.activeTag}`);
  console.log(`  Welcome Drip (${welcomeId}): ${s.welcomeOn} to turn on`);
  console.log(`  Renewal Reminders (${renewalId}): ${s.renewalOn} to turn on (${s.optedOutOfRenewals} left off as renewal-opt-out)`);
  if (!apply) {
    console.log('\nDry run: nothing written. Re-run with --apply to write.');
    return;
  }
  let failed = 0;
  for (const p of plans) {
    // skip_merge_validation: ~1,800 members have a blank required merge field (src/mailchimp/client.ts).
    const res = await call('PATCH', `/members/${subscriberHash(p.email)}?skip_merge_validation=true`, { interests: p.turnOn });
    if (!res.ok) {
      failed += 1;
      console.error(`  member ${subscriberHash(p.email)}: HTTP ${res.status}`);
    }
  }
  console.log(`\nApplied: ${plans.length - failed} members updated, ${failed} failed. Re-run to retry.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`seed-journey-interests: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
  process.exit(1);
});
