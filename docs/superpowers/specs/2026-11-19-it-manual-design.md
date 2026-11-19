# IT technical manual — design

Date: 2026-11-19. Status: draft for approval.

## Intent

SVBC needs one manual that lets a qualified IT professional who did not build this system take
it over: diagnose failures, operate it day to day, and extend it as needs come up. The reader
has full access (GitHub, Cloudflare, Monday admin, the third-party consoles) and may change code.

The source of truth is Markdown in this repo. A PDF built from it is published to Box for staff
and for the IT person's first read.

## Goals

- A reader with general web/IT experience but no Cloudflare Workers or Monday API background can
  find, from a symptom ("donations stopped appearing", "the portal shows 503", "a Slack alert
  fired"), the Worker responsible, where to look, and what to do.
- The same reader can make and ship a code change safely: local dev, sandbox, tests, CI, deploy,
  write switch.
- The same reader can add a new Worker or a new integration following the repo's conventions.
- Per-Worker infrastructure facts (names, routes, crons, queues, D1, KV, R2, bindings) cannot go
  stale, because they are generated from `wrangler*.jsonc`.
- A PDF in Box says which commit and date it was built from, and every repo reference in it is a
  clickable GitHub URL pinned to that commit.

## Non-goals

- Replacing the per-Worker READMEs, runbooks, specs or UAT scripts. The manual is the stable
  layer on top; it links into them for detail and history.
- Current deploy status. The root README's "Status at a glance" table stays the record; the
  manual says how things work, not what happened when.
- Staff (non-IT) how-to for using Monday boards. `docs/uat/` and staff guides cover that.
- Monday board-by-board schema documentation beyond what a Worker reads or writes.

## Anti-goals

- **Anything that must not be public.** The repo is public (MIT). The manual names roles
  ("Cloudflare Super Administrator", "Monday account admin", "SVBC Integration user"), never
  people, personal email addresses, phone numbers, or secret values. Who holds each role, and
  where secret values are kept, goes in a private appendix in `monday-migration` (below).
- A second copy of README prose that drifts. Where a fact already lives in a README, the manual
  summarises in a sentence and links, rather than restating paragraphs.
- New npm dependencies at the repo root. The build follows `scripts/`' convention:
  dependency-free `.mjs` with `node:test` tests beside it.

## Constraints

- No root `package.json`; scripts are plain Node 22.18+ ESM.
- Pandoc is available locally (`/usr/local/bin/pandoc`); no LaTeX/typst/weasyprint PDF engine is.
  Google Chrome is installed. CI (`ubuntu-latest`) has neither pandoc nor Chrome by default.
- Visual design follows `docs/design-system/` (`tokens.json`, README). Fonts are self-hosted;
  never link Google Fonts.
- Log safety and the public-repo rule apply to anything committed.

## Approaches considered

| Approach | Trade-off | Outcome |
|---|---|---|
| A. One long Markdown file → PDF | Simplest; becomes a 3,000-line file nobody edits alongside code, so it drifts | Rejected |
| B. One file per chapter + build script → PDF | Per-Worker chapters can change in the same PR as the Worker; pinned GitHub links, version stamp on the cover | Base of the chosen design |
| C. B + a generated per-Worker reference appendix + a CI coverage check | ~200 more lines of script and tests; the most-consulted troubleshooting facts can't go stale, and a new Worker can't ship without a chapter | **Chosen** (DWK, 2026-11-19) |

## Design

### Layout

```
docs/manual/
  README.md                  how the manual is organised, how to build and publish it
  00-about.md                audience, how to read it, conventions, what's public vs private
  01-system-overview.md      what SVBC runs and why; systems diagram; upstream/downstream services
  02-architecture.md         shared patterns: webhook → D1 → Queue → consumer; cron cursor
                             invariant; config-not-hardcoding; copied-not-shared modules
                             (graphql.ts, outage.ts, flags.ts, mondayJwt.ts, employerName.ts,
                             geometry.ts); Monday API version pin
  03-accounts-and-access.md  every external account and console by role: Cloudflare (account,
                             zone, Access, WAF/SBFM rule), GitHub (org, ruleset, Actions),
                             Monday (integration users, three OAuth apps per environment,
                             broker), Funraise, Eventbrite, Mailchimp, Double the Donation,
                             Benevity, Google (Shared Drive, service account), Slack; least
                             privilege and the GL#18 caveat; secret rotation
  04-environments.md         production vs sandbox; config/sandbox.json selection; split tests;
                             what "sandbox" can and can't reach
  05-development.md          clone, hooks, worktrees, per-Worker commands, typecheck rule, tests,
                             local dev, .dev.vars, Node type stripping for .mjs scripts
  06-ci-and-deploy.md        checks.yml and workers.yml, required checks, which Workers CI
                             deploys (sandbox) vs by hand (production), Workers Builds
                             (svbc-calendars, monday-backup), D1 migrations, deploy order
  07-operations.md           the write switch and flags.mjs; queues, DLQs and re-driving;
                             observability (Workers Logs, Workers Issues, wrangler tail);
                             sync-watchdog and Slack alerts; backups and restore; periodic
                             chores (Monday API version bump, token scope check, member list
                             review, read-only column markers, donation form check)
  08-troubleshooting.md      by symptom: each entry = symptom, likely Worker(s), first checks,
                             fixes, link to deeper runbook
  09-extending.md            adding a Worker (checklist: workers.json, sandbox env, split test,
                             flags, broker binding, rate limiter namespace, copies rosters,
                             MARKED_COLUMNS, manual chapter); adding a column/board; adding an
                             integration; forking for another org
  workers/<dir>.md           one chapter per entry in .github/workers.json (member-portal's
                             writer config is a section of member-portal.md); see template
  reference/                 GENERATED, gitignored; built into the PDF as Appendix A
  glossary.md                Monday, Cloudflare and SVBC terms (board, item, column id, D1,
                             queue, DLQ, binding, entrypoint, write switch, Main board, …)
```

PDF order: Part I is 00–07, Part II is `workers/*` (alphabetical), Part III is 08–09, then the
glossary and the generated appendix. The build script owns the order (a list in the script, not
filename magic), so moving a chapter is one edit; the two-digit prefixes only keep the directory
listing readable.

### Worker chapter template

Each `docs/manual/workers/<dir>.md` uses the same headings so a reader knows where to look:

1. **What it does** — two or three sentences, in staff terms.
2. **Trigger and data flow** — webhook / cron / queue / RPC; source → D1 → queue → Monday.
3. **Monday boards and columns it touches** — by bare title, read vs write; where the ids live
   (`config/svbc.json`, `config/sandbox.json`).
4. **Secrets** — names only, what each is for, where it's issued (which console), how to rotate.
   (Wrangler config doesn't declare secrets, so this is hand-written.)
5. **Write switch behaviour** — `on` / `hold` / `off` specifics, or "no write switch".
6. **Failure modes** — what breaks, how it shows (Slack alert, Workers Issue, DLQ backlog, staff
   report), what to do.
7. **Operator scripts** — the Worker's `scripts/*.mjs` and when to use them.
8. **Changing it** — the files that matter, gotchas, tests to run.
9. **Further reading** — README sections, runbooks, design specs, UAT script.

A line at the top links to the Worker's generated reference entry. Target length: 1–3 pages.

### Generated reference appendix

`scripts/manual-reference.mjs` reads every `wrangler*.jsonc` listed (directly or by default
name) in `.github/workers.json`, plus `member-portal/wrangler.writer.jsonc`, and writes
`docs/manual/reference/<dir>.md`. Per Worker and per environment (top level = production,
`env.sandbox` = sandbox), a table of:

- Worker name, `main`, compatibility date, `limits.cpu_ms`
- routes and custom domains (`routes`, `route`), `workers_dev`, `preview_urls`
- cron triggers
- queues: producers (queue → binding), consumers (queue, `max_retries`, `retry_delay`,
  `max_concurrency`, `max_batch_size`, `dead_letter_queue`)
- D1 (binding → database name), KV (binding, and which FLAGS namespace), R2 (binding → bucket)
- service bindings (binding → service, entrypoint), workflows, `send_email` (binding, allowed
  destinations), rate limiters (name, namespace id, limit/period)
- `vars` names (values only for non-secret, short scalars such as `ENVIRONMENT`)
- observability on/off
- write-switch key (`<dir>:writes`) when the Worker is `IN_SCOPE` in
  `scripts/check-worker-flags.mjs`, imported rather than duplicated

For the two CLIs without Wrangler config (`salesforce-import`, `geo-filter`) it emits a stub
saying so. JSONC parsing: a small comment/trailing-comma stripper that respects strings, with
tests on real configs (every config in the repo must parse). The script also has a `--check`
mode used in CI (below).

Account id, KV ids and D1 ids are already public in the configs; the appendix may show them.

### Coverage check (CI)

`scripts/check-manual.mjs` (in `checks.yml`, its own step):

- every `dir` in `.github/workers.json` has `docs/manual/workers/<dir>.md`, and every file there
  matches a `dir` (no orphans);
- each Worker chapter has the nine template headings;
- relative links in `docs/manual/**/*.md` resolve to files that exist in the repo;
- `manual-reference.mjs --check` parses every listed config without error.

It does not run pandoc or Chrome, so CI needs no new tooling.

### PDF build

`scripts/build-manual.mjs` (operator tool, run on a Mac or anywhere with pandoc + Chrome):

1. Run the reference generator.
2. Concatenate chapters in the scripted order with Part/Appendix dividers.
3. Rewrite repo-relative links to `https://github.com/Silicon-Valley-Bicycle-Coalition/monday-workers/blob/<sha>/<path>`
   (`tree/` for directories), using `git rev-parse HEAD`; refuse to build from a dirty tree
   unless `--allow-dirty` (then the cover says "uncommitted changes"). Links between manual
   chapters become in-document anchors instead.
4. `pandoc` → standalone HTML with a generated table of contents and a print stylesheet
   (`docs/manual/print.css`) built from `tokens.json` colours and the self-hosted fonts.
   Code blocks wrap; tables stay inside the page; page breaks before each chapter.
5. Headless Chrome `--print-to-pdf` (path found via a short list of known locations or
   `CHROME_PATH`), with header/footer: manual title, chapter, page number, and
   "Built <date> from <short sha>".
6. Output `dist/svbc-it-manual-<date>-<sha>.pdf` (gitignored).

Publishing to Box is a manual step documented in `docs/manual/README.md`: upload as a new
version of the same Box file so the link stays stable, alongside the private appendix PDF.

### Private appendix

`monday-migration/docs/it-manual-private-appendix.md` (private repo): named holders of each role
from chapter 3, contact details, where each secret value is kept (1Password vault / `.env*`
files), account recovery paths, vendor account numbers. Built to PDF with the same script
(`--input` flag) and stored beside the main PDF in a restricted Box folder. The public manual
says this appendix exists and what it contains, without the contents.

### Diagrams

The system overview reuses the content of `docs/systems-map.html` as a Mermaid or static SVG
figure. Mermaid would need a renderer at build time; to avoid one, diagrams are hand-written SVG
in `docs/manual/figures/`, inlined by pandoc.

## Decided by DWK

- Audience: a qualified IT professional with full access who may change code.
- Approach C.
- Source of truth in this repo; published as a PDF in Box.

## Calls made by Claude (open to correction)

- Role names only in the public manual; named people and secret locations in a private appendix
  in `monday-migration`.
- The manual excludes dated deploy status and points to the root README for it.
- PDF via pandoc → HTML → headless Chrome, not a LaTeX engine, to avoid a new toolchain.
- CI checks coverage and links but does not build the PDF.
- Hand-written SVG diagrams rather than Mermaid.
- **Delivery:** one PR, built in order: tooling and its tests first, then core chapters, then
  every Worker chapter. `check-manual.mjs` joins `checks.yml` in the same PR, so it passes when
  the PR is complete; no report-only phase.
- **Facts not in the repo:** secret names come from each Worker's source (`Env` types, README
  "Secrets" sections) cross-checked against `npx wrangler secret list` (names only, read-only) for
  both environments. Anything that can't be confirmed from the repo or that command (console
  menus, recovery paths, vendor-side settings) is written as best known and marked
  **To verify** in the text, and listed in `docs/manual/README.md` so IT can close them out.
