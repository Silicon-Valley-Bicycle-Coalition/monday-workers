#!/usr/bin/env node
// Preview URLs default to on. A `wrangler versions upload`, or a non-main branch build, would put
// code that isn't on `main` on a public URL running with the production D1, queues, MONDAY_AUTH
// binding and secrets (#108). So every `*/wrangler*.jsonc` that defines `env.sandbox` must set
// `"preview_urls": false` at the top level and inside env.sandbox (Wrangler environments don't
// inherit it).
//
//   node scripts/check-preview-urls.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllConfigs } from './check-monday-auth-bindings.mjs';

// files: { [repo-relative path]: parsed config }. Returns one message per problem.
export function checkPreviewUrls(files) {
  const problems = [];
  for (const [path, config] of Object.entries(files)) {
    if (config.env?.sandbox === undefined) continue;
    if (config.preview_urls !== false) problems.push(`${path}: top-level "preview_urls" must be false`);
    if (config.env.sandbox.preview_urls !== false) problems.push(`${path}: env.sandbox "preview_urls" must be false`);
  }
  return problems;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = loadAllConfigs(root);
  const problems = checkPreviewUrls(files);
  for (const line of problems) console.log(`FAIL: ${line}`);
  if (problems.length === 0) console.log('ok: every Wrangler config with env.sandbox disables preview_urls in both scopes');
  process.exit(problems.length > 0 ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
