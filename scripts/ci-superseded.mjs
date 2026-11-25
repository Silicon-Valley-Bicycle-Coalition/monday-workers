#!/usr/bin/env node
// Answers whether a sandbox deploy of this commit would put old code back: true when `main` has
// since changed the same Worker (its directory or `extraPaths` in `.github/workers.json`). The
// newer commit's own run deploys it. Without this, a slow run, or a re-run of an old one, can
// finish last and roll the sandbox back.
//
//   node scripts/ci-superseded.mjs --dir <worker> [--head HEAD] [--main origin/main]
//
// Writes `superseded=true|false` to $GITHUB_OUTPUT (stdout when unset). Exits 1 if it can't compare
// the two commits: answering "superseded" then would skip a deploy that no run makes.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedFiles, changedWorkers, optionValue } from './ci-changed-workers.mjs';

// files: paths that differ between this commit and `main`, or null when they couldn't be compared.
export function isSuperseded(files, workers, dir) {
  if (files === null) throw new Error("can't compare this commit with main");
  if (!workers.some((w) => w.dir === dir)) throw new Error(`${dir} is not in .github/workers.json`);
  return changedWorkers(files, workers, []).test.some((w) => w.dir === dir);
}

export function supersededBy({ dir, head, main, workers, cwd }) {
  return isSuperseded(changedFiles(head, main, false, cwd), workers, dir);
}

function run(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const workers = JSON.parse(readFileSync(join(root, '.github/workers.json'), 'utf8'));
  const superseded = supersededBy({
    dir: optionValue(argv, '--dir', ''),
    head: optionValue(argv, '--head', 'HEAD'),
    main: optionValue(argv, '--main', 'origin/main'),
    workers,
    cwd: root,
  });
  const out = `superseded=${superseded}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
  else process.stdout.write(out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run(process.argv.slice(2));
