#!/usr/bin/env node
// Rewrites bare GitLab issue/MR references (`#58`, `!299`) and full GitLab issue/MR URLs into
// explicit, repo-qualified references, so they stay meaningful after the move to GitHub (where
// `#58` would point at a different issue). Markdown gets `[GL#58](url)`; code (and markdown inline code) gets `GL#58`.
//
//   node scripts/rewrite-gitlab-refs.mjs --project <gitlab path> --max-issue N --max-mr N [--write] [paths…]
//
// --max-issue/--max-mr are the highest real issue / MR numbers; larger or zero-padded numbers
// (`#888`, `#000`: colours, not references) are left alone.
//
// Default is a dry run printing `file:line  from → to`; `--write` applies. With no paths it walks
// `git ls-files` filtered to the extensions below.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = new Set(['.md', '.ts', '.mjs', '.js', '.jsonc', '.json', '.yml', '.yaml', '.html', '.sh']);
const LINK = /\[[^\]]*\]\([^)]*\)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const FENCE = /^\s*(`{3,}|~{3,})/;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A `#NNN` after `:` is a CSS colour when the line looks like CSS: it ends in `;` or sits in a
// rule with `{`. (A hex token with letters a-f never matches the digits-only pattern anyway.)
function isCssColour(line, start, end) {
  return /:\s*$/.test(line.slice(0, start)) && (line[end] === ';' || line.includes('{'));
}

// Returns { text, changes } where each change is { index, from, to } and `index` is the offset of
// `from` in the original `text`.
export function rewriteRefs(text, { project, kind, maxIssue = Infinity, maxMr = Infinity }) {
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
  let fence = null; // opening marker while inside a fenced block
  let lineStart = 0;
  const out = [];

  for (const line of text.split('\n')) {
    let result = line;
    const marker = markdown ? FENCE.exec(line)?.[1] : null;
    if (marker && !fence) {
      fence = marker;
    } else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = null;
    } else if (!(markdown && fence)) {
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
        if (!isUrl && (number.startsWith('0') || Number(number) > (isMr ? maxMr : maxIssue))) continue;
        if (!isUrl && isCssColour(line, start, start + from.length)) continue;
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
  const args = { project: null, maxIssue: null, maxMr: null, write: false, paths: [] };
  const value = (i) => (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? null : argv[i + 1]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--write') args.write = true;
    else if (flag === '--project' || flag === '--max-issue' || flag === '--max-mr') {
      const v = value(i);
      if (v === null) return null;
      i++;
      if (flag === '--project') args.project = v;
      else if (!/^\d+$/.test(v)) return null;
      else args[flag === '--max-issue' ? 'maxIssue' : 'maxMr'] = Number(v);
    } else args.paths.push(flag);
  }
  return args.project && args.maxIssue !== null && args.maxMr !== null ? args : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: rewrite-gitlab-refs.mjs --project <gitlab path> --max-issue N --max-mr N [--write] [paths…]');
    process.exit(2);
  }
  const { project, maxIssue, maxMr, write, paths } = args;
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
      maxIssue,
      maxMr,
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
