#!/usr/bin/env node
// Generates the IT manual's Appendix A: one Markdown page per Worker in .github/workers.json,
// summarising what its wrangler*.jsonc configures in production (top level) and the sandbox
// (env.sandbox). Generated, never edited by hand, so these facts can't drift from the configs.
//
//   node scripts/manual-reference.mjs                 writes docs/manual/reference/<dir>.md
//   node scripts/manual-reference.mjs --out <dir>     ...somewhere else
//   node scripts/manual-reference.mjs --check         parses every config, writes nothing
//
// Secrets are not in Wrangler config; each Worker's chapter lists them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IN_SCOPE, configFiles, stripJsonc } from './check-worker-flags.mjs';

// Unique Worker directories from .github/workers.json, in roster order (member-portal is listed
// twice, once per config).
export function rosterDirs(workersJson) {
  return [...new Set(workersJson.map((entry) => entry.dir))];
}

const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
const orNull = (value) => (value === undefined ? null : value);

function routeText(route) {
  if (typeof route === 'string') return route;
  return route.custom_domain ? `${route.pattern} (custom domain)` : route.pattern;
}

// Short, non-secret scalars worth showing by value; every other var is listed by name.
const SHOWN_VARS = new Set(['ENVIRONMENT']);

// The infrastructure one Wrangler scope (top level or env.sandbox) declares. Absent fields are
// [] or null, never undefined.
export function summarizeEnv(cfg) {
  return {
    name: orNull(cfg.name),
    main: orNull(cfg.main),
    compatibilityDate: orNull(cfg.compatibility_date),
    cpuMs: orNull(cfg.limits?.cpu_ms),
    routes: [...list(cfg.routes), ...list(cfg.route)].map(routeText),
    workersDev: orNull(cfg.workers_dev),
    previewUrls: orNull(cfg.preview_urls),
    crons: list(cfg.triggers?.crons),
    producers: list(cfg.queues?.producers).map((p) => ({ queue: p.queue, binding: p.binding })),
    consumers: list(cfg.queues?.consumers).map((c) => ({
      queue: c.queue,
      maxRetries: orNull(c.max_retries),
      retryDelay: orNull(c.retry_delay),
      maxConcurrency: orNull(c.max_concurrency),
      maxBatchSize: orNull(c.max_batch_size),
      dlq: orNull(c.dead_letter_queue),
    })),
    d1: list(cfg.d1_databases).map((d) => ({ binding: d.binding, name: d.database_name })),
    kv: list(cfg.kv_namespaces).map((k) => ({ binding: k.binding, id: k.id })),
    r2: list(cfg.r2_buckets).map((r) => ({ binding: r.binding, bucket: r.bucket_name })),
    services: list(cfg.services).map((s) => ({ binding: s.binding, service: s.service, entrypoint: orNull(s.entrypoint) })),
    workflows: list(cfg.workflows).map((w) => ({ binding: w.binding, name: w.name })),
    analytics: list(cfg.analytics_engine_datasets).map((a) => ({ binding: a.binding, dataset: orNull(a.dataset) })),
    assets: cfg.assets ? { binding: orNull(cfg.assets.binding), directory: orNull(cfg.assets.directory) } : null,
    sendEmail: list(cfg.send_email).map((e) => ({ name: e.name, allowed: list(e.allowed_destination_addresses ?? e.destination_address) })),
    rateLimits: list(cfg.ratelimits).map((r) => ({
      name: r.name,
      namespaceId: r.namespace_id,
      limit: orNull(r.simple?.limit),
      period: orNull(r.simple?.period),
    })),
    vars: Object.entries(cfg.vars ?? {}).map(([k, v]) => (SHOWN_VARS.has(k) ? `${k}=${v}` : k)),
    observability: cfg.observability?.enabled === true,
  };
}

// Keys a Wrangler environment inherits from the top level unless it sets them itself. Bindings
// (vars, D1, KV, queues, services, …) are not inherited.
const INHERITED = ['main', 'compatibility_date', 'workers_dev', 'preview_urls', 'routes', 'route', 'triggers', 'limits', 'observability', 'assets'];

// env.sandbox as Wrangler resolves it (null when there is none): inheritable keys fall back to
// the top level, and the name defaults to `<name>-sandbox`.
export function sandboxConfig(cfg) {
  const env = cfg.env?.sandbox;
  if (!env) return null;
  const resolved = { ...env };
  for (const key of INHERITED) if (!(key in env) && key in cfg) resolved[key] = cfg[key];
  if (!('name' in env) && cfg.name) resolved.name = `${cfg.name}-sandbox`;
  return resolved;
}

// Parsed configs for one Worker directory: [{ file, production, sandbox|null }].
export function loadWorker(dir, root) {
  if (!existsSync(join(root, dir, 'wrangler.jsonc'))) return [];
  return configFiles(dir, (p) => existsSync(join(root, p))).map((file) => {
    let cfg;
    try {
      cfg = JSON.parse(stripJsonc(readFileSync(join(root, file), 'utf8')));
    } catch (err) {
      throw new Error(`${file}: ${err.message}`);
    }
    const sandbox = sandboxConfig(cfg);
    return { file, production: summarizeEnv(cfg), sandbox: sandbox ? summarizeEnv(sandbox) : null };
  });
}

