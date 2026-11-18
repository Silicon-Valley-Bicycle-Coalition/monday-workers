# GitLab → GitHub Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `monday-migration` (private) and `monday-workers` (public) from GitLab to the
`Silicon-Valley-Bicycle-Coalition` GitHub org so day-to-day work, CI and Claude all run on GitHub.

**Architecture:** Three code tasks on a branch of monday-workers (reference rewriter, issue copier,
GitHub Actions port) are built and tested first. Operator tasks then run them: monday-migration first
as a rehearsal, then monday-workers behind a history audit, then Workers Builds, local move, archive.

**Tech Stack:** Node 22.18+ dependency-free `.mjs` with `node:test` (root `scripts/` convention),
`gh`, `glab`, `gitleaks`, `git-filter-repo`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-17-github-migration-design.md`

## Global Constraints

- GitHub org `Silicon-Valley-Bicycle-Coalition`; repos `monday-migration` (private) and `monday-workers` (public).
- GitLab projects: `silicon-valley-bicycle-coalition/svbc-monday-migration`, `silicon-valley-bicycle-coalition/svbc-monday-workers`.
- Push `refs/heads/*` and `refs/tags/*` only — never `git push --mirror`.
- No monday-workers byte reaches GitHub before Task 5's audit passes.
- Third-party Actions pinned by full commit SHA; `permissions: contents: read` by default.
- New scripts: dependency-free ES modules in `scripts/`, tests beside them as `*.test.mjs` (picked up by the existing log-safety test glob).
- `glab` and the Worker tests need the sandbox disabled (memory: sandbox-blocks-worker-tests-and-glab).
- Run `git -C <worktree> status --ignored --short | grep '^!!'` and copy out anything irreplaceable before any `git worktree remove` (workspace CLAUDE.md).
- Cutover date stamped into READMEs is the day Task 6 runs (written `CUTOVER_DATE` below).

## Review Focus

1. **CSS hex colours that look like issue refs** (`color: #333;` in a `.ts` template string) — must not be rewritten. Test in Task 1.
2. **Issue bodies holding donor PII or staff personal data** copied into a *public* GitHub issue — the copier must write a review file and refuse to post without `--confirm`. Test in Task 2.
3. **Push to `main` whose `before` SHA is all zeros or force-pushed away** — changed-worker detection must fall back to "all Workers", not "none". Test in Task 3.
4. **A Worker directory added without a `workers.json` entry** — must fail CI, not silently go untested. Test in Task 3.
5. **Running the issue copier twice** — must not create duplicate GitHub issues. Test in Task 2.

---

### Task 1: Reference rewriter

**Files:**
- Create: `scripts/rewrite-gitlab-refs.mjs`
- Test: `scripts/rewrite-gitlab-refs.test.mjs`

**Interfaces:**
- Produces: `rewriteRefs(text: string, opts: { project: string, kind: 'markdown' | 'code' }): { text: string, changes: Array<{ index: number, from: string, to: string }> }`
- Produces CLI: `node scripts/rewrite-gitlab-refs.mjs --project <gitlab path> [--write] [paths…]` — default dry run prints `file:line  from → to` for every change; `--write` applies. With no paths it walks `git ls-files` filtered to `*.md *.ts *.mjs *.js *.jsonc *.json *.yml *.yaml *.html *.sh`.
- `kind` is `markdown` for `.md`, else `code`.

Rewrites: `#NN` → issue, `!NN` → merge request, where NN is 1–4 digits, preceded by start of line, whitespace, `(`, `[`, `,` or `/`-free punctuation, and not preceded by a word character, `&`, `/` or `#`. Links: `https://gitlab.com/<project>/-/issues/NN`, `…/-/merge_requests/NN`. Markdown output `[GL#NN](url)` / `[GL!NN](url)`; code output `GL#NN` / `GL!NN` (the README legend explains the prefix and gives the base URLs). Skip: text inside markdown fenced code blocks; markdown headings (`#` at line start followed by space); a match already inside a markdown link `[…](…)`; `!NN` followed by `=`; any match on a line matching `/:\s*#[0-9a-fA-F]{3,8}\b/` (CSS colours).

- [ ] **Step 1: Write failing tests** in `scripts/rewrite-gitlab-refs.test.mjs` with `project = 'silicon-valley-bicycle-coalition/svbc-monday-workers'`:
  - `'Fixes #58.'` markdown → `'Fixes [GL#58](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/58).'`
  - `'(!299)'` markdown → `'([GL!299](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/merge_requests/299))'`
  - `'// breaker (#101)'` code → `'// breaker (GL#101)'`
  - unchanged: `'  color: #333;'`, `'## 12 heading'` (markdown), `'monday-migration#12'`, `'&#39;'`, `'a != !b'`, `'x !== 1'`, `'[GL#5](https://x)'`, and `'#58'` inside a ```` ``` ```` fence.
  - `changes.length` equals the number of rewrites on a mixed input.
- [ ] **Step 2:** `node --test scripts/rewrite-gitlab-refs.test.mjs` — Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `rewriteRefs` and the CLI in `scripts/rewrite-gitlab-refs.mjs`.
- [ ] **Step 4:** `node --test scripts/rewrite-gitlab-refs.test.mjs` — Expected: PASS. Then `node scripts/check-log-safety.mjs` — Expected: exit 0.
- [ ] **Step 5:** Dry run on this repo: `node scripts/rewrite-gitlab-refs.mjs --project silicon-valley-bicycle-coalition/svbc-monday-workers > /tmp/refs.txt; wc -l /tmp/refs.txt` — skim for false positives; any found becomes a new failing test, fixed before moving on. Do **not** `--write` yet (Task 6 does).
- [ ] **Step 6: Commit** — `git add scripts/rewrite-gitlab-refs*.mjs && git commit -m "feat(scripts): rewrite bare GitLab issue/MR refs to explicit links"`

### Task 2: Issue copier

**Files:**
- Create: `scripts/copy-gitlab-issues.mjs`
- Test: `scripts/copy-gitlab-issues.test.mjs`

**Interfaces:**
- Consumes: `rewriteRefs` from Task 1 (body and notes, `kind: 'markdown'`).
- Produces: `buildIssue(glIssue, glNotes, project): { title: string, body: string, labels: string[] }` — pure.
- Produces CLI: `node scripts/copy-gitlab-issues.mjs --from <gitlab path> --to <owner/repo> [--confirm]`. Without `--confirm`: fetches open issues (`glab api --paginate "projects/<url-encoded path>/issues?state=opened"` and each issue's notes, `system: false` only), writes `github-migration-review/<repo>-issues.md` (every title, body and note, for a human PII read) and posts nothing. With `--confirm`: creates labels (`gh label create --force`), then per issue `gh issue create`, then `glab api -X POST …/issues/<iid>/notes` with `Moved to <gh url>` and `glab api -X PUT …/issues/<iid> -f state_event=close`.
- Idempotency: before creating, `gh issue list --repo <to> --state all --search "<gitlab issue url> in:body" --json url`; a hit skips creation and only ensures the GitLab note/close.

`buildIssue` body layout: rewritten description; `/uploads/…` relative links made absolute against `https://gitlab.com/<project>`; then a `<details><summary>GitLab discussion (N comments)</summary>` block with each note as `**@author** (date):` + rewritten body; then footer `---\nMoved from <web_url> (opened by @<author> on <YYYY-MM-DD>).`. Labels: GitLab label names verbatim.

- [ ] **Step 1: Write failing tests** for `buildIssue` with a fixture issue (iid 9, web_url `https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/9`, description `'See #3 and ![x](/uploads/ab/x.png)'`, labels `['bug']`, one note): body contains `[GL#3](…/-/issues/3)`, contains `https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/uploads/ab/x.png`, contains `GitLab discussion (1 comments)`, ends with the `Moved from … /issues/9` footer; `labels` deep-equals `['bug']`; zero notes → no `<details>` block.
- [ ] **Step 2:** `node --test scripts/copy-gitlab-issues.test.mjs` — Expected: FAIL.
- [ ] **Step 3:** Implement `buildIssue` and the CLI (shell out with `execFileSync`, never a shell string). The CLI refuses `--confirm` unless the review file for that repo exists and is newer than the fetch.
- [ ] **Step 4:** Tests PASS; `node scripts/check-log-safety.mjs` exit 0.
- [ ] **Step 5: Commit** — `feat(scripts): copy open GitLab issues to GitHub with back-links`

### Task 3: GitHub Actions port

**Files:**
- Create: `.github/workers.json`, `.github/workflows/checks.yml`, `.github/workflows/workers.yml`
- Create: `scripts/ci-changed-workers.mjs`, `scripts/ci-changed-workers.test.mjs`
- Modify: `monday-backup/src/monday/graphql.ts:7` (`.gitlab-ci.yml` → `.github/workflows/checks.yml`), then copy it to every path in the roster.
- Delete: `.gitlab-ci.yml` — in Task 6's cutover commit, not here (GitLab CI must keep running until then).

**Interfaces:**
- `.github/workers.json`: `Array<{ dir: string, extraPaths?: string[], extraTest?: string, sandbox?: { config?: string } }>`; entries in deploy order. Values from `.gitlab-ci.yml`: `extraPaths: ["scripts/lib/**"]` for donation-rollups and dtd-sync (plus any other job whose rules list it — copy each job's `changes:` exactly); `extraTest: "test:scripts"` for dtd-sync; `sandbox` for exactly the Workers that have a `deploy-sandbox:` job today, with member-portal listed twice — `{dir:"member-portal", sandbox:{}}` then `{dir:"member-portal", sandbox:{config:"wrangler.writer.jsonc"}}`.
- `scripts/ci-changed-workers.mjs` produces `changedWorkers(files: string[], workers: Worker[], allDirs: string[]): { test: Worker[], deploy: Worker[], unlisted: string[] }`, and a CLI `--base <sha> --head <sha>` that writes `test=<json>`, `deploy=<json>` to `$GITHUB_OUTPUT` and exits 1 if `unlisted` is non-empty. `allDirs` = top-level directories containing `package.json`. `test` is deduplicated by `dir`. Base unreachable or all zeros → every Worker.
- `checks.yml`: on `pull_request` and `push` to `main`; one job with id `checks` (a required status check in Task 6), `actions/setup-node` (Node `22.23`), steps ported verbatim from `.gitlab-ci.yml` jobs `monday-graphql-copies`, `monday-outage-copies`, `geo-geometry-copies`, `worker-flags-copies`, `monday-auth-bindings`, `preview-urls`, `rate-limit-namespaces`, `log-safety`, all unconditional.
- `workers.yml`: on `pull_request` and `push` to `main`; jobs `changes` (checkout `fetch-depth: 0`, runs the CLI with base `github.event.pull_request.base.sha || github.event.before`), `test` (matrix `fromJSON(needs.changes.outputs.test)`, `fail-fast: false`, npm cache keyed on `<dir>/package-lock.json`, runs `npm ci && npm test && npm run typecheck` plus `npm run <extraTest>` when set), `deploy-sandbox` (only on `push` to `main`, `needs: test`, `environment: sandbox`, `strategy.max-parallel: 1`, matrix `deploy`, `concurrency: sandbox-${{ matrix.dir }}-${{ matrix.sandbox.config || 'main' }}`, first step exits 0 with a notice when `secrets.CLOUDFLARE_API_TOKEN` is empty, else `npx wrangler deploy [-c <config>] --env sandbox`), and `ci-ok` (`if: always()`, `needs: [changes, test]`, fails if either result is `failure` or `cancelled`). Workflow `permissions: contents: read`.

- [ ] **Step 1: Write failing tests** for `changedWorkers`: a change under `dtd-sync/` → test `[dtd-sync]`; a change to `scripts/lib/x.mjs` → test includes donation-rollups and dtd-sync; a change to `member-portal/src/a.ts` → test has one member-portal entry, deploy has both member-portal entries in order; a change to `README.md` only → empty test; `allDirs` containing `new-worker` not in workers → `unlisted: ['new-worker']`.
- [ ] **Step 2:** `node --test scripts/ci-changed-workers.test.mjs` — Expected: FAIL.
- [ ] **Step 3:** Implement `changedWorkers` + CLI; write `.github/workers.json` from `.gitlab-ci.yml` (every Worker job, including `svbc-calendars`, `salesforce-import`, `geo-filter`, `quickbooks-sync` without `sandbox`).
- [ ] **Step 4:** Tests PASS. Then `node scripts/ci-changed-workers.mjs --base 0000000000000000000000000000000000000000 --head HEAD` with `GITHUB_OUTPUT=/tmp/o` — Expected: `/tmp/o` `test=` lists every Worker; `deploy=` matches today's `deploy-sandbox:` jobs one-for-one.
- [ ] **Step 5:** Write both workflows; pin `actions/checkout` and `actions/setup-node` by SHA (resolve with `gh api repos/actions/checkout/git/ref/tags/<tag> --jq .object.sha`). Lint: `npx --yes @action-validator/cli@0.6.0 .github/workflows/*.yml` (or `actionlint` if installed) — Expected: no errors.
- [ ] **Step 6:** Edit the graphql.ts comment, copy to the roster (`for c in $(grep -o '[a-z-]*/src/monday/graphql.ts' .gitlab-ci.yml); do cp monday-backup/src/monday/graphql.ts $c; done`), run the `monday-graphql-copies` script locally — Expected: exit 0.
- [ ] **Step 7:** Update root `CLAUDE.md` and `README.md` wording that names `.gitlab-ci.yml` jobs or "MR" to the new workflow/job names and "PR" (the roster sentence now points at `checks.yml`).
- [ ] **Step 8: Commit** — `ci: port GitLab CI to GitHub Actions`. Push to GitLab and open an MR; GitLab CI must stay green (the new files are inert there).

