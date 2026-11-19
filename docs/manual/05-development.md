# Development

## Tools

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22.18 or later (CI pins 22.23) | Operator scripts rely on Node's built-in TypeScript type stripping |
| npm | Comes with Node | Each Worker has its own `package-lock.json`, so use `npm ci` |
| Git | Any recent | |
| GitHub CLI (`gh`) | Optional | Pull requests and CI status from the terminal |
| Wrangler | Pinned per Worker in `devDependencies` | Always run it as `npx wrangler`, never a global install |
| pandoc, Google Chrome | Only to build this manual's PDF | |

## Clone and set up

```sh
git clone git@github.com:Silicon-Valley-Bicycle-Coalition/monday-workers.git
cd monday-workers
git config core.hooksPath .githooks     # once per clone: enables the pre-commit hook
npx wrangler login                      # once per machine
```

The **pre-commit hook** (`.githooks/pre-commit`) does two things:

1. It runs the log-safety check on your staged changes, which blocks a `console.*` call that
   could log an email address.
2. In the primary checkout, it refuses commits on any branch other than `main`. That pushes you
   toward a worktree per topic (below). Bypass it for a genuine one-line fix with
   `git commit --no-verify`.

If you'll run operator scripts, create the gitignored env files at the repo root: `.env`,
`.env.sandbox` and `.env.production`, each holding your **own** Monday token
(`MONDAY_API_TOKEN=…`) for that environment, plus whatever a script's runbook asks for. Load the
one that matches the `--env` you pass:

```sh
set -a; source .env.sandbox; set +a
```

## One topic, one branch, one worktree

For any change beyond a one-liner, work in a separate **git worktree** on a feature branch,
not in the primary checkout. This keeps parallel work from tangling, which happened twice
in this repo:

```sh
git worktree list                                         # what's already checked out
git worktree add ../monday-workers-<topic> -b feat/<topic>
cd ../monday-workers-<topic>
```

After the pull request merges, remove the worktree and delete the branch. **First check for
gitignored files you can't regenerate**, because `git worktree remove` deletes them silently:

```sh
git -C ../monday-workers-<topic> status --ignored --short | grep '^!!'   # copy out data/, .env, review files
git worktree remove ../monday-workers-<topic>
git branch -d feat/<topic>
```

`salesforce-import/data/` once held the only copy of the migration's id mapping and was lost
this way. Never let two people or agents edit the same worktree at once.

## Working on a Worker

Everything runs from inside the Worker's directory:

```sh
cd funraise-sync
npm ci
npm test                              # vitest run, in workerd with simulated bindings
npm test -- src/routes.test.ts        # one file
npm test -- -t "dedupes a retried"    # one test by name
npm run typecheck                     # wrangler types, then tsc --noEmit
npm run dev:sandbox                   # local Worker, sandbox config
```

- **Always use `npm run typecheck`, never a bare `tsc --noEmit`.** Binding types (`DB`, queues,
  rate limiters) are generated from `wrangler.jsonc` into `worker-configuration.d.ts`, which is
  gitignored. A bare `tsc` reads whatever stale copy is on disk.
- The two CLIs (`salesforce-import`, `geo-filter`) have no Wrangler config. Their `typecheck`
  is a plain `tsc --noEmit`.
- Worker scripts (`<worker>/scripts/*.mjs`) import the Worker's TypeScript directly, for example
  `import { MondayGraphQL } from '../src/monday/graphql.ts'`. That's why shared modules must stay
  strip-only TypeScript.

## Repository layout

```
<worker>/
  README.md            the spec: ask, data flow, APIs, Monday targets, operator steps, history
  wrangler.jsonc       Cloudflare config: bindings, crons, routes, env.sandbox
  config/svbc.json     production ids and settings
  config/sandbox.json  sandbox ids and settings
  config/split.test.ts proves the two configs share nothing
  src/index.ts         entry: fetch(), scheduled(), queue() handlers
  src/environment.ts   picks the config by ENVIRONMENT
  src/flags.ts         write switch (copy of member-portal's)
  src/monday/          GraphQL transport (copy), client, outage breaker (copy)
  migrations/          D1 schema migrations, numbered
  scripts/             operator scripts (.mjs), each with a test
  src/**/*.test.ts     Vitest tests, beside the code they test
  test/                test helpers (migrations, env types)
scripts/               repo-wide CI checks and operator tools (.mjs, node:test)
docs/                  manual, runbooks, design specs, UAT scripts, design system
.github/workers.json   CI roster: every Worker directory
.github/workflows/     checks.yml (repo checks), workers.yml (per-Worker tests, sandbox deploy)
```

## D1 migrations

Schema changes are numbered SQL files in `<worker>/migrations/`. Tests apply them automatically.
For deployed databases, apply them **before** deploying code that needs them:

```sh
npx wrangler d1 migrations list svbc-<worker> --remote                     # pending, production
npx wrangler d1 migrations apply svbc-<worker> --remote                    # production
npx wrangler d1 migrations apply svbc-<worker>-sandbox --env sandbox --remote
```

Write migrations so they're additive, meaning the old code still works after they run. Then
applying a migration ahead of a deploy is always safe.

## Code conventions

- **TypeScript, ES modules, Hono for routes.** Follow the shape of a sibling Worker rather than
  inventing a new one.
- **Config, not constants,** for anything SVBC-specific
  ([chapter 2](02-architecture.md#configuration-not-hardcoding)).
- **Never log an email address, a token or `c.req.url`.** Log the Monday item id. `logSafe.ts`
  helpers exist in several Workers (for example `member-portal` and `mailchimp-sync`).
- **Find Monday columns by bare title** with `bareTitle()`, or by id from config.
- **Tests first** for any behavior change. Scripts under `scripts/` use `node:test`
  (`node --test scripts/*.test.mjs`).
- **Conventional commits:** `feat(worker): …`, `fix(worker): …`, `docs(manual): …`.
- **Update docs in the same pull request:**
  - the Worker's README;
  - its chapter in this manual;
  - its staff test script in `docs/uat/` if staff-visible behavior changed;
  - the root README's status table if deploy status changed.

## Design documents

Larger changes start with a design document in
[`docs/superpowers/specs/`](../superpowers/specs/) (dated, one per topic) and often an
implementation plan in `docs/superpowers/plans/`. They're the best record of *why* something
is the way it is. When a README section links a spec, read it before changing that area.
