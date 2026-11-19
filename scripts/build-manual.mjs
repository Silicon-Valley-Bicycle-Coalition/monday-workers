#!/usr/bin/env node
// Builds the SVBC IT manual (docs/manual/) into one PDF for Box:
//   1. regenerates Appendix A (scripts/manual-reference.mjs),
//   2. concatenates the chapters in chapterOrder(), rewriting repo links to GitHub URLs pinned to
//      HEAD and links between chapters to in-document anchors,
//   3. pandoc → standalone HTML (design-system colours, self-hosted fonts as data URIs),
//   4. headless Chrome over the DevTools protocol → PDF with a footer and a bookmark outline.
//
//   node scripts/build-manual.mjs                 clean tree only; writes dist/svbc-it-manual-<date>-<sha>.pdf
//   node scripts/build-manual.mjs --allow-dirty   preview from uncommitted changes (stamped as such)
//   node scripts/build-manual.mjs --input <file.md> [--out <dir>]
//                                                 one Markdown file (e.g. the private appendix), same styling
//
// Needs pandoc and Chrome/Chromium (CHROME_PATH to override). No npm dependencies.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IN_SCOPE } from './check-worker-flags.mjs';
import { loadWorker, renderWorker, rosterDirs } from './manual-reference.mjs';

export const GITHUB_BASE = 'https://github.com/Silicon-Valley-Bicycle-Coalition/monday-workers';
const TITLE = 'SVBC Infrastructure Technical Manual';

const PART_I = ['00-about.md', '01-system-overview.md', '02-architecture.md', '03-accounts-and-access.md',
  '04-environments.md', '05-development.md', '06-ci-and-deploy.md', '07-operations.md'];
const PART_III = ['08-troubleshooting.md', '09-extending.md'];

// The PDF's order. File paths are relative to docs/manual/.
export function chapterOrder(workerFiles, referenceFiles) {
  return [
    { part: 'Part I. Foundations', files: PART_I },
    { part: 'Part II. The Workers', files: [...workerFiles].sort().map((f) => `workers/${f}`) },
    { part: 'Part III. Troubleshooting and extending', files: [...PART_III, 'glossary.md'] },
    { part: 'Appendix A. Generated infrastructure reference', files: [...referenceFiles].sort().map((f) => `reference/${f}`) },
  ];
}

// In-document id of a chapter's title heading.
export function chapterAnchor(file) {
  const stem = file.replace(/\.md$/, '');
  return stem.startsWith('reference/') ? `ref-${stem.slice('reference/'.length)}` : `ch-${stem.replaceAll('/', '-')}`;
}

// Gives the first level-1 heading (outside fenced code) the id `anchor`, unless it has an id already.
export function anchorFirstHeading(markdown, anchor) {
  let inFence = false;
  let done = false;
  return markdown.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (done || inFence || !/^# /.test(line)) return line;
    done = true;
    return /\{#[^}]+\}\s*$/.test(line) ? line : `${line.trimEnd()} {#${anchor}}`;
  }).join('\n');
}

// GitHub's heading slug: lowercase, drop everything but letters, digits, spaces, hyphens and
// underscores, then spaces to hyphens.
export function githubSlug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

// Gives every heading (outside fenced code) without an explicit id the id `<prefix>--<slug>`,
// numbering repeats within the chapter as GitHub does (-1, -2, …). Headings in different chapters
// then can't collide once the chapters are concatenated into one document.
export function addHeadingIds(markdown, prefix) {
  const seen = new Map();
  let inFence = false;
  return markdown.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{1,6}) (.+?)\s*$/);
    if (!m || /\{#[^}]+\}$/.test(m[2])) return line;
    const base = githubSlug(m[2]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${m[1]} ${m[2]} {#${prefix}--${n ? `${base}-${n}` : base}}`;
  }).join('\n');
}

const LINK = /\[([^\]]*)\]\(\s*<?([^)\s>]+)>?((?:\s+"[^"]*")?)\s*\)/g;
const CODE_SPAN = /`[^`\n]*`/g;
const PLACEHOLDER = /\u0000(\d+)\u0000/g;

// Rewrites relative links in a chapter (`fromFile`, relative to docs/manual/): links to other
// manual chapters become #anchors (a heading anchor gets that chapter's prefix, as addHeadingIds
// assigns), other repo paths become GitHub URLs at `sha` (blob/ for files, tree/ for
// directories), keeping any #anchor. URLs, images and code are untouched; link text may be code.
export function rewriteLinks(markdown, fromFile, { sha, manualFiles, isDir }) {
  const rewrite = (match, text, target, title, offset, whole) => {
    if (whole[offset - 1] === '!' || /^(https?:|mailto:)/.test(target)) return match;
    const [path, anchor] = target.split('#');
    if (!path) return `[${text}](#${chapterAnchor(fromFile)}--${anchor}${title})`;
    const inManual = posix.normalize(posix.join(posix.dirname(fromFile), path));
    if (manualFiles.has(inManual)) {
      return `[${text}](#${anchor ? `${chapterAnchor(inManual)}--${anchor}` : chapterAnchor(inManual)}${title})`;
    }
    const inRepo = posix.normalize(posix.join('docs/manual', posix.dirname(fromFile), path)).replace(/\/$/, '');
    if (inRepo.startsWith('..')) return match;
    const kind = isDir(inRepo) ? 'tree' : 'blob';
    return `[${text}](${GITHUB_BASE}/${kind}/${sha}/${inRepo}${anchor ? `#${anchor}` : ''}${title})`;
  };
  let inFence = false;
  return markdown.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    // Code spans become placeholders, so a link whose text is code still matches and code that
    // merely looks like a link is never rewritten.
    const spans = [];
    const masked = line.replace(CODE_SPAN, (span) => `\u0000${spans.push(span) - 1}\u0000`);
    return masked.replace(LINK, rewrite).replace(PLACEHOLDER, (_, i) => spans[Number(i)]);
  }).join('\n');
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChrome(env, exists) {
  if (env.CHROME_PATH) return exists(env.CHROME_PATH) ? env.CHROME_PATH : null;
  return CHROME_CANDIDATES.find((p) => exists(p)) ?? null;
}

