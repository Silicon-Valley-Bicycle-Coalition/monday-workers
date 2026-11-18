#!/usr/bin/env node
// One-time backfill of the `recurring-donor` tag (mailchimp.tags.recurringDonor) from People's
// Has Active Recurring Gift checkbox (monday.columns.hasActiveRecurringGift). The outbound sync
// sets the tag only when a person's row next changes, so people whose box was checked before the
// tag existed never got it (5 tagged against 513 checked on 2026-11-17), and the renewal Journey,
// which excludes the tag, would remind them to renew a gift that renews itself.
//
// Applies the sync's own rule to everyone at once: tag a member whose People address (the
// configured email column) has the box checked, untag one whose box isn't. Never creates a member
// or changes a status; members with no People item, and People addresses not in the audience, are
// left alone. Archived members aren't read: they get no email.
//
// DRY RUN BY DEFAULT. Output is counts only, never an address.
//
//   MAILCHIMP_API_KEY=... MONDAY_API_TOKEN=... node scripts/recurring-donor-backfill.mjs --env production|sandbox [--apply]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MondayGraphQL } from '../src/monday/graphql.ts';
import { subscriberHash } from './renewal-opt-out-lib.mjs';
import { desiredByEmail, planTags, summarize } from './recurring-donor-backfill-lib.mjs';

const CONFIG_FILES = { sandbox: 'sandbox.json', production: 'svbc.json' };
const argIdx = (name) => process.argv.indexOf(name);
const argValue = (name, dflt) => (argIdx(name) >= 0 ? process.argv[argIdx(name) + 1] : dflt);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(message) {
  console.error(`${message}\nusage: node scripts/recurring-donor-backfill.mjs --env production|sandbox [--apply]`);
  process.exit(2);
}

async function readPeople(transport, boardId, columnIds) {
  const FIELDS = 'cursor items { id column_values(ids: $columnIds) { id text ... on EmailValue { email } } }';
  const flatten = (items) => items.map((item) => Object.fromEntries(item.column_values.map((cv) => [cv.id, (cv.email || cv.text || '').trim()])));
  const first = await transport.request(
    `query ($boardId: ID!, $columnIds: [String!]) { boards(ids: [$boardId]) { items_page(limit: 500) { ${FIELDS} } } }`,
    { boardId, columnIds },
  );
  let page = first.boards?.[0]?.items_page;
  if (!page) throw new Error(`board ${boardId} is not readable`);
  const items = flatten(page.items);
  while (page.cursor) {
    const next = await transport.request(
      `query ($cursor: String!, $columnIds: [String!]) { next_items_page(limit: 500, cursor: $cursor) { ${FIELDS} } }`,
      { cursor: page.cursor, columnIds },
    );
    page = next.next_items_page;
    items.push(...flatten(page.items));
  }
  return items;
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
        signal: AbortSignal.timeout(30_000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await sleep(Math.max(Number(res.headers.get('retry-after')) || 0, 2 ** attempt) * 1000);
        continue;
      }
      return res;
    }
  }
  return {
    // Every non-archived member with its tags. A total that moves while paging means a member
    // was added or removed mid-read; stop rather than plan on a shifted page.
    async allMembers() {
      const members = [];
      let total = null;
      for (let offset = 0; total === null || offset < total; offset += 1000) {
        const res = await call('GET', `?count=1000&offset=${offset}&fields=total_items,members.email_address,members.status,members.tags`);
        if (!res.ok) throw new Error(`list members: HTTP ${res.status} at offset ${offset}`);
        const page = await res.json();
        if (total !== null && page.total_items !== total) throw new Error(`audience changed while paging (${total} → ${page.total_items}); re-run`);
        total = page.total_items;
        members.push(...page.members);
        if (page.members.length === 0) break;
      }
      if (members.length !== total) throw new Error(`read ${members.length} of ${total} members; re-run`);
      return members;
    },
    async setTag(email, tag, active) {
      const res = await call('POST', `/${subscriberHash(email)}/tags`, { tags: [{ name: tag, status: active ? 'active' : 'inactive' }] });
      if (!res.ok) throw new Error(`tag member ${subscriberHash(email)}: HTTP ${res.status}`);
    },
  };
}

async function main() {
  const envName = argValue('--env');
  if (!envName || !(envName in CONFIG_FILES)) usage('--env is required');
  for (const name of ['MAILCHIMP_API_KEY', 'MONDAY_API_TOKEN']) if (!process.env[name]) usage(`${name} is not set`);
  const apply = argIdx('--apply') >= 0;
  const config = JSON.parse(readFileSync(fileURLToPath(new URL(`../config/${CONFIG_FILES[envName]}`, import.meta.url)), 'utf8'));
  const { donorsBoardId, columns, apiUrl } = config.monday;
  const tag = config.mailchimp.tags.recurringDonor;
  if (!columns.hasActiveRecurringGift) throw new Error('monday.columns.hasActiveRecurringGift is not configured; the sync manages no recurring-donor tag');

  const transport = new MondayGraphQL(apiUrl, process.env.MONDAY_API_TOKEN);
  const items = await readPeople(transport, donorsBoardId, [columns.email, columns.hasActiveRecurringGift]);
  const desired = desiredByEmail(items, { emailColumn: columns.email, recurringColumn: columns.hasActiveRecurringGift });
  console.log(`People board ${donorsBoardId}: ${items.length} items, ${desired.size} distinct addresses`);

  const mc = mailchimp(config.mailchimp.apiBaseUrl, process.env.MAILCHIMP_API_KEY, config.mailchimp.audienceId);
  const members = await mc.allMembers();
  const { plans, notInAudience } = planTags(desired, members, tag);
  const s = summarize(desired, plans, notInAudience);
  console.log(`Mailchimp audience ${config.mailchimp.audienceId}: ${members.length} non-archived members`);
  console.log(`  ${s.checked} People addresses with an active recurring gift; ${s.notInAudience} People addresses not in the audience (left alone)`);
  console.log(`  "${tag}": ${s.add} to add`, s.addByStatus, `, ${s.remove} to remove`);
  if (!apply) {
    console.log('\nDry run: nothing written. Re-run with --apply to write.');
    return;
  }
  let failed = 0;
  for (const p of plans) {
    try {
      await mc.setTag(p.email, tag, p.change === 'add');
    } catch (err) {
      failed += 1;
      console.error(`  ${err.message}`);
    }
  }
  console.log(`\nApplied: ${plans.length - failed} tag changes, ${failed} failed. Re-run to retry.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`recurring-donor-backfill: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
  process.exit(1);
});
