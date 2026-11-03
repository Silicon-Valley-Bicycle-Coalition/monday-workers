#!/usr/bin/env node
// Every Worker that talks to Monday reaches it through the monday-auth broker (a service binding
// named MONDAY_AUTH), and the entrypoint it binds decides what the Worker may do: PortalToken for
// the member portal, SyncToken for staff sync Workers, ReadOnlyToken for read-only ones. Binding the
// wrong one silently grants too much (or too little) access, and a sandbox env bound to the
// production broker would write sandbox traffic with the production token. This check pins the
// mapping from the design spec's apps table
// (docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md). It also scans every
// `*/wrangler*.jsonc` for any service binding to either broker, so a Worker missing from EXPECTED,
// or a second binding under another name, can't reach a token unchecked.
//
//   node scripts/check-monday-auth-bindings.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  'nearby-search': 'SyncToken',
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

const BROKERS = new Set([BROKER, SANDBOX_BROKER]);

// files: { [repo-relative path of a Wrangler config]: parsed config }. Flags every service
// binding to either broker that checkBindings doesn't cover: one in a config that isn't a listed
// Worker's, or one in a listed Worker's config under a name other than MONDAY_AUTH.
export function checkUnlistedBrokerServices(files) {
  const listedPaths = new Set(Object.keys(EXPECTED).map(configPathFor));
  const problems = [];
  for (const [path, config] of Object.entries(files)) {
    const scopes = [['production', config], ...Object.entries(config.env ?? {})];
    for (const [label, scope] of scopes) {
      for (const s of scope?.services ?? []) {
        if (!BROKERS.has(s.service)) continue;
        const what = `${path} (${label}): binds ${s.service} (entrypoint "${s.entrypoint ?? '(default)'}") as ${s.binding}`;
        if (!listedPaths.has(path)) problems.push(`${what} but is not in EXPECTED; add it with its entrypoint`);
        else if (s.binding !== 'MONDAY_AUTH') problems.push(`${what}; only MONDAY_AUTH may bind the broker`);
      }
    }
  }
  return problems;
}

// Every `*/wrangler*.jsonc` one directory below root, keyed by its repo-relative path.
export function loadAllConfigs(root) {
  const files = {};
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith('.') || dir.name === 'node_modules') continue;
    for (const name of readdirSync(join(root, dir.name))) {
      if (!/^wrangler.*\.jsonc$/.test(name)) continue;
      const path = `${dir.name}/${name}`;
      files[path] = JSON.parse(stripJsonc(readFileSync(join(root, path), 'utf8')));
    }
  }
  return files;
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
  const problems = [...checkBindings(loadConfigs(root)), ...checkUnlistedBrokerServices(loadAllConfigs(root))];
  for (const line of problems) console.log(`FAIL: ${line}`);
  if (problems.length === 0) console.log(`ok: ${Object.keys(EXPECTED).length} Workers bind the right monday-auth entrypoint`);
  process.exit(problems.length > 0 ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
