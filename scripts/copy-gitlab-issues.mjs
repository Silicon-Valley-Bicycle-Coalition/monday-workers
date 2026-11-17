#!/usr/bin/env node
// Copies open GitLab issues into a GitHub repo, leaving a back-link note and closing the GitLab
// original. Two phases, because issue bodies may hold donor or staff personal data and the target
// can be a PUBLIC repo:
//
//   node scripts/copy-gitlab-issues.mjs --from <gitlab path> --to <owner/repo> --max-issue N --max-mr N
//   node scripts/copy-gitlab-issues.mjs --from <gitlab path> --to <owner/repo> --confirm
//
// Without --confirm it fetches open issues and their human notes, writes
// github-migration-review/<repo>-issues.md (read every line of it) and .json (what will be
// posted; redact there, the .md is a read-only view), and posts nothing. Confidential GitLab
// issues are skipped unless --include-confidential, and internal (confidential) notes unless
// --include-internal (the review .md counts them per issue). Issues are copied in iid order so
// GitHub numbers follow GitLab's. A fetch refuses to overwrite an existing cache (your redactions
// and progress) unless --refetch. --confirm never fetches: it posts exactly the
// cached JSON, refuses if either file is missing or --from/--to differ from the cache, and records
// each step (create, note, close) in the JSON as it succeeds, so a crashed run resumes without
// duplicating anything. An issue already on GitHub is found by its exact footer line.
// Needs `glab` and `gh` logged in. Logs titles and ids only, never bodies.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { opensFence, rewriteRefs } from './rewrite-gitlab-refs.mjs';

const REVIEW_DIR = 'github-migration-review';
// The repo root that holds this script, so the gitignored review dir is the same wherever it runs from.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const day = (iso) => String(iso).slice(0, 10);

export function reviewPaths(to, root = REPO_ROOT) {
  const repo = to.split('/').pop();
  const dir = join(root, REVIEW_DIR);
  return { dir, md: join(dir, `${repo}-issues.md`), json: join(dir, `${repo}-issues.json`) };
}

