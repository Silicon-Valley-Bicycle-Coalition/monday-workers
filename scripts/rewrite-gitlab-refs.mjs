#!/usr/bin/env node
// Rewrites bare GitLab issue/MR references (`#58`, `!299`) and full GitLab issue/MR URLs into
// explicit, repo-qualified references, so they stay meaningful after the move to GitHub (where
// `#58` would point at a different issue). Markdown gets `[GL#58](url)`; code (and markdown inline code) gets `GL#58`.
// In code files only comments are rewritten (`//`, `/* */` lines, `#` lines in YAML/shell, HTML
// comments), never string literals, which tests and runtime output may depend on. `kind: 'plain'`
// rewrites the whole text without links (issue titles).
//
//   node scripts/rewrite-gitlab-refs.mjs --project <gitlab path> --max-issue N --max-mr N [--write] [paths…]
//
// --max-issue/--max-mr are the highest real issue / MR numbers; larger or zero-padded numbers
// (`#888`, `#000`: colours, not references) are left alone.
//
// Default is a dry run printing `file:line  …context[from] → to`; `--write` applies. With no paths
// it walks `git ls-files` filtered to the extensions below, minus the migration scripts themselves.
// A ref right after a doc-local numbering word ("gotcha #1", "email #2") is left alone.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = new Set(['.md', '.ts', '.mjs', '.js', '.jsonc', '.json', '.yml', '.yaml', '.html', '.sh']);
const LINK = /\[[^\]]*\]\([^)]*\)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const FENCE = /^\s*(`{3,}|~{3,})/;
// "gotcha #1" / "welcome email #2" number things inside a document, not GitLab issues.
const NUMBERING_WORD = /(?<![A-Za-z])(?:gotcha|email|step|item|point|phase|option|part|round|rule|row)s?\s+$/i;
const SKIPPED_FILES = new Set([
  'scripts/rewrite-gitlab-refs.mjs',
  'scripts/rewrite-gitlab-refs.test.mjs',
  'scripts/copy-gitlab-issues.mjs',
  'scripts/copy-gitlab-issues.test.mjs',
]);
const HASH_COMMENT_EXTENSIONS = new Set(['.yml', '.yaml', '.sh']);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A `#NNN` after `:` is a CSS colour when the line looks like CSS: it ends in `;` or sits in a
// rule with `{`. (A hex token with letters a-f never matches the digits-only pattern anyway.)
function isCssColour(line, start, end) {
  return /:\s*$/.test(line.slice(0, start)) && (line[end] === ';' || line.includes('{'));
}

// Offset in `line` where a comment begins (Infinity when the line has none). Text before it is
// code, where a `#58` may sit in a string literal.
function commentStart(line, ext) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return 0;
  const hashFile = HASH_COMMENT_EXTENSIONS.has(ext);
  if (trimmed.startsWith('# ') || (hashFile && trimmed.startsWith('#'))) return 0;
  const candidates = [];
  // `//` that does not follow `:`, which would make it the scheme separator of a URL.
  const slashes = /(?<!:)\/\//.exec(line);
  if (slashes) candidates.push(slashes.index);
  if (hashFile) {
    const hash = /\s#\s/.exec(line);
    if (hash) candidates.push(hash.index + 1);
  }
  if (ext === '.html') {
    const html = line.indexOf('<!--');
    if (html !== -1) candidates.push(html);
  }
  return candidates.length > 0 ? Math.min(...candidates) : Infinity;
}

// A one-line ```code``` is an inline span, not a fence opener (backtick fences have no backticks
// in their info string).
export function opensFence(line, marker) {
  return !(marker[0] === '`' && line.slice(line.indexOf(marker) + marker.length).includes('`'));
}

export function selectFiles(files) {
  return files.filter((f) => EXTENSIONS.has(extname(f)) && !SKIPPED_FILES.has(f));
}

// `file:line  …<up to 30 chars before>[from] → to`
export function formatChange(file, original, change) {
  const line = original.slice(0, change.index).split('\n').length;
  const lineBegin = original.lastIndexOf('\n', change.index - 1) + 1;
  const before = original.slice(Math.max(lineBegin, change.index - 30), change.index);
  return `${file}:${line}  …${before}[${change.from}] → ${change.to}`;
}

// Returns { text, changes } where each change is { index, from, to } and `index` is the offset of
// `from` in the original `text`.
export function rewriteRefs(text, { project, kind, ext = '', maxIssue = Infinity, maxMr = Infinity }) {
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
    if (marker && !fence && opensFence(line, marker)) {
      fence = marker;
    } else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = null;
    } else if (!(markdown && fence)) {
      const links = markdown ? [...line.matchAll(LINK)].map((m) => [m.index, m.index + m[0].length]) : [];
      const inLink = (i) => links.some(([a, b]) => i >= a && i < b);
      // A link inside an inline code span would render as raw text, so those get the plain label.
      const spans = markdown ? [...line.matchAll(INLINE_CODE)].map((m) => [m.index, m.index + m[0].length]) : [];
      const inCode = (i) => spans.some(([a, b]) => i >= a && i < b);
      const comment = kind === 'code' ? commentStart(line, ext) : 0;
      let pos = 0;
      result = '';
      for (const m of line.matchAll(pattern)) {
        const isUrl = m[1] !== undefined;
        const start = m.index + (isUrl ? 0 : m[3].length);
        const from = isUrl ? m[0] : m[4] + m[5];
        if (inLink(start) || start < comment) continue;
        if (!isUrl && NUMBERING_WORD.test(line.slice(0, start))) continue;
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
    : selectFiles(execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n'));
  let total = 0;
  for (const file of files) {
    const original = readFileSync(file, 'utf8');
    const { text, changes } = rewriteRefs(original, {
      project,
      maxIssue,
      maxMr,
      kind: extname(file) === '.md' ? 'markdown' : 'code',
      ext: extname(file),
    });
    for (const c of changes) console.log(formatChange(file, original, c));
    total += changes.length;
    if (write && changes.length > 0) writeFileSync(file, text);
  }
  console.log(`${total} change(s) in ${files.length} file(s)${write ? ' (written)' : ' (dry run)'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
