#!/usr/bin/env node
// Carries Salesforce's Renewal Opt Out (Contact.Renewal_Opt_Out__c, not migrated) into Mailchimp
// so the renewal-reminder Customer Journey can leave those members out: each opted-out address
// already in the audience gets the `renewal-opt-out` tag, and, with --interest, its Renewal
// Reminders interest turned off. Exclude the tag in the Journey's audience too: the tag survives a
// later bulk re-seed of the interest. Neither this Worker nor anything else removes the tag.
//
// Never creates a member or changes one's status (Mailchimp is the consent system of record), so
// an address the audience doesn't hold is only counted. Re-runnable: a member already tagged and
// opted out is left alone.
//
// DRY RUN BY DEFAULT: reads every member and prints what --apply would change. Output is counts
// only, never an address.
//
// Usage (from mailchimp-sync/):
//   MAILCHIMP_API_KEY=... node scripts/renewal-opt-out.mjs --env production|sandbox
//     [--org svbc]               Salesforce CLI alias to read (default: svbc for production,
//                                svbc-sandbox for sandbox); needs `sf` logged in
//     [--csv file.csv]           read addresses from an export's Email column instead of Salesforce
//     [--save file.csv]          also write the opted-out addresses to a local CSV (holds PII:
//                                keep it out of git)
//     [--tag renewal-opt-out]    tag to apply
//     [--interest <id>]          interest to turn off (production Renewal Reminders: 986d6c84bf)
//     [--apply]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TAG, OPT_OUT_SOQL, emailsFromCsv, optOutEmails, planMember, subscriberHash, summarize } from './renewal-opt-out-lib.mjs';

const CONFIG_FILES = { sandbox: 'sandbox.json', production: 'svbc.json' };
const DEFAULT_ORGS = { sandbox: 'svbc-sandbox', production: 'svbc' };
const argIdx = (name) => process.argv.indexOf(name);
const argValue = (name, dflt) => (argIdx(name) >= 0 ? process.argv[argIdx(name) + 1] : dflt);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(message) {
  console.error(`${message}\nusage: node scripts/renewal-opt-out.mjs --env production|sandbox [--org alias | --csv file] [--save file] [--tag name] [--interest id] [--apply]`);
  process.exit(2);
}

function readSalesforce(org) {
  // execFile, no shell: the SOQL is one argv entry. 611 rows at the 2026-11-17 check, far under
  // the CLI's 50,000-row page, but refuse a truncated result rather than miss anyone.
  const out = execFileSync('sf', ['data', 'query', '--target-org', org, '--json', '-q', OPT_OUT_SOQL],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const { status, result, message } = JSON.parse(out);
  if (status !== 0) throw new Error(`sf data query failed: ${message}`);
  if (result.done === false) throw new Error(`sf data query truncated at ${result.records.length} of ${result.totalSize}`);
  return result.records;
}

function mailchimp(apiBaseUrl, apiKey, audienceId) {
  const auth = `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`;
  const base = `${apiBaseUrl}/lists/${audienceId}/members`;
  async function call(method, path, body) {
    for (let attempt = 1; ; attempt += 1) {
      const res = await fetch(base + path, {
        method,
        headers: { Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await sleep(Math.max(Number(res.headers.get('retry-after')) || 0, 2 ** attempt) * 1000);
        continue;
      }
      return res;
    }
  }
  return {
    async getMember(hash, interestId) {
      const fields = ['status', 'tags', ...(interestId ? ['interests'] : [])].join(',');
      const res = await call('GET', `/${hash}?fields=${fields}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET member ${hash}: HTTP ${res.status}`);
      return res.json();
    },
    async addTag(hash, tag) {
      const res = await call('POST', `/${hash}/tags`, { tags: [{ name: tag, status: 'active' }] });
      if (!res.ok) throw new Error(`tag member ${hash}: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
    async clearInterest(hash, interestId) {
      // skip_merge_validation: ~1,800 imported members have a blank required merge field, and
      // Mailchimp checks every required field on any member PATCH (see src/mailchimp/client.ts).
      const res = await call('PATCH', `/${hash}?skip_merge_validation=true`, { interests: { [interestId]: false } });
      if (!res.ok) throw new Error(`clear interest on member ${hash}: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}

async function main() {
  const envName = argValue('--env');
  if (!envName || !(envName in CONFIG_FILES)) usage('--env is required');
  if (!process.env.MAILCHIMP_API_KEY) usage('MAILCHIMP_API_KEY is not set');
  const csv = argValue('--csv', null);
  const org = argValue('--org', DEFAULT_ORGS[envName]);
  const tag = argValue('--tag', DEFAULT_TAG);
  const interestId = argValue('--interest', null);
  const save = argValue('--save', null);
  const apply = argIdx('--apply') >= 0;
  const config = JSON.parse(readFileSync(fileURLToPath(new URL(`../config/${CONFIG_FILES[envName]}`, import.meta.url)), 'utf8'));
  const { apiBaseUrl, audienceId } = config.mailchimp;

  const source = csv ? emailsFromCsv(readFileSync(csv, 'utf8')) : optOutEmails(readSalesforce(org));
  console.log(`Source ${csv ? 'CSV' : `Salesforce org ${org}`}: ${source.contacts} opted-out contacts, ` +
    `${source.withoutEmail} without an address, ${source.emails.length} distinct addresses`);
  if (save) {
    writeFileSync(save, ['email', ...source.emails].join('\n') + '\n', { mode: 0o600 });
    console.log(`Saved the addresses to ${save} (PII — keep it out of git)`);
  }

  const mc = mailchimp(apiBaseUrl, process.env.MAILCHIMP_API_KEY, audienceId);
  const plans = [];
  for (const email of source.emails) {
    const hash = subscriberHash(email);
    plans.push({ hash, ...planMember(await mc.getMember(hash, interestId), { tag, interestId }) });
  }
  const s = summarize(plans);
  console.log(`\nMailchimp audience ${audienceId} (${envName}): tag "${tag}"${interestId ? `, interest ${interestId} off` : ', no interest change'}`);
  console.log(`  ${s.notInAudience} not in the audience (left alone)`);
  console.log(`  ${s.total - s.notInAudience} members by status:`, s.byStatus);
  console.log(`  ${s.addTag} to tag, ${s.clearInterest} to opt out of the interest, ${s.nothingToDo} already done`);
  if (!apply) {
    console.log('\nDry run: nothing written. Re-run with --apply to write.');
    return;
  }

  let failed = 0;
  for (const p of plans) {
    if (p.kind !== 'member') continue;
    try {
      if (p.addTag) await mc.addTag(p.hash, tag);
      if (p.clearInterest) await mc.clearInterest(p.hash, interestId);
    } catch (err) {
      failed += 1;
      console.error(`  ${err.message}`);
    }
  }
  console.log(`\nApplied: ${s.addTag} tag and ${s.clearInterest} interest changes attempted, ${failed} members failed. Re-run to retry.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`renewal-opt-out: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
  process.exit(1);
});