### Task 4: Rehearsal — monday-migration to GitHub (operator)

**`--max-issue` / `--max-mr`:** the rewriter and copier take the highest real GitLab issue and MR numbers, so a colour like `#888` is never read as a reference. Use each project's highest `iid`; today that is 127 / 509 for monday-workers. Look up monday-migration's at run time: `glab api "projects/<url-encoded path>/issues?per_page=1&order_by=created_at&sort=desc&scope=all"` and the same with `merge_requests`, reading `iid` from each.

- [x] **Step 1:** Merge or close monday-migration's 2 open MRs on GitLab; prune merged remote branches (`glab api` / web UI).
- [x] **Step 2:** `gh repo create Silicon-Valley-Bicycle-Coalition/monday-migration --private --disable-wiki`.
- [x] **Step 3:** `git clone --mirror git@gitlab.com:silicon-valley-bicycle-coalition/svbc-monday-migration.git /tmp/mm.git && cd /tmp/mm.git && git push git@github.com:Silicon-Valley-Bicycle-Coalition/monday-migration.git 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'`. Verify: `git ls-remote` on both hosts lists the same heads/tags SHAs.
- [x] **Step 4:** In a monday-migration worktree: run Task 1's script with `--project silicon-valley-bicycle-coalition/svbc-monday-migration --max-issue <N> --max-mr <N> --write`, review the diff, port its `.gitlab-ci.yml` (`syntax-check`: `for f in scripts/*.mjs; do node --check "$f"; done`, path filter `scripts/**`) to `.github/workflows/check.yml`, delete `.gitlab-ci.yml`, update its `CLAUDE.md`/`README.md` remotes and MR→PR wording, add the legend line (`GL#NN`/`GL!NN` = GitLab; commit messages before CUTOVER_DATE use GitLab numbers). Commit, push to GitHub `main`. Expected: the Actions run is green.
- [x] **Step 5:** Run both phases from the primary `monday-workers` checkout (the script lives there; its gitignored `github-migration-review/` cache holds redactions and confirm progress and would be deleted with a removed worktree). `node scripts/copy-gitlab-issues.mjs --from silicon-valley-bicycle-coalition/svbc-monday-migration --to Silicon-Valley-Bicycle-Coalition/monday-migration --max-issue <N> --max-mr <N>`; read the review file; rerun with `--confirm` (the same `--from`/`--to`, no `--max-*`). A fetch refuses to overwrite an existing review cache, which holds your redactions and the confirm progress; pass `--refetch` only to deliberately discard it. Verify: 35 GitHub issues, 0 open GitLab issues, each GitLab issue has a "Moved to" note. Run `--confirm` again — Expected: 0 created.
- [x] **Step 6:** `git -C monday-migration remote set-url origin git@github.com:Silicon-Valley-Bicycle-Coalition/monday-migration.git` and in every monday-migration worktree (shared config — once is enough); `git fetch && git status` — Expected: tracking `origin/main`, up to date.
- [x] **Step 7:** Write down anything that surprised you in the plan file under "Rehearsal notes" before Task 5.

