# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SVBC's Cloudflare Workers, one subdirectory per Worker, built for the Salesforce → Monday.com CRM
migration and for post-migration integrations. Open-sourced (MIT) so other nonprofits can fork and
redeploy against their own Monday.com/CRM setup — see the root `README.md` for the shared-stack,
least-privilege-token, and webhook-reliability conventions that apply across every Worker, and the
current status/priority/owner table.

Each Worker's own `README.md` is the spec for it (ask, data flow, APIs/auth, Monday targets, build
shape, open questions) and is meant to be buildable standalone. References there to
`migration-plan.md` or `docs/*` point at the private planning repo (`monday-migration`, checked
out alongside this one) — not published, not required to build the Worker.

**There is no root-level Worker code** — each Worker is self-contained in its own subdirectory.
The one root-level exception is `scripts/check-log-safety.mjs`, a dependency-free CI check (the
`log-safety` job) that fails on `console.*()` calls that could log an email address. The
pre-commit hook below also runs it (`--staged`, in every worktree); run it by hand with
`node scripts/check-log-safety.mjs`. Workers
are built one per feature branch (see the sibling worktree directories in the parent folder) and
merged to `main` once ready; most are now merged with full implementations, while a Worker whose
subdirectory holds only a `README.md` is still requirements-only. See the root `README.md`'s
"Status at a glance" table for what's built, deployed, or pending.

One Worker is an exception to the migration scope above — `svbc-calendars` (Eventbrite widget +
committee/event ICS calendar feeds) predates this repo and serves the public
bikesiliconvalley.org website directly, unrelated to the Salesforce/Monday migration. It's here
for the same reason `events-widgets` originally was: one place to deploy SVBC's Cloudflare
Workers from.

## Concurrency — default to a worktree