// `glab api --paginate` prints one JSON array per page, back to back. Split them by tracking
// bracket depth outside strings, so a "][" inside issue text can't confuse it.
export function parsePages(output) {
  const items = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < output.length; i++) {
    const c = output[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) items.push(...[].concat(JSON.parse(output.slice(start, i + 1))));
    }
  }
  return items;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const INLINE_CODE = /(`[^`\n]*`)/;
// A mention starts at start of text or after any character outside [A-Za-z0-9.+\-/`], so markup
// punctuation (`**@x**`, `"@x"`, `[@x]`) counts but emails and URL paths (`/@x`) do not.
const MENTION = /(^|[^A-Za-z0-9.+\-/`])@([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)/g;

// Wraps @handle in backticks so copied text can't notify real GitHub users. Skips fenced and
// inline code.
export function wrapMentions(text) {
  let fence = null;
  return text
    .split('\n')
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (marker && !fence && opensFence(line, marker)) {
        fence = marker;
        return line;
      }
      if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        fence = null;
        return line;
      }
      if (fence) return line;
      return line
        .split(INLINE_CODE)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(MENTION, '$1`@$2`')))
        .join('');
    })
    .join('\n');
}

export function footerLine(glIssue) {
  return `Moved from ${glIssue.web_url} (opened by \`@${glIssue.author.username}\` on ${day(glIssue.created_at)}).`;
}

// Pure. glIssue/glNotes are GitLab API objects (notes already filtered to system: false).
export function buildIssue(glIssue, glNotes, project, { maxIssue = Infinity, maxMr = Infinity } = {}) {
  const prepare = (text) =>
    wrapMentions(
      rewriteRefs(text ?? '', { project, kind: 'markdown', maxIssue, maxMr })
        .text.replace(/\]\(\/uploads\//g, `](https://gitlab.com/${project}/uploads/`),
    );
  const title = rewriteRefs(glIssue.title ?? '', { project, kind: 'plain', maxIssue, maxMr }).text;
  const parts = [];
  const description = prepare(glIssue.description).trim();
  if (description) parts.push(description);
  if (glNotes.length > 0) {
    const notes = glNotes
      .map((n) => `**\`@${n.author.username}\`** (${day(n.created_at)}):\n\n${prepare(n.body).trim()}`)
      .join('\n\n');
    parts.push(`<details><summary>GitLab discussion (${glNotes.length} comments)</summary>\n\n${notes}\n\n</details>`);
  }
  parts.push(`---\n${footerLine(glIssue)}`);
  return { title, body: parts.join('\n\n'), labels: [...(glIssue.labels ?? [])] };
}

// `candidates` is `gh issue list --json url,body`. The search is fuzzy, so accept only a body that
// holds the exact footer as a full line (`/issues/9` must not match `/issues/90`, and a body that
// merely links the issue is not a copy of it).
export function findExistingIssue(candidates, footer) {
  return candidates.find((c) => c.body.split('\n').some((l) => l.trim() === footer))?.url ?? null;
}

// Which steps remain for an entry; 'resolve' = find the GitHub issue or create it.
export function nextSteps(entry) {
  return [!entry.ghUrl && 'resolve', !entry.noted && 'note', !entry.closed && 'close'].filter(Boolean);
}

export function checkMeta(meta, { from, to }) {
  if (!meta) return 'the cached JSON has no meta; re-run without --confirm';
  if (meta.from !== from) return `--from ${from} does not match the cache (${meta.from})`;
  if (meta.to !== to) return `--to ${to} does not match the cache (${meta.to})`;
  return null;
}

// GitLab internal notes (`internal`, formerly `confidential`) are staff-only; a public GitHub repo
// must not get them unless the operator opts in.
export function filterNotes(notes, { includeInternal = false } = {}) {
  const skipped = includeInternal ? [] : notes.filter((n) => n.internal || n.confidential);
  return { kept: notes.filter((n) => !skipped.includes(n)), skipped };
}

// A fetch rewrites the cache, which holds hand redactions and confirm progress.
export function refetchProblem({ exists, refetch }) {
  return exists && !refetch
    ? 'the cached JSON already exists (it may hold your redactions and progress); pass --refetch to overwrite it'
    : null;
}

// GitHub numbers follow creation order, so copy oldest first.
export function sortIssues(issues) {
  return [...issues].sort((a, b) => a.iid - b.iid);
}

export function filterIssues(issues, { includeConfidential = false } = {}) {
  const skipped = includeConfidential ? [] : issues.filter((i) => i.confidential);
  return { kept: issues.filter((i) => !skipped.includes(i)), skipped };
}

// A code fence must out-run any backtick run inside it.
export function fenceFor(content) {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const run = (cmd, args, input) =>
  execFileSync(cmd, args, { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
const glabPages = (path) => parsePages(run('glab', ['api', '--paginate', path]));

export function renderReview(entries, skipped) {
  const out = [
    '# GitHub migration review: read every line for personal data before running --confirm\n',
    'READ-ONLY VIEW. The .json beside this file is what gets posted; make any redaction in that',
    "file's entry `body`, not here.\n",
  ];
  if (skipped.length > 0) {
    out.push('## Skipped (confidential; use --include-confidential to copy)\n');
    out.push(...skipped.map((i) => `- GL#${i.iid}: ${i.title}`), '');
  }
  for (const e of entries) {
    const fence = fenceFor(e.body);
    out.push(
      `## GL#${e.iid}: ${e.title}`,
      `Source: ${e.web_url}`,
      `Labels: ${e.labels.join(', ') || '(none)'}`,
      ...(e.internalSkipped > 0 ? [`Internal notes skipped: ${e.internalSkipped}`] : []),
      '',
      `${fence}markdown`,
      e.body,
      fence,
      '',
    );
  }
  return out.join('\n');
}

function fetchPhase({ from, to, maxIssue, maxMr, includeConfidential, includeInternal, refetch }) {
  const paths = reviewPaths(to);
  const problem = refetchProblem({ exists: existsSync(paths.json), refetch });
  if (problem) {
    console.error(`Refusing to fetch: ${problem}.`);
    process.exit(1);
  }
  const enc = encodeURIComponent(from);
  const { kept, skipped } = filterIssues(glabPages(`projects/${enc}/issues?state=opened`), { includeConfidential });
  const entries = sortIssues(kept).map((issue) => {
    const all = glabPages(`projects/${enc}/issues/${issue.iid}/notes?sort=asc`).filter((n) => !n.system);
    const { kept: notes, skipped: internal } = filterNotes(all, { includeInternal });
    const { title, body, labels } = buildIssue(issue, notes, from, { maxIssue, maxMr });
    return {
      iid: issue.iid,
      web_url: issue.web_url,
      title,
      body,
      labels,
      footer: footerLine(issue),
      ghUrl: null,
      internalSkipped: internal.length,
      noted: notes.some((n) => /^Moved to https:\/\/github\.com\//.test(n.body)),
      closed: false,
    };
  });
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.json, JSON.stringify({ meta: { from, to }, entries }, null, 2));
  writeFileSync(paths.md, renderReview(entries, skipped));
  console.log(`${entries.length} open issue(s) fetched from ${from}; ${skipped.length} confidential skipped`);
  const internalTotal = entries.reduce((n, e) => n + e.internalSkipped, 0);
  if (internalTotal > 0) console.log(`${internalTotal} internal note(s) skipped (--include-internal to copy)`);
  console.log(`Read ${paths.md}, then re-run with --confirm. Nothing was posted.`);
}

function confirmPhase({ from, to }) {
  const paths = reviewPaths(to);
  if (!existsSync(paths.md) || !existsSync(paths.json)) {
    console.error(`Refusing --confirm: ${paths.md} and ${paths.json} must exist. Run without --confirm first and review them.`);
    process.exit(1);
  }
  const cache = JSON.parse(readFileSync(paths.json, 'utf8'));
  const mismatch = checkMeta(cache.meta, { from, to });
  if (mismatch) {
    console.error(`Refusing --confirm: ${mismatch}.`);
    process.exit(1);
  }
  const save = () => writeFileSync(paths.json, JSON.stringify(cache, null, 2));
  const enc = encodeURIComponent(from);
  for (const label of new Set(cache.entries.flatMap((e) => e.labels))) {
    run('gh', ['label', 'create', label, '--repo', to, '--force']);
  }
  for (const e of cache.entries) {
    for (const step of nextSteps(e)) {
      if (step === 'resolve') {
        const found = JSON.parse(
          run('gh', ['issue', 'list', '--repo', to, '--state', 'all', '--search', `"${e.footer.split(' (opened by')[0]} (opened by" in:body`, '--json', 'url,body']),
        );
        e.ghUrl = findExistingIssue(found, e.footer);
        if (!e.ghUrl) {
          const args = ['issue', 'create', '--repo', to, '--title', e.title, '--body-file', '-'];
          for (const l of e.labels) args.push('--label', l);
          e.ghUrl = run('gh', args, e.body).trim();
        }
      } else if (step === 'note') {
        run('glab', ['api', '-X', 'POST', `projects/${enc}/issues/${e.iid}/notes`, '-f', `body=Moved to ${e.ghUrl}`]);
        e.noted = true;
      } else {
        run('glab', ['api', '-X', 'PUT', `projects/${enc}/issues/${e.iid}`, '-f', 'state_event=close']);
        e.closed = true;
      }
      save();
    }
    console.log(`GL#${e.iid} "${e.title}" -> ${e.ghUrl}`);
  }
}

function parseArgs(argv) {
  const args = { from: null, to: null, maxIssue: null, maxMr: null, confirm: false, includeConfidential: false, includeInternal: false, refetch: false };
  const names = { '--from': 'from', '--to': 'to', '--max-issue': 'maxIssue', '--max-mr': 'maxMr' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--confirm') args.confirm = true;
    else if (flag === '--include-confidential') args.includeConfidential = true;
    else if (flag === '--include-internal') args.includeInternal = true;
    else if (flag === '--refetch') args.refetch = true;
    else if (names[flag]) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return null;
      if (flag.startsWith('--max') && !/^\d+$/.test(v)) return null;
      args[names[flag]] = flag.startsWith('--max') ? Number(v) : v;
    } else return null;
  }
  if (!args.from || !/^[^/]+\/[^/]+$/.test(args.to ?? '')) return null;
  if (!args.confirm && (args.maxIssue === null || args.maxMr === null)) return null;
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: copy-gitlab-issues.mjs --from <gitlab path> --to <owner/repo> --max-issue N --max-mr N [--include-confidential] [--include-internal] [--refetch] [--confirm]');
    process.exit(2);
  }
  if (args.confirm) confirmPhase(args);
  else fetchPhase(args);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
