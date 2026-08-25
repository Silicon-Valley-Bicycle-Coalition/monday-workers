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

**There is no root-level code** — each Worker is self-contained in its own subdirectory. Workers
are built one per feature branch (see the sibling worktree directories in the parent folder) and
merged to `main` once ready; most are now merged with full implementations, while a Worker whose
subdirectory holds only a `README.md` is still requirements-only. See the root `README.md`'s
"Status at a glance" table for what's built, deployed, or pending.

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

## Commands

There's no root `package.json` — every command runs from inside a Worker's own subdirectory
(`cd funraise-sync`, etc.), each with its own `package.json`, `wrangler.jsonc`, and lockfile.

For a Worker built on the standard Hono + D1 stack (e.g. `funraise-sync`, `membership-reminders`):

```sh
npm test                    # vitest run
npm test -- path/to/file.test.ts   # single test file
npm test -- -t "test name"         # single test by name
npm run typecheck           # tsc --noEmit
npm run dev                 # wrangler dev — local Worker + D1 + queue simulation
npm run deploy               # wrangler deploy
```

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

**Webhook-driven Workers** (`funraise-sync`, `quickbooks-sync`, `instagram-threads-interactions`,
`bluesky-interactions`) share one shape: a Hono route validates and dedupes the incoming event into
D1 (the idempotency store), then enqueues a message to a Cloudflare Queue producer. A separate
queue consumer (the Worker's exported `queue()` handler) performs the actual Monday.com write.
Queues retry automatically (3 attempts) on failure and route to a dead-letter queue once exhausted,
so a failed write becomes a visible, replayable backlog instead of a silently dropped donation.
D1 status here means "ingested," not "written" — the queue is what makes the write durable.

**Cron-polled Workers** (`squarespace-forms`, `committee-calendars`, `buffer-content-calendar`)
don't need a queue — a failed poll self-heals on the next scheduled run. The one invariant that
matters: the D1 "last processed" cursor must only advance *after* a confirmed Monday write, never
before, or a failed run silently skips what it should have processed with nothing to retry it.

**`salesforce-import` is a one-time batch job**, not an ongoing sync, so it uses neither pattern.
It's a self-registering CLI (`src/commands.ts` holds a `registerCommand` map; each pipeline stage
module calls it on import) implementing a five-stage pipeline — extract → geocode → transform →
load → validate — with retry-with-backoff on individual Monday writes and a resumable ledger
instead of a queue.

**Config, not hardcoding:** SVBC-specific values (board IDs, field names, city lists) live in each
Worker's `config/*.json`, validated at startup. Keep new SVBC-specific values there rather than in
source — the goal is that another org's fork is a config change, not a rewrite.

**Monday API tokens are least-privilege by design:** mint from dedicated integration users scoped
per exposure class (the public-facing `donor-portal` gets its own user with access to only the
boards it reads), never a staff member's personal token — see the root README for why.

**`data/` directories** (e.g. in `salesforce-import`) hold real extracted donor PII pulled from
Salesforce and are gitignored per-Worker. Never remove that ignore rule or commit real data.
