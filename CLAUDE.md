# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SVBC's Cloudflare Workers, one subdirectory per Worker, built for the Salesforce → Monday.com CRM
migration and for post-migration integrations. Open-sourced (MIT) so other nonprofits can fork and
redeploy against their own Monday.com/CRM setup — see the root `README.md` for the shared-stack,
least-privilege-token, and webhook-reliability conventions that apply across every Worker, and its
"Status at a glance" table for what's built, deployed, or pending.

Each Worker's own `README.md` is the spec for it (ask, data flow, APIs/auth, Monday targets, build
shape, open questions) and is meant to be buildable standalone. References there to
`migration-plan.md` or `docs/*` point at the private planning repo (`monday-migration`, checked
out alongside this one) — not published, not required to build the Worker.

**There is no root-level Worker code** — each Worker is self-contained in its own subdirectory,
and every one now holds a full implementation. The root-level exception is `scripts/`:
dependency-free `.mjs` files with `node:test` tests beside them (the `log-safety` step of `.github/workflows/checks.yml` runs
both the tests and the check below).

CI is GitHub Actions: `.github/workflows/checks.yml` (one `checks` job: the copy rosters and the
checks below) and `.github/workflows/workers.yml` (per-Worker test matrix and sandbox deploys, from
the roster in `.github/workers.json`; `scripts/ci-changed-workers.mjs` picks what changed and fails
when a Worker directory isn't listed). `ci-ok` and `checks` are the required checks on `main`.

- CI checks: `check-log-safety.mjs` fails on `console.*()` calls that could log an email address
  (the pre-commit hook also runs it with `--staged`; by hand, `node scripts/check-log-safety.mjs`),
  `check-worker-flags.mjs`, `check-monday-auth-bindings.mjs` and `check-rate-limit-namespaces.mjs`
  (every `ratelimits[].namespace_id` unique across `wrangler*.jsonc`; GL#113).
- Operator tools, not CI checks: `flags.mjs`, `mark-read-only-columns.mjs`,
  `check-donation-form.mjs`, `check-monday-token-scope.mjs` (which workspaces a Monday token can
  really reach, GL#18), `make-boards-private.mjs`, `windfall-board.mjs` (runbook:
  `docs/runbooks/windfall-private-board.md`), `funding-leads-board.mjs` (sandbox-only Funding
  Leads board build, Pledged→Deal conversion and seed; runbook: `docs/runbooks/funding-leads-board.md`), `propose-partner-types.mjs` and `build-font-modules.mjs` (regenerates the self-hosted Nunito Sans `fontData.ts` in `member-portal` and `svbc-calendars` from pinned Fontsource packages, GL#123).

`svbc-calendars` (Eventbrite widget + committee/event ICS calendar feeds) is outside the migration
scope: it predates this repo and serves the public bikesiliconvalley.org website directly. It has
its own `CLAUDE.md`, and the conventions below about the sandbox environment, the write switch and
Monday access don't apply to it. The same goes for `svbc-bike-lanes`, the staff-only bike lane
tracker at lanes.bikesiliconvalley.org: an Eleventy site deployed as a static-assets-only Worker by
its own workflow (`.github/workflows/svbc-bike-lanes.yml`, weekly), whose history lives on the
`svbc-bike-lanes-history` branch rather than `main`.

## Concurrency — default to a worktree

One topic, one branch, one worktree. For a new Worker, or a change of any real size to an existing
one, don't edit the primary `monday-workers` checkout. Claude Code sessions use the `EnterWorktree`
tool (worktrees land under `.claude/worktrees/`); by hand:

```sh
git worktree add ../monday-workers-<short-topic> -b feat/<topic>
```

Before starting, `git worktree list` to see what's already checked out. Work in the worktree,
commit there, and open the MR from that branch. Once the MR merges to `main`, remove the worktree
and delete the local branch — see the parent workspace `CLAUDE.md`'s "Worktree cleanup" section
for the exact commands, including the check for irreplaceable gitignored files.

**A worktree holds exactly one active agent, ever — never fan multiple agents into the same
one.** Two real collisions are behind this. On 2026-08-25 a session dispatched review fixes to
sub-sessions that shared its `cwd`: one agent's interface change broke another's passing tests
mid-task, and one commit absorbed another session's uncommitted edit. On 2026-09-20/21 two
separate sessions committed feature branches in the primary checkout, and an MR merged to `main`
with the other session's unrelated commit attached.

- **Default:** do the fixes yourself, one at a time, in the one worktree you have — commit after
  each before starting the next.
- **Parallel sub-agents only when the fixes are truly independent and worth the overhead:** git
  can't check out one branch in two directories, so give each agent its own worktree on its own
  throwaway branch off the feature branch (`git worktree add ../monday-workers-<topic>-fix-<n> -b
  fix/<topic>-<n> feat/<topic>`), then merge or cherry-pick each fix branch back **sequentially**
  yourself and remove the temp worktrees and branches.
- Never pass your own `cwd` to a spawned sub-agent that's going to edit files. If you can't give
  it an isolated worktree, do the edit inline instead.

`.githooks/pre-commit` backs this up: from the primary checkout it refuses `git commit` on any
branch other than `main` (linked worktrees are unaffected), after first running the log-safety
check on staged Worker source in every checkout. Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

Bypass for a genuine one-line fix with `git commit --no-verify`. The hook is a backstop, not a
substitute for reaching for `EnterWorktree` first.

## Commands

There's no root `package.json` — every command runs from inside a Worker's own subdirectory
(`cd funraise-sync`, etc.), each with its own `package.json`, `wrangler.jsonc`, and lockfile.

For a Worker built on the standard Hono + D1 stack (e.g. `funraise-sync`, `mailchimp-sync`):

```sh
npm test                    # vitest run
npm test -- path/to/file.test.ts   # single test file
npm test -- -t "test name"         # single test by name
npm run typecheck           # wrangler types --include-runtime=false && tsc --noEmit
npm run dev                 # wrangler dev — local Worker + D1 + queue simulation
npm run deploy               # wrangler deploy
npm run deploy:sandbox       # wrangler deploy --env sandbox — every migration Worker has an env.sandbox block
npm run dev:sandbox          # wrangler dev --env sandbox — local dev against the sandbox config; plain `npm run dev` is production and writes to production sinks once .dev.vars holds real secrets
```

Always type-check a Worker with `npm run typecheck`, never a bare `tsc --noEmit`: binding types
(`DB`, queues, `REQUEST_RATE_LIMITER`, …) live in `worker-configuration.d.ts`, which `wrangler
types` regenerates from `wrangler.jsonc` and which is gitignored (it can absorb local `.dev.vars`
names). A bare `tsc` reads whatever copy is on disk — missing on a fresh clone, stale after a
binding is added — and fails on binding names that say nothing about the code. (`monday-backup`'s
script also type-checks `tsconfig.scripts.json`.) The two non-Worker CLIs, `salesforce-import`
and `geo-filter`, have no Wrangler config, so theirs is a plain `tsc --noEmit`.

`salesforce-import` is a one-time batch CLI, not a deployed Worker, so it has no `dev`/`deploy`
scripts — instead:

```sh
npm run cli -- extract      # each pipeline stage is its own subcommand
npm run cli -- geocode
npm run cli -- transform
npm run cli -- load
npm run cli -- validate
npm test
npm run typecheck
```

## Architecture

**Webhook-driven Workers** (`funraise-sync` is the reference) share one shape: a Hono route
validates and dedupes the incoming event into D1 (the idempotency store), then enqueues a message
to a Cloudflare Queue producer. A separate queue consumer (the Worker's exported `queue()`
handler) performs the actual Monday.com write. Queues retry on failure with an outage-tolerant
policy (below) and route to a dead-letter queue once exhausted, so a failed write becomes a
visible, replayable backlog instead of a silently dropped donation. D1 status here means
"ingested," not "written" — the queue is what makes the write durable.

**A cron-polled Worker** doesn't need a queue — a failed poll self-heals on the next scheduled run.
The one invariant that matters: the D1 "last processed" cursor must only advance *after* a
confirmed Monday write, never before, or a failed run silently skips what it should have processed
with nothing to retry it. `people-reclassification` is the example: its D1 `moves` row goes to
`moved` only after Monday confirms the move. `contact-roles` is the stateless case: its cron
recomputes every `Contacts` column each run, so it needs no cursor.

**`salesforce-import` is a one-time batch job**, not an ongoing sync, so it uses neither pattern.
It's a self-registering CLI (`src/commands.ts` holds a `registerCommand` map; each pipeline stage
module calls it on import) implementing a five-stage pipeline — extract → geocode → transform →
load → validate — with retry-with-backoff on individual Monday writes and a resumable ledger
instead of a queue.

**Config, not hardcoding:** SVBC-specific values (board IDs, field names, city lists) live in each
Worker's `config/*.json`, validated at startup. Keep new SVBC-specific values there rather than in
source — the goal is that another org's fork is a config change, not a rewrite.

**Visual design:** `docs/design-system/` (brand basis: the 2026 letterhead and SVBC's print; `svbc-gold`
#FFC20E for screens, `svbc-gold-soft` for letterhead documents; Nunito Sans self-hosted as the web
face). Take colours, type,
spacing and component patterns for any Worker page or email from its `tokens.json` and README,
not from older Worker code. Fonts are self-hosted (`scripts/build-font-modules.mjs`); never link
Google Fonts from a Worker page.

**Read-only column markers: match titles with `bareTitle`.** Staff-facing column titles carry 🔒
(a Worker writes it) or 📜 (Salesforce history, loaded once) so staff don't edit them, applied by
`scripts/mark-read-only-columns.mjs`, whose `MARKED_COLUMNS` is the list. Code and config always
name the *bare* title. Anything that finds a Monday column by title must compare through
`bareTitle` from `scripts/lib/column-titles.mjs`, never `c.title === title`. Otherwise a marked
column reads as missing, and an idempotent setup script creates a duplicate under the bare title.
A Worker that imports the module adds `scripts/lib/**` to its `extraPaths` in `.github/workers.json`, as `monday-auth` does.
When a Worker starts writing a new column, add it to `MARKED_COLUMNS` and re-run the script.

**A column added to People also goes on People (Historical).** Same title and type, and for a status
the same label ids. `people-reclassification` refuses every move while the boards differ. That stopped
its daily run from 2026-11-20, after three Workers' rollouts added columns to People alone. After adding a column
to either board, run `node scripts/match-people-columns.mjs --config config/<env>.json` from
`people-reclassification/` (`--apply` creates what's missing).

**The staff "Enter a gift" form shows every Donations column unless hidden.** A Monday form view
lists all of its board's columns, visible by default, so a column a Worker adds later (a new 🔒
rollup, an integration id, `contact-roles`' `Contacts`) appears on the form and staff can overwrite it. A new form view also
defaults to public, with "Require login" off. When you add a column to the Donations board, or
create a form view, hide the new question in the form editor and run
`node scripts/check-donation-form.mjs --form <token>` (token from the share link; production
`567223ac739c23567e56e9057d81dbf5`, sandbox v4 `2325fd7745d3a2d425086d38358e4bd5`). The visible
set is `EXPECTED_QUESTIONS` in `scripts/lib/donation-form.mjs`. After changing the
Donations board's automations or the rollups, `scripts/smoke-donation-entry.mjs --board <sandbox
Donations id> --donor <sandbox People item id> [--rollups]` creates the items the form creates,
checks Tier, Status and the donor link (and, with `--rollups`, that Lifetime Giving moves), and
deletes them; it refuses any board not named sandbox. Design:
`docs/superpowers/specs/2026-11-11-manual-donation-entry-form-design.md`.

**Sandbox environment — inbound only, no outbound data.** Every deployed Worker except
`svbc-calendars` (whose `env.sandbox` is unrelated: it isolates the cache and analytics) carries a
`sandbox` Wrangler environment, the `member-portal` writer (`wrangler.writer.jsonc`) included:
`env.sandbox` with its own name, D1, queues, secrets and vars, plus a `config/sandbox.json` chosen
at request time by `env.ENVIRONMENT` (`src/environment.ts`). Two vary: `monday-backup`'s file is
`config/backup.sandbox.json`, and `monday-auth` has no config directory. Outbound sinks are
locked at the platform where possible (the `send_email` binding's
`allowed_destination_addresses`) and by a per-Worker `config/split.test.ts` that fails if the two
configs ever share a sink or an id. When adding the environment to another Worker, copy
`member-portal`'s `environment.ts`, split test, and `env.sandbox` shape rather than re-deriving
them. Design: `docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.

**Write switch (off / hold / on), per Worker, in the shared `FLAGS` KV namespace** (`<worker>:writes`;
missing key or any other value = `off`, KV read error = `unknown`, which acts like `hold`). The
Workers that carry it are `IN_SCOPE` in `scripts/check-worker-flags.mjs`; `svbc-calendars`,
`monday-auth`, `member-map` (which only reads Monday) and `sync-watchdog` (which only reads
`FLAGS` and posts to Slack) don't. `member-portal/src/flags.ts` is
canonical; every other in-scope Worker holds a byte-identical `src/flags.ts`, enforced by the
`worker-flags-copies` step of `checks.yml` (`node scripts/check-worker-flags.mjs --strict`, which also checks the
FLAGS KV ids match across `wrangler.jsonc` files). Same rule as `graphql.ts`: edit the canonical
file, copy it over the rest, never edit a copy; it must stay strip-only TypeScript (no enums,
namespaces, constructor parameter properties). Operator CLI: `scripts/flags.mjs` (`<worker|all>
writes on|hold|off`, `log debug|normal`, `status`, `retention`, all with `--env`). Reads are
`cacheTtl: 30`, once per request/batch/cron run. Set `<worker>:writes on` **before** deploying a
build that reads the switch, or a Worker that should write defaults to `off`. Namespaces: `FLAGS`
and `sandbox-FLAGS`. Runbook, including each Worker's behavior under `hold`:
`docs/runbooks/migration-hold.md`.

- **Cursor invariant exception under `off`:** a cron-polled Worker's D1 cursor normally advances
  only after a confirmed Monday write; under `off` a poller dry-runs and its cursor
  **advances**, so what it would have written is skipped for good, deliberately; recompute and
  maintenance crons compute and log but don't write. Under `hold`/`unknown` crons skip and cursors
  stay put, so the first `on` run walks everything since the hold began. Work ingested under `off`
  is stamped `dropped` on the queue message and stays a dry run if consumed after a flip to `on`;
  an unstamped message (enqueued before the switch existed) is live. Dry-run chained writes
  persist no placeholder ids. Leave `hold` with `on`; `hold` to `off` drops held messages.
- **Outage retry policy:** delay `min(60 x 2^(attempts-1), 3600)` s, raised to any longer hint
  (Retry-After, midnight for a daily limit; hinted case capped at 43,200 s), `max_retries: 100` on
  main queues (~4 days) with `retry_delay: 60` as the floor for a whole-batch redelivery (a throw
  from `queue()` carries no delay of its own), DLQ consumers at 2; queue and DLQ retention 14
  days, set by `flags.mjs retention` rather than `wrangler.jsonc`. Retryable/terminal
  classification stays per Worker.
- Not everything queues under a hold: `bp-feedback-notify` (no queue) and `benevity-import`'s
  routes return 503 under `hold`/`unknown`, `monday-backup` skips the run unless `on`, and
  `report-digests` dry-runs its sends under `off` and skips the hour under `hold`/`unknown` (no
  catch-up; resend by hand).

**One Monday GraphQL transport, copied, not shared (GL#35):** `monday-backup/src/monday/graphql.ts`
is the canonical transport (429/Retry-After, complexity budget, 5xx, timeouts, non-idempotent
writes). Workers that use it carry a byte-identical copy at `src/monday/graphql.ts` and tune it
through constructor options in their own `client.ts`, never by editing the copy. The
`monday-graphql-copies` step of `checks.yml` fails on drift, and its `for copy in …` list is the roster: edit
the canonical file, copy it to every path listed, and add a Worker's path there when moving it
over. `nearby-search` also carries a byte-identical copy of `geo-filter/src/geometry.ts` (the
corridor and point logic), enforced by the `geo-geometry-copies` step of `checks.yml`; edit geo-filter's, then
copy it over.

- `salesforce-import` deliberately keeps its own client (`src/load/monday.ts`): it's the one every
  load rehearsal validated, its `gqlPartial()` (per-alias results from multi-create requests) has
  no transport equivalent, and `gqlLegacy()` must stay verbatim for `load --sequential`. Revisit
  only if the import runs again; until then port any new failure mode between the two by hand.
- `employerName.ts` follows the same copy model: canonical at `member-portal/src/changeRequests/employerName.ts`,
  byte-identical copy at `impact-attribution/src/employerName.ts`, held by the `employer-name-copies` CI
  job. Edit member-portal's, then copy it over; strip-only TypeScript.
- A Worker's `.mjs` scripts import that Worker's copy directly (`import { MondayGraphQL } from
  '../src/monday/graphql.ts'`) through Node's built-in type stripping (Node 22.18+ / 23.6+), so
  the file must stay strip-only-compatible — no constructor parameter properties, enums or
  namespaces.
- Queue Workers run it with 3 in-process attempts and leave longer waits to their queue backoff;
  geo-filter, a local CLI, uses the transport's defaults. member-portal runs it with
  `maxAttempts: 1`: its calls mostly render a donor's page, where a multi-second backoff is worse
  than a fast error the donor can reload past.
- Everything the transport throws is a `MondayApiError` (`httpStatus`, `code`,
  `retryAfterSeconds`), so a queue consumer can pick its delay from the failure.
- Queue consumers stop calling Monday for the rest of a batch once one message fails on an
  outage (429, 5xx, timeout, spent budget or daily limit) and retry the rest with backoff (GL#101).
  The breaker is `funraise-sync/src/monday/outage.ts`, copied byte-identical like `graphql.ts`;
  the `monday-outage-copies` step of `checks.yml` holds the roster. A new queue Worker copies it in.

**Monday API tokens are least-privilege by design:** a Worker gets Monday access from the
`monday-auth` broker, not from a token of its own. One integration user (SVBC Integration; Sandbox
Integration in the sandbox) authorizes three OAuth apps (Portal, Staff sync, Read-only, each
environment with its own set), the broker holds the tokens, and a Worker's `MONDAY_AUTH` service
binding picks its app by entrypoint (`PortalToken`, `SyncToken`, `ReadOnlyToken`; the
`monday-auth-bindings` step of `checks.yml` checks the mapping). New Workers bind an entrypoint instead of
adding a `MONDAY_API_TOKEN` secret; never use a staff member's personal token. Leftovers from the
OAuth cutover: most Workers' `Env` types still declare an optional `MONDAY_API_TOKEN`, which
the transport's `tokenProviderFor()` uses only when the `MONDAY_AUTH` binding is missing (don't add
new uses). No deployed Worker has that secret set (the last copies were deleted 2026-11-19), and
operator scripts such as `monday-backup`'s restore CLI and `check-donation-form.mjs` read one from
the operator's shell. One user is not a scoped one (GL#18): any Monday team member can read and
edit every Main board in every open workspace, so "only the boards it reads" holds only for
private boards, and the internet-facing `member-portal`'s read-only token can read everything the
user can see (accepted; see the root README). Never describe a token as scoped without running
`node scripts/check-monday-token-scope.mjs --workspace <id>` against it.

**`data/` directories** (e.g. in `salesforce-import`) hold real extracted donor PII pulled from
Salesforce and are gitignored per-Worker. Never remove that ignore rule or commit real data.

## Hosting — GitHub since 2026-11-17

`github.com/Silicon-Valley-Bicycle-Coalition/monday-workers` (public). It moved from GitLab
(`silicon-valley-bicycle-coalition/svbc-monday-workers`, kept read-only as the record of closed
issues and merge requests) with history rewritten to drop personal data, so commit SHAs differ
from GitLab's. Work goes through pull requests: a ruleset on `main` requires a PR and the `ci-ok`
and `checks` status checks. `GL#NN` / `GL!NN` in tracked files are GitLab issue and MR numbers;
bare `#NN` / `!NN` in commit messages before 2026-11-17 are GitLab numbers too, not GitHub's.