export function fontFaceCss(fonts) {
  return fonts.map((f) => `@font-face {
  font-family: '${f.family}';
  font-style: normal;
  font-weight: ${f.weight};
  font-display: block;
  src: url(data:font/woff2;base64,${f.woff2Base64}) format('woff2');
  unicode-range: ${f.unicodeRange};
}`).join('\n');
}

// Design-system colours as :root custom properties, light theme (print is always light).
export function tokenCss(tokens) {
  const raw = new Map(tokens.color.tokens.map((t) => [t.name, t.value]));
  const light = (value, depth = 0) => {
    const v = typeof value === 'object' && value !== null ? value.light : value;
    const ref = typeof v === 'string' && v.match(/^\{(.+)\}$/);
    return ref && depth < 5 ? light(raw.get(ref[1]), depth + 1) : v;
  };
  const lines = [...raw.keys()].map((name) => `  --${name}: ${light(raw.get(name))};`);
  return `:root {\n${lines.join('\n')}\n}`;
}

// ── Side effects below ─────────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`build-manual: ${message}`);
  process.exit(1);
}

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) fail(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

async function headCss(root) {
  const { EMBEDDED_FONTS } = await import(pathToFileURL(join(root, 'member-portal/src/assets/fontData.ts')).href);
  const tokens = JSON.parse(readFileSync(join(root, 'docs/design-system/tokens.json'), 'utf8'));
  return `<style>\n${fontFaceCss(EMBEDDED_FONTS)}\n${tokenCss(tokens)}\n</style>\n`;
}

function runPandoc(markdownPath, htmlPath, headerPath, cssPath, resourcePath, meta) {
  const args = [
    markdownPath, '-f', 'gfm+attributes+raw_html', '-t', 'html5', '--standalone', '--embed-resources',
    `--resource-path=${resourcePath}`, '-H', headerPath, '-o', htmlPath,
    // An explicit --css also stops pandoc adding its default document CSS.
    `--css=${cssPath}`,
    ...Object.entries(meta).filter(([k]) => k !== 'toc').flatMap(([k, v]) => ['--metadata', `${k}=${v}`]),
  ];
  if (meta.toc) args.push('--toc', '--toc-depth=1');
  const r = spawnSync('pandoc', args, { encoding: 'utf8' });
  if (r.status !== 0) fail(`pandoc failed:\n${r.stderr}`);
}

// A minimal Chrome DevTools Protocol session over Node's built-in WebSocket.
function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
      else res(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
      listeners.delete(msg.method);
    }
  });
  return {
    ready: new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('could not connect to Chrome DevTools')), { once: true });
    }),
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((res, rej) => pending.set(id, { res, rej }));
    },
    once(method) {
      return new Promise((res) => listeners.set(method, [...(listeners.get(method) ?? []), res]));
    },
    close() { ws.close(); },
  };
}

