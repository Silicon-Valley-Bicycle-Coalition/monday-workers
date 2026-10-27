#!/usr/bin/env node
// Blocks logging email addresses (see the root README, "Error monitoring: Workers Issues"):
// Workers Issues forwards the logs around a failure to automation targets such as a coding
// agent, so no console.* call may pass anything that looks like an address.
//
// A lint rule in spirit, but not ESLint: typescript-eslint doesn't support the TypeScript 7 these
// Workers build with, and there's no root package.json to hang one shared config off. This is a
// dependency-free scan instead, run in CI (`log-safety` job) over every Worker's src/.
//
// It flags, inside the arguments of console.{log,info,warn,error,debug,trace}(...), any
// identifier whose name contains "email" or "recipient", and any `.to`/`.cc`/`.bcc` property,
// unless it sits inside a call to one of the ALLOWED_WRAPPERS, is only read for `.length`, or is
// an object key.
// String and template-literal *text* is ignored ("no email on file" is fine); template `${…}`
// expressions are checked. It cannot see through indirection (a variable holding an object with
// an address in it), so it's a backstop for the obvious case, not a proof.
//
// Suppress a deliberate case with `// log-safety: allow — <reason>` on the line before the call.
//
//   node scripts/check-log-safety.mjs [dir ...]   # defaults to every Worker's src/
//   node scripts/check-log-safety.mjs --staged    # staged changes only (.githooks/pre-commit)

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_WRAPPERS = ['memberId', 'redactEmails', 'errorText', 'redactPayload'];
const SUPPRESS = /\/\/\s*log-safety:\s*allow\b/;
const CONSOLE_CALL = /\bconsole\s*\.\s*(?:log|info|warn|error|debug|trace)\s*\(/g;
const EMAILISH_IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const EMAILISH_NAME = /email|recipient/i;
const ADDRESS_PROPERTY = /\.\s*(?:to|cc|bcc)\b(?!\s*\()/g;

// Returns `source` with comment text and string/template/regex literal text replaced by spaces
// (newlines kept, so offsets and line numbers still line up). Template `${…}` expressions stay.
export function maskLiterals(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  // Stack of open contexts: 'code' or 'template'; each code frame counts its own braces so a
  // `}` closes the right `${`.
  const stack = [{ kind: 'code', depth: 0 }];
  let lastSignificant = '';
  let i = 0;
  while (i < source.length) {
    const frame = stack[stack.length - 1];
    const ch = source[i];
    if (frame.kind === 'template') {
      if (ch === '\\') { blank(i, i + 2); i += 2; continue; }
      if (ch === '`') { stack.pop(); lastSignificant = '`'; i++; continue; }
      if (ch === '$' && source[i + 1] === '{') { stack.push({ kind: 'code', depth: 0 }); lastSignificant = '{'; i += 2; continue; }
      blank(i, i + 1); i++; continue;
    }
    // code
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop); i = stop; continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop); i = stop; continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, j); i = j + 1; lastSignificant = ch; continue;
    }
    if (ch === '`') { stack.push({ kind: 'template' }); i++; continue; }
    if (ch === '/' && (lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant) || /\breturn\s*$/.test(source.slice(Math.max(0, i - 8), i)))) {
      // Regex literal: skip to the closing unescaped `/` outside a character class.
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n') {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
        j++;
      }
      blank(i + 1, j); i = j + 1; lastSignificant = '/'; continue;
    }
    if (ch === '{') frame.depth++;
    if (ch === '}') {
      if (frame.depth === 0 && stack.length > 1) { stack.pop(); lastSignificant = '}'; i++; continue; }
      frame.depth--;
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    i++;
  }
  return out.join('');
}

// Index of the `)` matching the `(` at `open`, in masked source (literals already blanked).
function matchingParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')' && --depth === 0) return i;
  }
  return masked.length;
}