Workers are built one per feature branch, each in its own sibling worktree directory (e.g.
`monday-workers-si` for `feat/salesforce-import`, `monday-workers-donor-portal-v2` for
`feat/donor-portal-v2` — see the parent workspace's `CLAUDE.md`). When starting work on a new
Worker, or a change of any real size to an existing one, create a new worktree rather than editing
the primary `monday-workers` checkout directly:

```sh
git worktree add ../monday-workers-<short-topic> -b feat/<topic>
```

(Claude Code sessions: use the `EnterWorktree` tool rather than the raw command above.)

Before starting, `git worktree list` to see what's already checked out. Work in the worktree,
commit there, and open the MR from that branch. Once the MR merges to `main`, remove the worktree
and delete the local branch — see the parent workspace `CLAUDE.md`'s "Worktree cleanup" section
for the exact commands.

**A worktree holds exactly one active agent, ever — never fan multiple agents into the same
one.** Real collision on 2026-08-25: a session working `feat/membership-card` (in the sibling
worktree `.claude/worktrees/membership-card`) was fixing findings from a code review one at a
time, then started dispatching each remaining finding to its own `spawn_task` sub-session —
without giving any of them a separate worktree, so every sub-session's `cwd` pointed at the same
checkout. Up to three agents ended up editing the same files simultaneously: one session's
in-progress `CardTokenStore` interface change broke another's already-passing test file mid-task,
and a documentation commit from one session silently absorbed another session's unrelated
uncommitted edit to `README.md` (right author, wrong commit — the two sessions' work is now
tangled in one commit's history). Nothing was unrecoverable, but it easily could have been.

`git worktree` physically cannot check out one branch into two directories at once, so this isn't
solved by "give each dispatched agent its own worktree on the *same* branch" — that command
fails. Instead:

- **Default:** do the fixes yourself, one at a time, in the one worktree you have — commit after
  each before starting the next. This is almost always the right call for a punch-list of fixes
  against one feature branch; it's what made the commits *before* the incident (one fix, one
  commit, repeated) collision-free.
- **Only reach for parallel sub-agents when the fixes are truly independent and worth the
  overhead:** give each one its *own* worktree on its *own* throwaway branch off the feature
  branch (`git worktree add ../monday-workers-<topic>-fix-<n> -b fix/<topic>-<n>
  feat/<topic>`), let it commit there, then merge or cherry-pick each fix branch back into
  `feat/<topic>` **sequentially** yourself once they're done — never concurrently — and remove
  the temp worktree/branch afterward (see "Worktree cleanup" above).
- Never pass your own `cwd` to a spawned sub-agent that's going to edit files. If you can't give
  it an isolated worktree, don't dispatch it — do the edit inline instead.

**Second real collision, 2026-09-20/21, different shape:** two *separate* sessions (not one
session's sub-agents) each working a distinct topic — a `bp-feedback-notify` webhook-auth fix and
an unrelated `donation-rollups` sandbox-config remap — both skipped the worktree convention and
committed feature branches directly in the primary checkout. One session's commit landed on top of
the other's on the same branch without either noticing HEAD had moved off `main`, so a merge
request for the webhook fix ended up merged to `main` with the unrelated donation-rollups commit
still attached (harmless in this case — same diff already existed elsewhere on `main`, so it was a
no-op duplicate rather than a conflict — but only by luck).

To make this concrete instead of just documented, this repo now ships `.githooks/pre-commit`,
which refuses `git commit` for any branch other than `main` when run from the primary checkout
(linked worktrees are unaffected — hooks are shared across worktrees via the common `.git` dir, but
the hook checks `git rev-parse --git-dir` against `--git-common-dir` to tell which one it's in).
The same hook first runs the log-safety check on staged Worker source, in every checkout.
Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

Bypass for a genuine one-line fix (the exception already carved out above) with
`git commit --no-verify`. The hook is a backstop, not a substitute for reaching for `EnterWorktree`
first.

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

**Webhook-driven Workers** (`funraise-sync`, `quickbooks-sync`) share one shape: a Hono route
validates and dedupes the incoming event into
D1 (the idempotency store), then enqueues a message to a Cloudflare Queue producer. A separate
queue consumer (the Worker's exported `queue()` handler) performs the actual Monday.com write.
Queues retry automatically (3 attempts) on failure and route to a dead-letter queue once exhausted,
so a failed write becomes a visible, replayable backlog instead of a silently dropped donation.
D1 status here means "ingested," not "written" — the queue is what makes the write durable.

**A cron-polled Worker** doesn't need a queue — a failed poll self-heals on the next scheduled run.
The one invariant that matters: the D1 "last processed" cursor must only advance *after* a
confirmed Monday write, never before, or a failed run silently skips what it should have processed
with nothing to retry it. (`svbc-calendars`'s daily cron is a KV-fallback warm, not a Monday write,
so this invariant doesn't apply to it — no Worker in this repo currently needs this pattern for a
real Monday-writing cron; it's documented here for the next one that does.)

**`salesforce-import` is a one-time batch job**, not an ongoing sync, so it uses neither pattern.
It's a self-registering CLI (`src/commands.ts` holds a `registerCommand` map; each pipeline stage
module calls it on import) implementing a five-stage pipeline — extract → geocode → transform →
load → validate — with retry-with-backoff on individual Monday writes and a resumable ledger
instead of a queue.

**Config, not hardcoding:** SVBC-specific values (board IDs, field names, city lists) live in each
Worker's `config/*.json`, validated at startup. Keep new SVBC-specific values there rather than in
source — the goal is that another org's fork is a config change, not a rewrite.

**Sandbox environment — inbound only, no outbound data.** Every migration Worker (`member-portal`,
`funraise-sync`, `donation-rollups`, `mailchimp-sync`, `quickbooks-sync`, `monday-backup`,
`benevity-import`; not `svbc-calendars`) carries a
`sandbox` Wrangler environment: `wrangler.jsonc` `env.sandbox` with its own name, D1, queues,
secrets and vars, plus a `config/sandbox.json` chosen at request time by `env.ENVIRONMENT`
(`src/environment.ts`). Outbound sinks are locked at the platform where possible (the
`send_email` binding's `allowed_destination_addresses`) and by a per-Worker
`config/split.test.ts` that fails if the two configs ever share a sink or an id (the id checks
are latent until production ids exist). When adding the
environment to another Worker, copy `member-portal`'s `environment.ts`, split test, and
`env.sandbox` shape rather than re-deriving them. Design:
`docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.

**One Monday GraphQL transport, copied, not shared (#35):** `monday-backup/src/monday/graphql.ts`
is the canonical transport (429/Retry-After, complexity budget, 5xx, timeouts, non-idempotent
writes). Workers that use it carry a byte-identical copy at `src/monday/graphql.ts` and tune it
through constructor options in their own `client.ts`, never by editing the copy. The
`monday-graphql-copies` CI job fails on drift, so edit the canonical file, copy it to every path
that job lists, and add a Worker's path there when moving it over. So far: benevity-import,
donation-rollups, funraise-sync, geo-filter, mailchimp-sync, member-portal and quickbooks-sync;
salesforce-import deliberately keeps its own client (`src/load/monday.ts`) through the
2026-10-09 cutover: it's the one every load rehearsal validated, its `gqlPartial()` (per-alias
results from multi-create requests) has no transport equivalent, and `gqlLegacy()` must stay
verbatim for `load --sequential`. Reconsider after cutover, if it runs again at all; until then
port any new failure mode between the two by hand. A Worker's `.mjs` scripts import that Worker's
copy directly (`import { MondayGraphQL } from '../src/monday/graphql.ts'`) through Node's
built-in type stripping (Node 22.18+ / 23.6+), so the file must stay strip-only-compatible — no
constructor parameter properties, enums or namespaces. Queue Workers run it with 3 in-process
attempts and leave longer waits to their queue backoff; geo-filter, a local CLI, uses the
transport's defaults. member-portal runs it with `maxAttempts: 1` (no in-process retry): its
calls mostly render a donor's page, where a multi-second backoff is worse than a fast error the
donor can reload past. Everything the transport throws is a `MondayApiError` (`httpStatus`,
`code`, `retryAfterSeconds`), so a queue consumer can pick its delay from the failure.

**Monday API tokens are least-privilege by design:** mint from dedicated integration users scoped
per exposure class (the public-facing `member-portal` gets its own user with access to only the
boards it reads), never a staff member's personal token — see the root README for why.

**`data/` directories** (e.g. in `salesforce-import`) hold real extracted donor PII pulled from
Salesforce and are gitignored per-Worker. Never remove that ignore rule or commit real data.