- **Private appendix:** this plan delivers a template with headings and blanks
  (`monday-migration/docs/it-manual-private-appendix.md`, in its own branch and PR there);
  SVBC fills in names, vault locations and account numbers.
- **PDF engine details:** Chrome is driven over the DevTools protocol (`Page.printToPDF`) with a
  hand-written client on Node's built-in `WebSocket`, so header/footer templates work. The
  running header shows the manual title, not the chapter (Chrome's templates can't know it);
  the footer shows page number and build stamp. The table of contents is linked but carries no
  page numbers; `generateDocumentOutline` gives the PDF a bookmark outline instead.
- **Roster:** the chapter roster is `.github/workers.json`. `sponsor-outreach` (requirements
  and a setup script only, not on the roster) gets a paragraph in the system overview, not a
  chapter.
- **Fonts:** `build-manual.mjs` reads the base64 fonts out of an existing generated
  `fontData.ts` module (`member-portal`'s) and writes `@font-face` rules with data URIs into the
  HTML; no font files are committed and nothing is fetched.

## Left to the builder

- Exact print CSS, cover page design, and figure styling within the design system.
- Troubleshooting entries beyond an initial set drawn from the runbooks, READMEs' "operational
  findings" sections, and `sync-alerting.md`.
- Glossary contents.
