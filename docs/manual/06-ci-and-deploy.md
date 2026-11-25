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
3. **deploy-sandbox:** only on pushes to `main`, for each changed Worker that has a sandbox
   environment. It uses the `CLOUDFLARE_API_TOKEN` secret of the `sandbox` GitHub environment
   ([below](#the-sandbox-deploy-token)). If that secret is missing the job **fails**, with a job
   summary naming each Worker that wasn't deployed and the command to deploy it by hand. It used
   to skip and finish green, which made an undeployed sandbox look deployed (#89). It isn't a
   required check, so a red deploy-sandbox marks `main`'s commit without blocking pull requests.
   It deploys code only, never D1 migrations. An entry **skips itself, with a notice**, when `main`
   already has a newer change to the same Worker: that change's own run deploys it. Otherwise a
   slow or re-run older run could put old code back (`scripts/ci-superseded.mjs`). If the newer
   run's tests or deploy failed, the sandbox keeps its previous code until that run is fixed or
   re-run.
4. **ci-ok:** the single required result.

## What deploys when

| Worker | Production | Sandbox |
|---|---|---|
| `svbc-calendars` | **Automatically**, by Cloudflare Workers Builds on every merge to `main` | n/a |
| `monday-backup` | **Automatically**, by Workers Builds on merges that touch `monday-backup/` | **Automatically**, by `deploy-sandbox` |
| `svbc-bike-lanes` | **Automatically**, by its own workflow (`svbc-bike-lanes.yml`) | n/a |
| `nearby-search` | **By hand**: `npm run deploy` | **By hand**, until the deploy token covers it ([below](#the-sandbox-deploy-token)) |
| Workers with no `sandbox` entry in `.github/workers.json` (`monday-auth`, `dtd-sync`, `sync-watchdog`, `quickbooks-sync`, `zoom-phone-sync`) | **By hand**: `npm run deploy` | **By hand**: `npm run deploy:sandbox` |
| Every other Worker | **By hand**: `npm run deploy` | **Automatically**, by `deploy-sandbox` on merges that touch it |

So merging a pull request changes most sandbox Workers but few production ones. After merging,
whoever owns the change deploys production. Workers Builds connections are in the Cloudflare dashboard,
under the Worker's Settings → Builds, with "non-production branch builds" **off**. Keep branch
builds off: a branch build runs that branch's code with the production build token.

### The sandbox deploy token

Sandbox and production Workers share one Cloudflare account, so an account-wide *Workers
Scripts: Edit* token could overwrite production. The sandbox token is an **account API token**
(`github-sandbox-deploy`) limited to named Workers instead:

| Policy | Permission | Why |
|---|---|---|
| Workers → Specified Workers | **Individual Workers Editor** on each `svbc-<worker>-sandbox` Worker in the `deploy-sandbox` roster, except `nearby-search` (15 Workers) | Uploads the script. Bindings (D1, KV, queues, services) need no permission of their own. |
| Entire account | **Queues: Write** | `wrangler deploy` updates queue consumers. There is no per-queue scope, so this reaches production queues too. |
| Zone `bikesiliconvalley.org` | **Workers Routes: Write** | `wrangler deploy` re-checks the sandbox custom domains. This reaches production routes too. |

Don't start from the dashboard's "Edit Cloudflare Workers" template, which is account-wide. Keep
the secret in the `sandbox` GitHub environment, which is restricted to `main`. Never make it a
repository secret, or code in a pull request could read it.

- **Adding a Worker to the roster:** the token can't create a Worker or cover one that doesn't
  exist yet. Deploy the new sandbox Worker by hand once, then add it to the token's Workers policy.
- **`nearby-search` is left out on purpose.** A deploy would publish its sandbox hostname, and its
  Access application doesn't exist yet. Until it does, a merge touching `nearby-search` shows a
  failed `deploy-sandbox` entry. Afterwards, do its first deploy by hand and add it.
- **Verified:** all 15 Workers, `monday-backup` and its Workflow included, deployed with this token
  on 2026-11-24.
- **Renewing:** it expires a year after creation (November 2026). Create or roll it in Manage
  account → Account API tokens, then `gh secret set CLOUDFLARE_API_TOKEN --env sandbox`, which
  prompts for the value.
- **Re-running a failed deploy uses that run's commit and workflow**, not the tip of `main`. Runs
  from before the skip check existed don't have it, so re-running one can roll the sandbox back.
  Re-run the newest run that touched the Worker.

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
