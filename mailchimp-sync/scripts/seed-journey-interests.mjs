#!/usr/bin/env node
// Sets the Customer Journey interests for members who existed before the outbound sync started
// managing them. Two modes, each a dry run unless --apply:
//
//   --renewal <id>   Renewal Reminders on for every subscribed member tagged `active-member`
//                    (mailchimp.tags.activeMember), except those tagged `renewal-opt-out`
//                    (scripts/renewal-opt-out.mjs). Add-only. Production run 2026-11-17: 663.
//   --undo-welcome <id> --joined-before YYYY-MM-DD
//                    Welcome Drip off for members whose Member Since (MEMBSINCE) is before the
//                    date or blank. The welcome series is for new members only: the outbound sync
//                    turns Welcome Drip on when someone first becomes active. Undoes the
//                    2026-11-17 seeding of 800 existing members; members who joined on or after
//                    the date keep theirs, so it's safe to re-run.
//
// No status changes, no members created. Output is counts only, never an address.
//
//   MAILCHIMP_API_KEY=... node scripts/seed-journey-interests.mjs --env production|sandbox \
//     (--renewal <id> | --undo-welcome <id> --joined-before YYYY-MM-DD) [--apply]
//   (production: Renewal Reminders 986d6c84bf, Welcome Drip be943454d9)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { subscriberHash } from './renewal-opt-out-lib.mjs';
import { countChanges, planRenewal, planWelcomeUndo } from './seed-journey-interests-lib.mjs';

const CONFIG_FILES = { sandbox: 'sandbox.json', production: 'svbc.json' };
const argIdx = (name) => process.argv.indexOf(name);
const argValue = (name, dflt) => (argIdx(name) >= 0 ? process.argv[argIdx(name) + 1] : dflt);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(message) {
  console.error(`${message}\nusage: node scripts/seed-journey-interests.mjs --env production|sandbox (--renewal <id> | --undo-welcome <id> --joined-before YYYY-MM-DD) [--apply]`);
  process.exit(2);
}

async function main() {
  const envName = argValue('--env');
  if (!envName || !(envName in CONFIG_FILES)) usage('--env is required');
  const renewalId = argValue('--renewal');
  const welcomeId = argValue('--undo-welcome');
  const joinedBefore = argValue('--joined-before');
  if (!renewalId === !welcomeId) usage('pass exactly one of --renewal or --undo-welcome');
  if (welcomeId && !/^\d{4}-\d{2}-\d{2}$/.test(joinedBefore ?? '')) usage('--undo-welcome needs --joined-before YYYY-MM-DD');
  if (!process.env.MAILCHIMP_API_KEY) usage('MAILCHIMP_API_KEY is not set');
  const apply = argIdx('--apply') >= 0;
  const config = JSON.parse(readFileSync(fileURLToPath(new URL(`../config/${CONFIG_FILES[envName]}`, import.meta.url)), 'utf8'));
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

  // A mistyped interest id would otherwise read as "off" for everyone.
  const category = config.mailchimp.interestCategoryIds[0];
  const interestId = renewalId ?? welcomeId;
  const check = await call('GET', `/interest-categories/${category}/interests/${interestId}?fields=name`);
  if (!check.ok) throw new Error(`interest ${interestId} not found in category ${category} (HTTP ${check.status})`);
  const { name } = await check.json();

  // Renewal seeding reads subscribed members only; the undo reads every non-archived status, since
  // the seeding only touched subscribed members but one may have unsubscribed since.
  const statusFilter = renewalId ? 'status=subscribed&' : '';
  const sinceField = config.mailchimp.mergeFields.memberSince;
  const members = [];
  let total = null;
  for (let offset = 0; total === null || offset < total; offset += 1000) {
    const res = await call('GET', `/members?${statusFilter}count=1000&offset=${offset}&fields=total_items,members.email_address,members.status,members.tags,members.interests,members.merge_fields.${sinceField}`);
    if (!res.ok) throw new Error(`list members: HTTP ${res.status} at offset ${offset}`);
    const page = await res.json();
    if (total !== null && page.total_items !== total) throw new Error(`audience changed while paging (${total} → ${page.total_items}); re-run`);
    total = page.total_items;
    members.push(...page.members);
    if (page.members.length === 0) break;
  }

  const plan = renewalId
    ? (mbr) => planRenewal(mbr, { activeTag: config.mailchimp.tags.activeMember, optOutTag: 'renewal-opt-out', renewalId })
    : (mbr) => planWelcomeUndo(mbr, { welcomeId, joinedBefore, sinceField });
  const plans = members.map((mbr) => ({ email: mbr.email_address, change: plan(mbr) })).filter((p) => p.change);
  console.log(`Audience ${config.mailchimp.audienceId}: ${members.length} members read; "${name}" (${interestId})`);
  console.log(`  ${plans.length} to change`, countChanges(plans), welcomeId ? `(joined before ${joinedBefore} or no join date)` : '');
  if (!apply) {
    console.log('\nDry run: nothing written. Re-run with --apply to write.');
    return;
  }
  let failed = 0;
  for (const p of plans) {
    // skip_merge_validation: ~1,800 members have a blank required merge field (src/mailchimp/client.ts).
    const res = await call('PATCH', `/members/${subscriberHash(p.email)}?skip_merge_validation=true`, { interests: p.change });
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
