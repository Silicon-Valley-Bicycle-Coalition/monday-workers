#!/usr/bin/env node
// Drift check for the write-switch module. member-portal/src/flags.ts is canonical; every in-scope
// Worker carries a byte-identical copy at <worker>/src/flags.ts, and the same FLAGS KV namespace
// ids (production and sandbox) in <worker>/wrangler.jsonc.
//
//   node scripts/check-worker-flags.mjs            a Worker without the copy or binding is "pending"
//   node scripts/check-worker-flags.mjs --strict   ...and that is a failure too
//
// A copy that exists but differs, or ids that disagree, always fails.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IN_SCOPE = [
  'benevity-import', 'bp-feedback-notify', 'contact-roles', 'donation-rollups', 'dtd-sync', 'eventbrite-sync',
  'funraise-sync', 'impact-attribution', 'mailchimp-sync', 'member-portal', 'monday-backup', 'nearby-search',
  'people-reclassification', 'quickbooks-sync', 'report-digests', 'zoom-phone-sync',
];
const CANONICAL = 'member-portal/src/flags.ts';

// Paths (keys of `copies`) whose text differs from the canonical text.
export function findDrift(canonical, copies) {
  return Object.keys(copies).filter((path) => copies[path] !== canonical);
}

// Drops // and /* */ comments (outside strings) and trailing commas, so JSON.parse can read JSONC.
export function stripJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const flagsIdIn = (scope) =>
  scope?.kv_namespaces?.find((ns) => ns.binding === 'FLAGS')?.id ?? null;

// The FLAGS KV namespace id at the top level and in env.sandbox (null where unbound).
export function flagsIds(wranglerText) {
  const config = JSON.parse(stripJsonc(wranglerText));
  return { production: flagsIdIn(config), sandbox: flagsIdIn(config.env?.sandbox) };
}

// Workers whose ids differ from the first Worker that has a binding. Unbound Workers are skipped.
export function checkIds(list) {
  const bound = list.filter((entry) => entry.production !== null || entry.sandbox !== null);
  if (bound.length === 0) return [];
  const [first] = bound;
  return bound.slice(1)
    .filter((entry) => entry.production !== first.production || entry.sandbox !== first.sandbox)
    .map((entry) => entry.worker);
}

// A Worker's Wrangler configs: wrangler.jsonc, plus wrangler.writer.jsonc when it has one (a
// second Worker deployed from the same directory, e.g. member-portal-writer, sharing its FLAGS).
export function configFiles(worker, exists) {
  return ['wrangler.jsonc', 'wrangler.writer.jsonc']
    .map((name) => `${worker}/${name}`)
    .filter((path, i) => i === 0 || exists(path));
}

function main() {
  const strict = process.argv.includes('--strict');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const canonical = readFileSync(join(root, CANONICAL), 'utf8');
  const failures = [];
  const pending = [];

  const copies = {};
  const ids = [];
  for (const worker of IN_SCOPE) {
    const flagsPath = `${worker}/src/flags.ts`;
    if (existsSync(join(root, flagsPath))) copies[flagsPath] = readFileSync(join(root, flagsPath), 'utf8');
    else pending.push(`${flagsPath} missing`);

    for (const configPath of configFiles(worker, (path) => existsSync(join(root, path)))) {
      const full = join(root, configPath);
      const found = existsSync(full) ? flagsIds(readFileSync(full, 'utf8')) : { production: null, sandbox: null };
      if (found.production === null || found.sandbox === null) pending.push(`${configPath} has no FLAGS binding${found.production === null && found.sandbox === null ? '' : ' in one environment'}`);
      ids.push({ worker: configPath, ...found });
    }
  }

  for (const path of findDrift(canonical, copies)) failures.push(`${path} differs from ${CANONICAL}`);
  for (const worker of checkIds(ids)) failures.push(`${worker} FLAGS ids differ from the other Workers'`);
  if (strict) failures.push(...pending);

  for (const line of pending) console.log(`${strict ? 'FAIL' : 'pending'}: ${line}`);
  for (const line of failures.filter((f) => !strict || !pending.includes(f))) console.log(`FAIL: ${line}`);
  process.exit(failures.length > 0 ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