async function printToPdf(chrome, htmlPath, pdfPath, stamp) {
  const profile = mkdtempSync(join(tmpdir(), 'svbc-manual-chrome-'));
  const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const port = await new Promise((res, rej) => {
      let buf = '';
      const timer = setTimeout(() => rej(new Error('Chrome did not start within 30 s')), 30_000);
      proc.stderr.on('data', (d) => {
        buf += d;
        const m = buf.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (m) { clearTimeout(timer); res(m[1]); }
      });
      proc.on('exit', (code) => { clearTimeout(timer); rej(new Error(`Chrome exited (${code}) before DevTools was ready`)); });
    });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('Chrome opened no page target');
    const cdp = cdpSession(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: pathToFileURL(htmlPath).href });
    await loaded;
    await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true });
    const small = 'font-family: Helvetica, Arial, sans-serif; font-size: 7.5pt; color: #666; width: 100%; padding: 0 0.75in;';
    const { data } = await cdp.send('Page.printToPDF', {
      paperWidth: 8.5,
      paperHeight: 11,
      marginTop: 0.75,
      marginBottom: 0.75,
      marginLeft: 0.75,
      marginRight: 0.75,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="${small}">${TITLE}</div>`,
      footerTemplate: `<div style="${small} display: flex; justify-content: space-between;"><span>${stamp}</span><span class="pageNumber"></span></div>`,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    });
    writeFileSync(pdfPath, Buffer.from(data, 'base64'));
    cdp.close();
  } finally {
    // Chrome keeps writing to its profile while it shuts down; remove it only once it has exited.
    const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((res) => proc.once('exit', res));
    proc.kill();
    await Promise.race([exited, new Promise((res) => setTimeout(res, 5_000))]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function checkTools() {
  if (spawnSync('pandoc', ['--version']).status !== 0) fail('pandoc not found; install it from https://pandoc.org/installing.html');
  const chrome = findChrome(process.env, existsSync);
  if (!chrome) fail('Chrome not found; install Google Chrome or set CHROME_PATH to a Chrome/Chromium binary');
  return chrome;
}

export function assembleManual(root, sha) {
  const manual = join(root, 'docs/manual');
  const roster = rosterDirs(JSON.parse(readFileSync(join(root, '.github/workers.json'), 'utf8')));
  const refDir = join(manual, 'reference');
  mkdirSync(refDir, { recursive: true });
  for (const dir of roster) writeFileSync(join(refDir, `${dir}.md`), renderWorker(dir, loadWorker(dir, root), IN_SCOPE.includes(dir)));

  const workerFiles = readdirSync(join(manual, 'workers')).filter((f) => f.endsWith('.md'));
  const parts = chapterOrder(workerFiles, roster.map((d) => `${d}.md`));
  const manualFiles = new Set(parts.flatMap((p) => p.files));
  const isDir = (p) => existsSync(join(root, p)) && statSync(join(root, p)).isDirectory();
  const out = [];
  for (const [i, { part, files }] of parts.entries()) {
    // A heading, so the part appears in the contents and the PDF bookmarks.
    out.push(`# ${part} {#part-${i + 1} .part-title}`, '');
    for (const file of files) {
      const path = join(manual, file);
      if (!existsSync(path)) fail(`chapter ${file} is in the build order but missing`);
      const text = addHeadingIds(anchorFirstHeading(readFileSync(path, 'utf8'), chapterAnchor(file)), chapterAnchor(file));
      out.push('<div class="chapter">', '', rewriteLinks(text, file, { sha, manualFiles, isDir }), '', '</div>', '');
    }
  }
  return out.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = resolve(opt('--out') ?? join(root, 'dist'));
  const input = opt('--input');
  const chrome = checkTools();
  const date = new Date().toISOString().slice(0, 10);
  const work = mkdtempSync(join(tmpdir(), 'svbc-manual-'));
  mkdirSync(outDir, { recursive: true });

  try {
    let markdown, meta, pdfName, resourcePath, stamp;
    if (input) {
      const text = readFileSync(resolve(input), 'utf8');
      const title = text.match(/^# (.+)$/m)?.[1] ?? basename(input, '.md');
      markdown = text.replace(/^# .+$/m, '');
      meta = { title, date: `Built ${date}`, 'pagetitle': title };
      pdfName = `${basename(input, '.md')}-${date}.pdf`;
      resourcePath = dirname(resolve(input));
      stamp = `${title} · built ${date}`;
    } else {
      const dirty = git(root, 'status', '--porcelain') !== '';
      if (dirty && !args.includes('--allow-dirty')) fail('working tree has uncommitted changes; commit them or pass --allow-dirty for a preview');
      const sha = git(root, 'rev-parse', 'HEAD');
      const short = sha.slice(0, 8);
      const built = `Built ${date} from ${short}${dirty ? ' with uncommitted changes' : ''}`;
      markdown = assembleManual(root, sha);
      meta = { title: TITLE, subtitle: 'For SVBC IT: operating, troubleshooting and extending SVBC\'s custom systems', date: built, toc: 'true', 'toc-title': 'Contents' };
      pdfName = `svbc-it-manual-${date}-${short}${dirty ? '-dirty' : ''}.pdf`;
      resourcePath = join(root, 'docs/manual');
      stamp = built;
    }
    const mdPath = join(work, 'manual.md');
    const headerPath = join(work, 'head.html');
    const htmlPath = join(work, 'manual.html');
    writeFileSync(mdPath, markdown);
    writeFileSync(headerPath, await headCss(root));
    runPandoc(mdPath, htmlPath, headerPath, join(root, 'docs/manual/print.css'), resourcePath, meta);
    const pdfPath = join(outDir, pdfName);
    await printToPdf(chrome, htmlPath, pdfPath, stamp);
    console.log(`build-manual: wrote ${pdfPath}`);
  } catch (err) {
    fail(err.message);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