#### Rehearsal notes (Task 4, done 2026-11-17)

monday-migration is on GitHub (private): 8 heads pushed, GitLab parity checked, 35 issues
copied (GitLab 0 open), `check.yml` green, `origin` switched, primary checkout fast-forwarded.
What surprised us, and what Task 6 must do about it:

- **The rewriter's dry run is not reviewable by eye, and 65 of 412 changes (16%) were wrong.**
  29 were local numbering (punch-list rows, "welcome email #3", "Gate B #2", "deliverable #10");
  34 were refs to the *other* project, only 8 of them with the repo named ("`monday-workers` MR
  !11"); the other 26 were found only by comparing each ref with both projects' issue and MR
  titles; 2 were other (an item name, "donor #14,203"). For Task 6, before `--write`: dispatch a
  read-only review that checks every dry-run line against the source and both projects' titles
  (`glab api projects/<enc>/issues?scope=all&per_page=100`, and merge_requests) and writes a TSV
  `path:line  token  local|cross-project|other  reason`. After `--write`, revert local/other to
  the bare token and point cross-project links at `svbc-monday-migration`. Expect the same mix in
  reverse there: monday-workers docs cite migration issues by bare number.
- **Ranges rewrite only the first number** (`#56–#61` → `[GL#56](…)–#61`). Harmless in files
  (GitHub doesn't autolink in rendered files) but not in issue bodies, where the bare second
  number autolinks to a GitHub issue. Two were hand-fixed in the review JSON before `--confirm`.
- **The rewriter's summary over-counts files** ("412 change(s) in 216 file(s)"; 41 files changed).
- **`--max-issue` from `order_by=created_at` was 117, but GL#118 exists** (the copier moved it).
  Take the highest `iid` from the full list instead.
- **Issue bodies only got a partial check for unnamed cross-project refs.** Only low numbers and
  refs that named the repo were checked. For monday-workers, run the title comparison on the
  review JSON too.
- **A re-run of `--confirm` prints every existing mapping, not "0 created"**: check the GitHub
  issue count is unchanged (it was: 35).
- **monday-migration's README and `workers/README.md` link to monday-workers on GitLab**; update
  them in Task 6 Step 4 once monday-workers moves.
- GitLab CI quota was exhausted all day; GitHub Actions ran the ported job fine.

### Task 5: monday-workers history audit (gate)

- [ ] **Step 1:** `brew install gitleaks git-filter-repo`.
- [ ] **Step 2:** Fresh mirror: `git clone --mirror git@gitlab.com:silicon-valley-bicycle-coalition/svbc-monday-workers.git /tmp/mw.git`.
- [ ] **Step 3:** `gitleaks git /tmp/mw.git --report-path /tmp/mw-gitleaks.json --redact` — Expected: zero findings, or each finding classified (test fixture / revoked / real).
- [ ] **Step 4:** Targeted scans over all commits (`git -C /tmp/mw.git log --all -p` piped through `grep -nE`): email addresses not matching `@(example\.(com|org)|bikesiliconvalley\.org)`; `@bikesiliconvalley\.org` addresses other than role accounts (`sandbox@`, `info@`, etc.); US phone numbers; `\b\d{3}-\d{2}-\d{4}\b`; and `git log --all --name-only` for any path under `*/data/`, `*.csv`, `.env*`, `.dev.vars*` ever committed.
- [ ] **Step 5:** Decide per finding. Real secret → rotate it first, then `git filter-repo --replace-text`. PII file → `git filter-repo --invert-paths --path <p>`. Record the outcome (no PII details) in this plan under "Audit result". If filter-repo was used, all later steps push from the rewritten mirror, and every existing local clone/worktree must be re-cloned (Task 8 handles it). If findings can't be cleanly removed: stop and agree the squashed fresh start with David.

### Task 6: monday-workers cutover (operator)

- [ ] **Step 1:** Announce freeze: no merges on GitLab monday-workers until Step 6 is done. Merge Task 1–3's MR. Merge or close the 2 open MRs. Prune merged remote branches on GitLab so only live branches move.
- [ ] **Step 2:** `gh repo create Silicon-Valley-Bicycle-Coalition/monday-workers --public --disable-wiki --description "SVBC's Cloudflare Workers for the Salesforce → Monday.com migration (MIT)"`. Before pushing: `gh api -X PATCH repos/Silicon-Valley-Bicycle-Coalition/monday-workers -F security_and_analysis[secret_scanning][status]=enabled -F security_and_analysis[secret_scanning_push_protection][status]=enabled`; enable Dependabot alerts (`gh api -X PUT …/vulnerability-alerts`).
- [ ] **Step 3:** Re-mirror (picks up Step 1 merges), re-run Task 5 Step 3 on the new commits only, push heads+tags as in Task 4 Step 3. Verify `ls-remote` parity.
- [ ] **Step 4:** Cutover commit on a branch: `node scripts/rewrite-gitlab-refs.mjs --project silicon-valley-bicycle-coalition/svbc-monday-workers --max-issue 127 --max-mr 509 --write` (re-check 127 / 509 against the current highest iids), review the full diff, `git rm .gitlab-ci.yml`, add the README legend (as Task 4 Step 4) and switch README/CLAUDE.md/DEPLOY.md links from GitLab to GitHub. README sandbox setup: replace the GitLab Protected/Masked-variable instructions with the GitHub `sandbox` environment secret, restricted to `main`. Re-wrap `CLAUDE.md` lines that the rewrite pushed past ~100 columns. Revert the `#4` and `#10` rewrites on `donation-rollups/README.md:1461` (gotcha numbers, not GitLab refs), and skim the dry run's single-digit refs for other numbering. Open the first GitHub PR. Expected: `checks` green, `workers` runs every changed Worker and `ci-ok` green.
- [ ] **Step 5:** Ruleset on `main`: `gh api -X POST repos/Silicon-Valley-Bicycle-Coalition/monday-workers/rulesets` with target `branch`, include `~DEFAULT_BRANCH`, rules `pull_request` (0 approvals — David is the only reviewer), `required_status_checks` [`ci-ok`, `checks`], `non_fast_forward`, `deletion`. Actions settings: fork PR workflows require approval for first-time contributors; default `GITHUB_TOKEN` read-only. Create environment `sandbox` (no secret yet — the deploy job stays inert, as today). Merge the PR.
- [ ] **Step 6:** Issues: run Task 2's copier for monday-workers from the primary `monday-workers` checkout (`--max-issue <N> --max-mr <N>` as in Task 4); **read the review file for donor/staff personal data before `--confirm`** — redact in the GitHub issue body (keep the detail on GitLab) where needed. Verify 9 issues, idempotent rerun.
- [ ] **Step 7:** `git remote set-url origin git@github.com:Silicon-Valley-Bicycle-Coalition/monday-workers.git`; `git fetch --prune`; set each live worktree branch's upstream (`git branch -u origin/<b> <b>`) where the branch was pushed. Lift the freeze. **Before any carried-over branch gets a GitHub PR**, for every branch run `git log main..<branch> --format=%B | grep -inE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?):? +#[0-9]'` and reword each hit: a closing keyword followed by a GitLab number would close a different GitHub issue on merge.

### Task 7: Workers Builds and Claude app (operator, Cloudflare + GitHub dashboards)

- [ ] **Step 1:** Install the Cloudflare Workers & Pages GitHub app on the org, repo access `monday-workers` only.
- [ ] **Step 2:** For `svbc-calendars`: Workers & Pages → Settings → Build → disconnect GitLab, connect GitHub `monday-workers`, root `/svbc-calendars`, branch `main`, non-production branch builds **off**, same build/deploy commands as before (record them first). Merge a no-op change under `svbc-calendars/` — Expected: a build from the GitHub commit SHA deploys, and `curl -sI https://events.bikesiliconvalley.org/` returns 200.
- [ ] **Step 3:** Same for `monday-backup` (root `/monday-backup`, watch path `monday-backup/*`, `main` only, previews off); verify with a no-op change and the next cron run's log.
- [ ] **Step 4:** List every Worker on the SVBC account and its build settings (`mcp` workers list or dashboard); any other GitLab-connected Worker gets the same treatment. Record the final list in the root README's "Deploys" section.
- [ ] **Step 5:** Install the Claude GitHub app on the org for both repos (`claude` → `/install-github-app`, or github.com/apps/claude). Open a test issue in monday-migration mentioning `@claude` — Expected: a reply. Close it.

### Task 8: Local move and cleanup (operator, this Mac)

- [ ] **Step 1:** For each repo, `git worktree list`; for every worktree whose branch is in `git branch --merged main` (re-checked, not assumed), run the ignored-files check, copy out anything irreplaceable, then `git worktree remove` + `git branch -d`. Unmerged worktrees stay. For every branch carried over, run `git log main..<branch> --format=%B | grep -inE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?):? +#[0-9]'` and reword any hit before opening a GitHub PR (a closing keyword plus a GitLab number would close a different GitHub issue). (If Task 5 rewrote history, re-clone instead and recreate only the unmerged worktrees.)
- [ ] **Step 2:** Quit every Claude Code session in the workspace. `mkdir -p ~/Developer/github.com && mv ~/Developer/gitlab.com/silicon-valley-bicycle-coalition ~/Developer/github.com/`.
- [ ] **Step 3:** `git -C ~/Developer/github.com/silicon-valley-bicycle-coalition/monday-workers worktree repair $(…every remaining worktree path…)`, same for monday-migration. Expected: `git worktree list` shows new paths, `git status` works in each.
- [ ] **Step 4:** For each `~/.claude/projects/-Users-dwk-Developer-gitlab-com-silicon-valley-bicycle-coalition*` folder that contains `memory/`, copy it to the matching `-github-com-` name. Update memory files that name GitLab: `gitlab-close-pattern-negation` (rewrite for GitHub: `Refs #N` still safe, `Fixes/Closes #N` closes), `sandbox-blocks-worker-tests-and-glab` (now `gh`), and the parent workspace `CLAUDE.md` (paths, "MR lands on GitLab").
- [ ] **Step 5:** Open a new Claude Code session in the new monday-workers path — Expected: CLAUDE.md and memory load.

### Task 9: Archive GitLab and close the ticket (operator)

- [ ] **Step 1:** Wait one working week of normal use on GitHub.
- [ ] **Step 2:** On both GitLab projects: set description to `Moved to https://github.com/Silicon-Valley-Bicycle-Coalition/<repo>`, disable CI/CD, archive (Settings → General → Advanced → Archive).
- [ ] **Step 3:** Apply for GitHub for Nonprofits (separately; not blocking).
- [ ] **Step 4:** Post an update on IT Requests item 13456610373 with both GitHub URLs and the audit result; set status Done.
