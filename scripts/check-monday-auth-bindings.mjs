#!/usr/bin/env node
// Every Worker that talks to Monday reaches it through the monday-auth broker (a service binding
// named MONDAY_AUTH), and the entrypoint it binds decides what the Worker may do: PortalToken for
// the member portal, SyncToken for staff sync Workers, ReadOnlyToken for read-only ones. Binding the
// wrong one silently grants too much (or too little) access, and a sandbox env bound to the
// production broker would write sandbox traffic with the production token. This check pins the
// mapping from the design spec's apps table
// (docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md).
//
//   node scripts/check-monday-auth-bindings.mjs
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsonc } from './check-worker-flags.mjs';

export const BROKER = 'svbc-monday-auth';
export const SANDBOX_BROKER = 'svbc-monday-auth-sandbox';

// Worker -> the broker entrypoint it must bind. member-portal-writer is the second Worker deployed
// from member-portal/ (wrangler.writer.jsonc).
export const EXPECTED = {
  'member-portal': 'PortalToken',
  'member-portal-writer': 'SyncToken',
  'funraise-sync': 'SyncToken',
  'donation-rollups': 'SyncToken',
  'mailchimp-sync': 'SyncToken',
  'benevity-import': 'SyncToken',
  'email-log': 'SyncToken',
  'eventbrite-sync': 'SyncToken',
  'people-reclassification': 'SyncToken',
  'bp-feedback-notify': 'SyncToken',
  'quickbooks-sync': 'SyncToken',
  'monday-backup': 'ReadOnlyToken',
  'report-digests': 'ReadOnlyToken',
};

// Each Worker's Wrangler config file, keyed like EXPECTED.
export function configPathFor(worker) {
  return worker === 'member-portal-writer' ? 'member-portal/wrangler.writer.jsonc' : `${worker}/wrangler.jsonc`;
}

const bindingIn = (scope) => scope?.services?.find((s) => s.binding === 'MONDAY_AUTH') ?? null;

// configs: { [worker]: parsed Wrangler config }. Returns one message per problem.
export function checkBindings(configs) {
  const problems = [];
  for (const [worker, entrypoint] of Object.entries(EXPECTED)) {
    const config = configs[worker];
    if (config === undefined) {
      problems.push(`${worker}: no Wrangler config found`);
      continue;
    }
    const scopes = [
      ['production', bindingIn(config), BROKER],
      ['sandbox', bindingIn(config.env?.sandbox), SANDBOX_BROKER],
    ];
    for (const [label, binding, service] of scopes) {
      if (binding === null) {
        problems.push(`${worker} (${label}): no MONDAY_AUTH service binding`);
        continue;
      }
      if (binding.service !== service) {
        problems.push(`${worker} (${label}): MONDAY_AUTH binds service "${binding.service}", expected "${service}"`);
      }
      if (binding.entrypoint !== entrypoint) {
        problems.push(`${worker} (${label}): MONDAY_AUTH binds entrypoint "${binding.entrypoint}", expected "${entrypoint}"`);
      }
    }
  }
  for (const worker of Object.keys(configs)) {
    if (!(worker in EXPECTED)) problems.push(`${worker}: not in EXPECTED; add it with its entrypoint`);
  }
  return problems;
}

export function loadConfigs(root) {
  const configs = {};
  for (const worker of Object.keys(EXPECTED)) {
    const path = join(root, configPathFor(worker));
    if (existsSync(path)) configs[worker] = JSON.parse(stripJsonc(readFileSync(path, 'utf8')));
  }
  return configs;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = checkBindings(loadConfigs(root));
  for (const line of problems) console.log(`FAIL: ${line}`);
  if (problems.length === 0) console.log(`ok: ${Object.keys(EXPECTED).length} Workers bind the right monday-auth entrypoint`);
  process.exit(problems.length > 0 ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
