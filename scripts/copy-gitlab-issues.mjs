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
// posted), and posts nothing. --confirm never fetches: it posts exactly the cached JSON, and
// refuses if either file is missing. Re-running is safe: an issue already on GitHub (found by its
// GitLab URL in the body) is not created again, only its GitLab note and close are ensured.
// Needs `glab` and `gh` logged in. Logs titles and ids only, never bodies.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rewriteRefs } from './rewrite-gitlab-refs.mjs';

const REVIEW_DIR = 'github-migration-review';
const day = (iso) => String(iso).slice(0, 10);

export function reviewPaths(to) {
  const repo = to.split('/').pop();
  return { dir: REVIEW_DIR, md: `${REVIEW_DIR}/${repo}-issues.md`, json: `${REVIEW_DIR}/${repo}-issues.json` };
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

// Pure. glIssue/glNotes are GitLab API objects (notes already filtered to system: false).
export function buildIssue(glIssue, glNotes, project, { maxIssue = Infinity, maxMr = Infinity } = {}) {
  const prepare = (text) =>
    rewriteRefs(text ?? '', { project, kind: 'markdown', maxIssue, maxMr })
      .text.replace(/\]\(\/uploads\//g, `](https://gitlab.com/${project}/uploads/`);
  const parts = [];
  const description = prepare(glIssue.description).trim();
  if (description) parts.push(description);
  if (glNotes.length > 0) {
    const notes = glNotes
      .map((n) => `**@${n.author.username}** (${day(n.created_at)}):\n\n${prepare(n.body).trim()}`)
      .join('\n\n');
    parts.push(`<details><summary>GitLab discussion (${glNotes.length} comments)</summary>\n\n${notes}\n\n</details>`);
  }
  parts.push(`---\nMoved from ${glIssue.web_url} (opened by @${glIssue.author.username} on ${day(glIssue.created_at)}).`);
  return { title: glIssue.title, body: parts.join('\n\n'), labels: [...(glIssue.labels ?? [])] };
}

// `existing` is the `gh issue list --json url` result for the issue's GitLab URL.
export function planIssue(existing) {
  return existing.length > 0 ? { create: false, url: existing[0].url } : { create: true, url: null };
}

const run = (cmd, args, input) =>
  execFileSync(cmd, args, { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
const glabPages = (path) => parsePages(run('glab', ['api', '--paginate', path]));

function renderReview(entries) {
  return [
    '# GitHub migration review: read every line for personal data before running --confirm\n',
    ...entries.map((e) =>
      [
        `## GL#${e.iid}: ${e.title}`,
        `Source: ${e.web_url}`,
        `Labels: ${e.labels.join(', ') || '(none)'}`,
        '',
        '````markdown',
        e.body,
        '````',
        '',
      ].join('\n'),
    ),
  ].join('\n');
}

function fetchPhase({ from, to, maxIssue, maxMr }) {
  const enc = encodeURIComponent(from);
  const issues = glabPages(`projects/${enc}/issues?state=opened`);
  const entries = issues.map((issue) => {
    const notes = glabPages(`projects/${enc}/issues/${issue.iid}/notes?sort=asc`).filter((n) => !n.system);
    const { title, body, labels } = buildIssue(issue, notes, from, { maxIssue, maxMr });
    const alreadyNoted = notes.some((n) => /^Moved to https:\/\/github\.com\//.test(n.body));
    return { iid: issue.iid, web_url: issue.web_url, title, body, labels, alreadyNoted };
  });
  const paths = reviewPaths(to);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.json, JSON.stringify(entries, null, 2));
  writeFileSync(paths.md, renderReview(entries));
  console.log(`${entries.length} open issue(s) fetched from ${from}`);
  console.log(`Read ${paths.md}, then re-run with --confirm. Nothing was posted.`);
}

function confirmPhase({ from, to }) {
  const paths = reviewPaths(to);
  if (!existsSync(paths.md) || !existsSync(paths.json)) {
    console.error(`Refusing --confirm: ${paths.md} and ${paths.json} must exist. Run without --confirm first and review them.`);
    process.exit(1);
  }
  const entries = JSON.parse(readFileSync(paths.json, 'utf8'));
  const enc = encodeURIComponent(from);
  for (const label of new Set(entries.flatMap((e) => e.labels))) {
    run('gh', ['label', 'create', label, '--repo', to, '--force']);
  }
  for (const e of entries) {
    const found = JSON.parse(
      run('gh', ['issue', 'list', '--repo', to, '--state', 'all', '--search', `${e.web_url} in:body`, '--json', 'url']),
    );
    const plan = planIssue(found);
    let url = plan.url;
    if (plan.create) {
      const args = ['issue', 'create', '--repo', to, '--title', e.title, '--body-file', '-'];
      for (const l of e.labels) args.push('--label', l);
      url = run('gh', args, e.body).trim();
    }
    if (!e.alreadyNoted) {
      run('glab', ['api', '-X', 'POST', `projects/${enc}/issues/${e.iid}/notes`, '-f', `body=Moved to ${url}`]);
    }
    run('glab', ['api', '-X', 'PUT', `projects/${enc}/issues/${e.iid}`, '-f', 'state_event=close']);
    console.log(`GL#${e.iid} "${e.title}" -> ${url}${plan.create ? '' : ' (already existed)'}`);
  }
}

function parseArgs(argv) {
  const args = { from: null, to: null, maxIssue: null, maxMr: null, confirm: false };
  const names = { '--from': 'from', '--to': 'to', '--max-issue': 'maxIssue', '--max-mr': 'maxMr' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--confirm') args.confirm = true;
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
    console.error('usage: copy-gitlab-issues.mjs --from <gitlab path> --to <owner/repo> --max-issue N --max-mr N [--confirm]');
    process.exit(2);
  }
  if (args.confirm) confirmPhase(args);
  else fetchPhase(args);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
