#!/usr/bin/env node
// Decides which Workers CI tests and deploys to the sandbox, from the files a change touched.
// `.github/workers.json` is the roster (entries in deploy order); a Worker is affected when a
// changed file sits under its directory or matches one of its `extraPaths` (`prefix/**` or an
// exact path).
//
//   node scripts/ci-changed-workers.mjs --base <sha> --head <sha> [--merge-base]
//
// Writes `test=<json>` and `deploy=<json>` to $GITHUB_OUTPUT (stdout when unset) and exits 1 when a
// top-level directory with a package.json is missing from the roster, so a new Worker can't skip
// CI. A base that is all zeros or not in the clone means "everything changed". --merge-base diffs
// from the merge-base (`base...head`, for pull requests) instead of `base..head`.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const matches = (file, pattern) =>
  pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern;

const touches = (files, worker) =>
  files === null ||
  files.some((f) => f.startsWith(`${worker.dir}/`) || (worker.extraPaths ?? []).some((p) => matches(f, p)));

// files: changed paths, or null for "everything changed". test is deduplicated by dir (a Worker
// with two deploy entries is tested once); deploy keeps roster order and every sandbox entry.
export function changedWorkers(files, workers, allDirs) {
  const affected = workers.filter((w) => touches(files, w));
  const seen = new Set();
  const test = affected.filter((w) => !seen.has(w.dir) && seen.add(w.dir));
  const deploy = affected.filter((w) => w.sandbox);
  const listed = new Set(workers.map((w) => w.dir));
  return { test, deploy, unlisted: allDirs.filter((d) => !listed.has(d)) };
}

const ZERO = /^0+$/;

const defaultGit = (cwd) => (...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// `git` is injectable for tests: (...args) => stdout. --no-renames lists both the old and the new
// path of a moved file, so a Worker a file moved out of is still tested.
export function changedFiles(base, head, mergeBase, cwd, git = defaultGit(cwd)) {
  if (!base || ZERO.test(base)) return null;
  try {
    git('cat-file', '-e', `${base}^{commit}`);
    return git('diff', '--name-only', '--no-renames', `${base}${mergeBase ? '...' : '..'}${head}`).split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

export function optionValue(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const workers = JSON.parse(readFileSync(join(root, '.github/workers.json'), 'utf8'));
  const allDirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'package.json')))
    .map((e) => e.name)
    .sort();
  const files = changedFiles(optionValue(argv, '--base', ''), optionValue(argv, '--head', 'HEAD'), argv.includes('--merge-base'), root);
  const { test, deploy, unlisted } = changedWorkers(files, workers, allDirs);
  const out = `test=${JSON.stringify(test)}\ndeploy=${JSON.stringify(deploy)}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
  else process.stdout.write(out);
  if (unlisted.length) {
    console.error(`Not in .github/workers.json: ${unlisted.join(', ')}. Add each Worker so CI tests it.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
