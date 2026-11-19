# CI and deploy

## Pull requests and required checks

All changes reach `main` through a pull request. A ruleset on `main` requires two passing checks
and forbids force-pushes.

| Check | Workflow | What it runs |
|---|---|---|
| `checks` | `.github/workflows/checks.yml` | Repo-wide consistency checks, listed below. They run on every pull request in a few seconds. |
| `ci-ok` | `.github/workflows/workers.yml` | Passes when every affected Worker's `npm ci`, `npm test` and `npm run typecheck` pass |

### `checks.yml` steps

| Step | Fails when |
|---|---|
| `monday-graphql-copies` | A Worker's `src/monday/graphql.ts` differs from `monday-backup`'s canonical copy |
| `monday-outage-copies` | An `outage.ts` copy differs from `funraise-sync`'s, or isn't in the roster |
| `geo-geometry-copies` | `nearby-search/src/geometry.ts` differs from `geo-filter`'s |
| `employer-name-copies` | `impact-attribution`'s employer-name module differs from `member-portal`'s |
| `worker-flags-copies` | A `flags.ts` copy differs, or the FLAGS KV ids disagree across configs |
| `monday-auth-bindings` | A Worker binds the wrong broker entrypoint or environment |
| `preview-urls` | A `wrangler*.jsonc` doesn't set `preview_urls: false` at the top level and in `env.sandbox` |
| `rate-limit-namespaces` | Two rate limiters share a `namespace_id` |
| `log-safety` | Any `scripts/*.test.mjs` fails, or a `console.*` call could log an email address |
| `manual` | A Worker in `.github/workers.json` has no chapter here, a chapter is missing a template heading, a relative link in `docs/manual/` is broken, or a Wrangler config doesn't parse |

### `workers.yml`

1. **changes:** `scripts/ci-changed-workers.mjs` works out which Workers a change touches. A
   change touches a Worker if it modifies a file under the Worker's directory or matches one of
   its `extraPaths` in `.github/workers.json`. It **fails if a top-level directory with a
   `package.json` isn't in the roster**, so a new Worker can't skip CI.
2. **test:** for each affected Worker, `npm ci`, `npm test`, any `extraTest`, then
   `npm run typecheck`.
3. **deploy-sandbox:** only on pushes to `main`, and only when the `sandbox` GitHub environment
   has a `CLOUDFLARE_API_TOKEN` secret. **That secret isn't set, so this job skips.**
4. **ci-ok:** the single required result.

## What deploys when

| Worker | Production | Sandbox |
|---|---|---|
| `svbc-calendars` | **Automatically**, by Cloudflare Workers Builds on every merge to `main` | n/a |
| `monday-backup` | **Automatically**, by Workers Builds on merges that touch `monday-backup/` | By hand |
| Every other Worker | **By hand**: `npm run deploy` | **By hand**: `npm run deploy:sandbox` |

So merging a pull request doesn't, by itself, change most running Workers. After merging,
whoever owns the change deploys it. Workers Builds connections are in the Cloudflare dashboard,
under the Worker's Settings → Builds, with "non-production branch builds" **off**. Keep branch
builds off: a branch build runs that branch's code with the production build token.

## Deploying a Worker by hand

From an up-to-date `main`:

```sh
git switch main && git pull
cd <worker>
npm ci
npm test && npm run typecheck
npx wrangler d1 migrations list svbc-<worker> --remote        # any pending migrations?
npx wrangler d1 migrations apply svbc-<worker> --remote       # apply them first
node ../scripts/flags.mjs status --env production             # is its write switch what you expect?
npm run deploy                                                # or: npm run deploy:sandbox
npx wrangler tail svbc-<worker>                               # watch the first requests
```

Sandbox first, then production, is the habit. Each Worker's README has a "Deploy" section with
its specific steps (secrets, webhooks, one-time setup). Its chapter here summarizes them.

### Order matters for a few Workers

- **`monday-auth` before anything that uses it.** A new consumer's service binding fails to
  deploy if the broker entrypoint doesn't exist.
- **`member-portal`, then `member-portal-writer`.** A Cloudflare queue allows one consumer, so
  the writer can only attach after the portal no longer consumes the change-request queue
  ([`member-portal/DEPLOY.md`](../../member-portal/DEPLOY.md)).
- **Set the write switch before the first deploy** of a Worker that reads it. A missing key
  reads `off`, so a Worker meant to write would silently dry-run.
- **New secrets before code that requires them.** `monday-auth`'s `TOKEN_ENC_KEY` is one
  example: without it, every token read fails.
- **New custom-domain routes** that serve webhooks or feeds need the WAF Super Bot Fight Mode
  skip rule ([chapter 3](03-accounts-and-access.md#cloudflare)).

### Rolling back

Cloudflare keeps previous versions of every Worker:

```sh
npx wrangler deployments list --name svbc-<worker>
npx wrangler rollback --name svbc-<worker>     # back to the previous version; prompts for a message
```

A rollback restores the code and config bindings of that version. It doesn't undo D1
migrations, secrets or KV values. Because migrations are additive, older code normally still
runs. For an urgent stop, the write switch is faster than a rollback
([chapter 7](07-operations.md#the-write-switch)).

## First-time production deploys

The cutover checklist,
[`docs/production-deploy-checklist.md`](../production-deploy-checklist.md), records the
one-time sequence each Worker went through to reach production:

- create D1 and queues;
- set secrets;
- fill `config/svbc.json`;
- set the write switch;
- deploy;
- register webhooks;
- smoke test.

Use it as a template when a built-but-undeployed Worker (for example `dtd-sync` or
`nearby-search`) goes live. Its README's "Deploy" or "Operator setup" section has the
specifics.
