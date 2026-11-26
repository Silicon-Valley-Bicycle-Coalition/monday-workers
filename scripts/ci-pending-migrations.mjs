#!/usr/bin/env node
// Refuses a production deploy while one of the Worker's D1 databases has migrations the repo holds
// but the remote database hasn't applied. Code that expects a new table or column fails at runtime
// against the old schema, and applying a migration stays a human step (docs/manual/06-ci-and-deploy.md,
// "Deploying a Worker by hand"). Read-only: one SELECT on each database's migrations table, so the
// deploy token needs D1 Read, not Edit.
//
//   cd <worker> && node ../scripts/ci-pending-migrations.mjs [--config wrangler.jsonc]
//
// Checks each top-level (production) `d1_databases` entry whose migrations directory exists
// (`migrations_dir`, default `migrations`, as wrangler does). Exits 1, naming each pending file and
// the command to apply it, when anything is pending or a database can't be read.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsonc } from './check-worker-flags.mjs';
import { optionValue } from './ci-changed-workers.mjs';

// The databases worth checking: { binding, name, dir, table } for each top-level D1 entry.
export function migrationTargets(config) {
  return (config.d1_databases ?? []).map((d) => ({
    binding: d.binding,
    name: d.database_name,
    dir: d.migrations_dir ?? 'migrations',
    table: d.migrations_table ?? 'd1_migrations',
  }));
}

// local: migration file names in the repo; applied: names in the remote table.
export function pending(local, applied) {
  const done = new Set(applied);
  return local.filter((f) => !done.has(f)).sort();
}

// `wrangler d1 execute --json` prints [{ results: [...], success }]. Returns the `name` column.
export function appliedNames(stdout) {
  const parsed = JSON.parse(stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first?.success) throw new Error(`query failed: ${stdout.slice(0, 500)}`);
  return (first.results ?? []).map((r) => r.name);
}

const SAFE = /^[A-Za-z0-9_]+$/;

const defaultExec = (args) =>
  execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Returns { problems: string[] }. exec is injectable for tests: (args) => stdout.
export function check({ cwd, configPath, exec = defaultExec }) {
  const config = JSON.parse(stripJsonc(readFileSync(join(cwd, configPath), 'utf8')));
  const problems = [];
  for (const t of migrationTargets(config)) {
    const dir = join(cwd, t.dir);
    if (!existsSync(dir)) continue;
    const local = readdirSync(dir).filter((f) => f.endsWith('.sql'));
    if (!local.length) continue;
    if (!SAFE.test(t.table)) {
      problems.push(`${t.name}: migrations_table ${JSON.stringify(t.table)} isn't a plain identifier`);
      continue;
    }
    let applied;
    try {
      applied = appliedNames(
        exec(['d1', 'execute', t.binding, '--remote', '--json', '-c', configPath, '--command', `SELECT name FROM ${t.table}`]),
      );
    } catch (err) {
      problems.push(`${t.name}: couldn't read ${t.table} (${String(err.message ?? err).split('\n')[0]})`);
      continue;
    }
    for (const f of pending(local, applied)) problems.push(`${t.name}: ${t.dir}/${f} is not applied`);
  }
  return { problems };
}

function main(argv) {
  const configPath = optionValue(argv, '--config', 'wrangler.jsonc');
  const { problems } = check({ cwd: process.cwd(), configPath });
  if (!problems.length) {
    console.log('No pending D1 migrations.');
    return 0;
  }
  const apply = `npx wrangler d1 migrations apply <database> --remote${configPath === 'wrangler.jsonc' ? '' : ` -c ${configPath}`}`;
  for (const p of problems) console.log(`::error::${p}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '### Not deployed to production: D1 migrations pending',
        '',
        ...problems.map((p) => `- ${p}`),
        '',
        `Apply them by hand from this Worker's directory (\`${apply}\`), then re-run this job.`,
        '',
      ].join('\n'),
    );
  }
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
