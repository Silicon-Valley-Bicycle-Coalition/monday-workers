#!/usr/bin/env node
// CI check for the IT manual (docs/manual/):
//   - every Worker in .github/workers.json has docs/manual/workers/<dir>.md, and no chapter is an orphan;
//   - each Worker chapter carries the nine template headings, in order;
//   - every relative link in docs/manual/**/*.md resolves to a file or directory in the repo;
//   - every roster Worker's Wrangler config parses (the generated Appendix A depends on it).
// It doesn't build the PDF (that needs pandoc and Chrome; see scripts/build-manual.mjs).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorker, rosterDirs } from './manual-reference.mjs';

export const WORKER_HEADINGS = [
  'What it does',
  'Trigger and data flow',
  'Monday boards and columns',
  'Secrets',
  'Write switch',
  'Failure modes',
  'Operator scripts',
  'Changing it',
  'Further reading',
];

// Markdown with fenced code blocks blanked out (line count kept, so nothing else shifts).
export function withoutFences(markdown) {
  let inFence = false;
  return markdown.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return '';
    }
    return inFence ? '' : line;
  }).join('\n');
}

export function checkCoverage(roster, chapterFiles) {
  const errors = [];
  const chapters = new Set(chapterFiles);
  for (const dir of roster) {
    if (!chapters.has(`${dir}.md`)) errors.push(`docs/manual/workers/${dir}.md is missing (${dir} is in .github/workers.json)`);
  }
  const known = new Set(roster.map((dir) => `${dir}.md`));
  for (const file of chapterFiles) {
    if (!known.has(file)) errors.push(`docs/manual/workers/${file} has no matching dir in .github/workers.json`);
  }
  return errors;
}

export function checkHeadings(file, text) {
  const found = withoutFences(text).split('\n')
    .map((line) => line.match(/^## (.+?)\s*$/)?.[1])
    .filter((h) => h && WORKER_HEADINGS.includes(h));
  const errors = WORKER_HEADINGS.filter((h) => !found.includes(h)).map((h) => `${file}: missing heading "## ${h}"`);
  const order = found.filter((h, i) => found.indexOf(h) === i);
  const expected = WORKER_HEADINGS.filter((h) => order.includes(h));
  if (errors.length === 0 && order.join('|') !== expected.join('|')) {
    errors.push(`${file}: headings out of order; expected ${WORKER_HEADINGS.join(', ')}`);
  }
  return errors;
}

// Relative link and image targets outside code, without http(s):, mailto: or #anchor-only links.
export function extractLinks(markdown) {
  const text = withoutFences(markdown).replace(/`[^`\n]*`/g, '');
  const targets = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    targets.push(target);
  }
  return targets;
}

// Errors for links in `file` (repo-relative) whose path part doesn't exist. `exists` takes a
// repo-relative path with no trailing slash.
export function checkLinks(file, text, exists) {
  const errors = [];
  for (const target of extractLinks(text)) {
    const path = decodeURI(target.split('#')[0]);
    if (!path) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file), path)).replace(/\/$/, '');
    if (resolved.startsWith('..') || !exists(resolved)) errors.push(`${file}: broken link ${target}`);
  }
  return errors;
}

function markdownFiles(dir, root) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'reference') out.push(...markdownFiles(full, root));
    } else if (entry.name.endsWith('.md')) {
      out.push(relative(root, full).split('\\').join('/'));
    }
  }
  return out;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const roster = rosterDirs(JSON.parse(readFileSync(join(root, '.github/workers.json'), 'utf8')));
  const errors = [];

  for (const dir of roster) {
    try {
      loadWorker(dir, root);
    } catch (err) {
      errors.push(err.message);
    }
  }

  const workersDir = join(root, 'docs/manual/workers');
  const chapterFiles = existsSync(workersDir) ? readdirSync(workersDir).filter((f) => f.endsWith('.md')) : [];
  errors.push(...checkCoverage(roster, chapterFiles));
  for (const f of chapterFiles) {
    errors.push(...checkHeadings(`docs/manual/workers/${f}`, readFileSync(join(workersDir, f), 'utf8')));
  }

  // Appendix A pages are generated (gitignored), so a link to one counts when its Worker is on the roster.
  const generated = new Set(roster.map((dir) => `docs/manual/reference/${dir}.md`));
  const exists = (p) => generated.has(p) || existsSync(join(root, normalize(p)));
  for (const file of markdownFiles(join(root, 'docs/manual'), root)) {
    errors.push(...checkLinks(file, readFileSync(join(root, file), 'utf8'), exists));
  }

  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(`manual: ${errors.length} problem(s)`);
    process.exit(1);
  }
  console.log('manual: ok');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