const code = (s) => `\`${s}\``;
const cell = (items) => (items.length ? items.join('<br>') : '—');
const scalar = (v) => (v === null ? '—' : code(v));

// Table rows: [label, (summary) => cell text].
const ROWS = [
  ['Worker name', (s) => scalar(s.name)],
  ['Entry point', (s) => scalar(s.main)],
  ['Compatibility date', (s) => scalar(s.compatibilityDate)],
  ['CPU limit (ms)', (s) => scalar(s.cpuMs)],
  ['Routes', (s) => cell(s.routes.map(code))],
  ['workers.dev / preview URLs', (s) => `${scalar(s.workersDev)} / ${scalar(s.previewUrls)}`],
  ['Cron triggers', (s) => cell(s.crons.map(code))],
  ['Queue producers', (s) => cell(s.producers.map((p) => `${code(p.binding)} → ${code(p.queue)}`))],
  ['Queue consumers', (s) => cell(s.consumers.map((c) => {
    const opts = [
      c.maxRetries !== null && `retries ${c.maxRetries}`,
      c.retryDelay !== null && `delay ${c.retryDelay}s`,
      c.maxConcurrency !== null && `concurrency ${c.maxConcurrency}`,
      c.maxBatchSize !== null && `batch ${c.maxBatchSize}`,
      c.dlq !== null && `DLQ ${code(c.dlq)}`,
    ].filter(Boolean);
    return `${code(c.queue)}${opts.length ? ` (${opts.join(', ')})` : ''}`;
  }))],
  ['D1 databases', (s) => cell(s.d1.map((d) => `${code(d.binding)} → ${code(d.name)}`))],
  ['KV namespaces', (s) => cell(s.kv.map((k) => `${code(k.binding)} → ${code(k.id)}`))],
  ['R2 buckets', (s) => cell(s.r2.map((r) => `${code(r.binding)} → ${code(r.bucket)}`))],
  ['Service bindings', (s) => cell(s.services.map((b) => `${code(b.binding)} → ${code(b.service)}${b.entrypoint ? ` (${code(b.entrypoint)})` : ''}`))],
  ['Workflows', (s) => cell(s.workflows.map((w) => `${code(w.binding)} → ${code(w.name)}`))],
  ['Analytics Engine', (s) => cell(s.analytics.map((a) => `${code(a.binding)}${a.dataset ? ` → ${code(a.dataset)}` : ''}`))],
  ['Static assets', (s) => (s.assets ? `${scalar(s.assets.directory)}${s.assets.binding ? ` (binding ${code(s.assets.binding)})` : ''}` : '—')],
  ['Send email', (s) => cell(s.sendEmail.map((e) => `${code(e.name)}${e.allowed.length ? ` (to ${e.allowed.map(code).join(', ')})` : ''}`))],
  ['Rate limiters', (s) => cell(s.rateLimits.map((r) => `${code(r.name)} ns ${code(r.namespaceId)}${r.limit !== null ? ` (${r.limit}/${r.period}s per key)` : ''}`))],
  ['Vars', (s) => cell(s.vars.map(code))],
  ['Observability', (s) => (s.observability ? 'on' : 'off')],
];

// One Worker's Appendix A page.
export function renderWorker(dir, configs, inScope) {
  const out = [`# ${dir} {#ref-${dir}}`, ''];
  if (configs.length === 0) {
    out.push('Local CLI, no Wrangler configuration. It runs on an operator\'s machine; see its chapter.', '');
    return out.join('\n');
  }
  if (inScope) out.push(`Write switch key: ${code(`${dir}:writes`)} (namespace \`FLAGS\` in production, \`sandbox-FLAGS\` in the sandbox).`, '');
  else out.push('No write switch.', '');
  for (const { file, production, sandbox } of configs) {
    out.push(`## ${code(file)}`, '', '| | Production | Sandbox |', '|---|---|---|');
    for (const [label, fn] of ROWS) out.push(`| ${label} | ${fn(production)} | ${sandbox ? fn(sandbox) : '—'} |`);
    out.push('');
  }
  return out.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const outIdx = args.indexOf('--out');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : join(root, 'docs/manual/reference');
  const roster = rosterDirs(JSON.parse(readFileSync(join(root, '.github/workers.json'), 'utf8')));
  let failed = false;
  if (!check) mkdirSync(outDir, { recursive: true });
  for (const dir of roster) {
    try {
      const md = renderWorker(dir, loadWorker(dir, root), IN_SCOPE.includes(dir));
      if (!check) writeFileSync(join(outDir, `${dir}.md`), md);
    } catch (err) {
      console.error(err.message);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(check ? `manual-reference: ${roster.length} Workers parse` : `manual-reference: wrote ${roster.length} pages to ${outDir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
