#!/usr/bin/env node
// Every `ratelimits[].namespace_id` must be unique across `*/wrangler*.jsonc` (top level and
// every env). Bindings that share an id share per-IP counters even when their limits differ, so
// one Worker's traffic can 429 another's (GL#113: member-map's asset loads starving nearby-search).
//
//   node scripts/check-rate-limit-namespaces.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllConfigs } from './check-monday-auth-bindings.mjs';

// files: { [repo-relative path]: parsed config }. Returns one message per duplicated id.
export function checkRateLimitNamespaces(files) {
  const seen = new Map(); // namespace_id -> locations
  const record = (id, where) => seen.set(String(id), [...(seen.get(String(id)) ?? []), where]);
  const scan = (scope, path, label) => {
    for (const rl of scope?.ratelimits ?? []) record(rl.namespace_id, `${path} ${label} ${rl.name}`);
  };
  for (const [path, config] of Object.entries(files)) {
    scan(config, path, 'top-level');
    for (const [env, scope] of Object.entries(config.env ?? {})) scan(scope, path, `env.${env}`);
  }
  return [...seen]
    .filter(([, where]) => where.length > 1)
    .map(([id, where]) => `namespace_id ${id} is shared by: ${where.join('; ')}`);
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = checkRateLimitNamespaces(loadAllConfigs(root));
  for (const line of problems) console.log(`FAIL: ${line}`);
  if (problems.length === 0) console.log('ok: every rate-limit namespace_id is unique');
  process.exit(problems.length > 0 ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