function blankAllowedWrappers(span) {
  let result = span;
  const wrapper = new RegExp(`\\b(?:${ALLOWED_WRAPPERS.join('|')})\\s*\\(`, 'g');
  let match;
  while ((match = wrapper.exec(result)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(result, open);
    result = result.slice(0, match.index) + ' '.repeat(close + 1 - match.index) + result.slice(close + 1);
    wrapper.lastIndex = match.index;
  }
  return result;
}

// Finds console.* calls in one file's source. Returns [{ line, name }].
export function findViolations(source) {
  const masked = maskLiterals(source);
  const lines = source.split('\n');
  const lineOf = (offset) => source.slice(0, offset).split('\n').length;
  const violations = [];
  let call;
  CONSOLE_CALL.lastIndex = 0;
  while ((call = CONSOLE_CALL.exec(masked)) !== null) {
    const open = call.index + call[0].length - 1;
    const close = matchingParen(masked, open);
    const line = lineOf(call.index);
    if (SUPPRESS.test(lines[line - 1] ?? '') || SUPPRESS.test(lines[line - 2] ?? '')) continue;
    const args = blankAllowedWrappers(masked.slice(open + 1, close));
    const hits = new Set();
    let id;
    EMAILISH_IDENTIFIER.lastIndex = 0;
    while ((id = EMAILISH_IDENTIFIER.exec(args)) !== null) {
      if (!EMAILISH_NAME.test(id[0])) continue;
      const after = args.slice(id.index + id[0].length);
      if (/^\s*\.\s*length\b/.test(after)) continue;
      // An object key (`{ recipients: n }`) names a field; only its value is logged.
      if (/^\s*:/.test(after) && /[{,]\s*$/.test(args.slice(0, id.index))) continue;
      hits.add(id[0]);
    }
    let prop;
    ADDRESS_PROPERTY.lastIndex = 0;
    while ((prop = ADDRESS_PROPERTY.exec(args)) !== null) {
      if (/^\s*\.\s*length\b/.test(args.slice(prop.index + prop[0].length))) continue;
      hits.add(prop[0].replace(/\s/g, ''));
    }
    for (const name of hits) violations.push({ line, name });
  }
  return violations;
}

// Worker source this check covers: not tests, not declaration files, not node_modules.
export function isCheckedSource(path) {
  return /\.(?:ts|mts|js|mjs)$/.test(path) && !/\.test\.[mc]?[jt]s$/.test(path) && !path.endsWith('.d.ts') && !/(?:^|\/)node_modules\//.test(path);
}

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (isCheckedSource(path)) files.push(path);
  }
  return files;
}

// Staged Worker source as [{ path, source }], read from the index so a commit is checked as it
// will be recorded, not as the working tree happens to look.
function stagedFiles(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z')
    .split('\0')
    .filter((path) => /^[^/]+\/src\//.test(path) && isCheckedSource(path))
    .map((path) => ({ path, source: git('show', `:${path}`) }));
}

function workerSrcDirs(root) {
  return readdirSync(root)
    .map((entry) => join(root, entry, 'src'))
    .filter((dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const args = process.argv.slice(2);
  const files = args[0] === '--staged'
    ? stagedFiles(root)
    : (args.length > 0 ? args : workerSrcDirs(root)).flatMap(sourceFiles).map((file) => ({ path: relative(root, file), source: readFileSync(file, 'utf8') }));
  let count = 0;
  for (const { path, source } of files) {
    for (const { line, name } of findViolations(source)) {
      console.error(`${path}:${line}: console call logs \`${name}\`, which may hold an email address — log an id instead, or wrap it in ${ALLOWED_WRAPPERS.join('/')}()`);
      count++;
    }
  }
  if (count > 0) {
    console.error(`\n${count} possible email address(es) in logs. Suppress a deliberate one with \`// log-safety: allow — <reason>\` on the line above.`);
    process.exit(1);
  }
  if (args[0] !== '--staged') console.log('log-safety: no email addresses in console calls');
}
