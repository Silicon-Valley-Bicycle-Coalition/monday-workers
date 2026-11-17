#!/usr/bin/env node
// Rewrites bare GitLab issue/MR references (`#58`, `!299`) and full GitLab issue/MR URLs into
// explicit, repo-qualified references, so they stay meaningful after the move to GitHub (where
// `#58` would point at a different issue). Markdown gets `[GL#58](url)`; code (and markdown inline code) gets `GL#58`.
//
//   node scripts/rewrite-gitlab-refs.mjs --project <gitlab path> [--write] [paths…]
//
// Default is a dry run printing `file:line  from → to`; `--write` applies. With no paths it walks
// `git ls-files` filtered to the extensions below.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = new Set(['.md', '.ts', '.mjs', '.js', '.jsonc', '.json', '.yml', '.yaml', '.html', '.sh']);
const CSS_COLOUR = /:\s*#[0-9a-fA-F]{3,8}\b/;
const LINK = /\[[^\]]*\]\([^)]*\)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const FENCE = /^\s*(```|~~~)/;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Returns { text, changes } where each change is { index, from, to } and `index` is the offset of
// `from` in the original `text`.
export function rewriteRefs(text, { project, kind }) {
  const markdown = kind === 'markdown';
  const baseUrl = `https://gitlab.com/${project}/-`;
  // Alternation: a full URL, or a bare ref after start/whitespace/( [ , ; : with 1-4 digits that
  // is not followed by a word character (and, for `!`, not by `=`, checked below).
  const pattern = new RegExp(
    `${escapeRegex(baseUrl)}/(issues|merge_requests)/(\\d+)\\b` +
      `|(^|[\\s(\\[,;:])([#!])(\\d{1,4})(?!\\w)`,
    'g',
  );
  const changes = [];
  let inFence = false;
  let lineStart = 0;
  const out = [];

  for (const line of text.split('\n')) {
    let result = line;
    if (markdown && FENCE.test(line)) {
      inFence = !inFence;
    } else if (!(markdown && inFence) && !CSS_COLOUR.test(line)) {
      const links = markdown ? [...line.matchAll(LINK)].map((m) => [m.index, m.index + m[0].length]) : [];
      const inLink = (i) => links.some(([a, b]) => i >= a && i < b);
      // A link inside an inline code span would render as raw text, so those get the plain label.
      const spans = markdown ? [...line.matchAll(INLINE_CODE)].map((m) => [m.index, m.index + m[0].length]) : [];
      const inCode = (i) => spans.some(([a, b]) => i >= a && i < b);
      let pos = 0;
      result = '';
      for (const m of line.matchAll(pattern)) {
        const isUrl = m[1] !== undefined;
        const start = m.index + (isUrl ? 0 : m[3].length);
        const from = isUrl ? m[0] : m[4] + m[5];
        if (inLink(start)) continue;
        if (!isUrl && m[4] === '!' && line[start + from.length] === '=') continue;
        const isMr = isUrl ? m[1] === 'merge_requests' : m[4] === '!';
        const number = isUrl ? m[2] : m[5];
        const label = `GL${isMr ? '!' : '#'}${number}`;
        const url = `${baseUrl}/${isMr ? 'merge_requests' : 'issues'}/${number}`;
        const to = markdown && !inCode(start) ? `[${label}](${url})` : label;
        changes.push({ index: lineStart + start, from, to });
        result += line.slice(pos, start) + to;
        pos = start + from.length;
      }
      result += line.slice(pos);
    }
    out.push(result);
    lineStart += line.length + 1;
  }
  return { text: out.join('\n'), changes };
}

function parseArgs(argv) {
  const args = { project: null, write: false, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') args.project = argv[++i];
    else if (argv[i] === '--write') args.write = true;
    else args.paths.push(argv[i]);
  }
  return args;
}

function main() {
  const { project, write, paths } = parseArgs(process.argv.slice(2));
  if (!project) {
    console.error('usage: rewrite-gitlab-refs.mjs --project <gitlab path> [--write] [paths…]');
    process.exit(2);
  }
  const files = paths.length > 0
    ? paths
    : execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n')
        .filter((f) => EXTENSIONS.has(extname(f)));
  let total = 0;
  for (const file of files) {
    const original = readFileSync(file, 'utf8');
    const { text, changes } = rewriteRefs(original, {
      project,
      kind: extname(file) === '.md' ? 'markdown' : 'code',
    });
    for (const c of changes) {
      const line = original.slice(0, c.index).split('\n').length;
      console.log(`${file}:${line}  ${c.from} → ${c.to}`);
    }
    total += changes.length;
    if (write && changes.length > 0) writeFileSync(file, text);
  }
  console.log(`${total} change(s) in ${files.length} file(s)${write ? ' (written)' : ' (dry run)'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
