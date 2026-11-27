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
4. **deploy-production:** only on pushes to `main`, after `deploy-sandbox`, for each changed
   Worker with a `production` entry in `.github/workers.json`, in roster order (`monday-auth`
   first). It uses the `CLOUDFLARE_API_TOKEN` secret of the `production` GitHub environment
   ([below](#the-production-deploy-token)) and has the same missing-token failure and
   skip-when-superseded rule as the sandbox job. It runs only when every `test` passed and no
   `deploy-sandbox` entry failed, so one failed sandbox deploy holds every production deploy in
   that run. **Pending D1 migrations stop an entry before it deploys**
   (`scripts/ci-pending-migrations.mjs`, a read-only check of the database's `d1_migrations`
   table): apply them by hand, then re-run the job. It never applies migrations or changes a write
   switch.
5. **deploy-sandbox-pr / restore-sandbox-pr:** opt-in sandbox deploys from a pull request
   ([below](#deploying-a-pull-request-to-the-sandbox)).
6. **ci-ok:** the single required result. No deploy job is required.

## What deploys when

| Worker | Production | Sandbox |
|---|---|---|
| `svbc-calendars` | **Automatically**, by Cloudflare Workers Builds on every merge to `main` | n/a |
| `monday-backup` | **Automatically**, by Workers Builds on merges that touch `monday-backup/` | **Automatically**, by `deploy-sandbox` |
| `svbc-bike-lanes` | **Automatically**, by its own workflow (`svbc-bike-lanes.yml`) | n/a |
| `monday-auth`, `sync-watchdog` | **Automatically**, by `deploy-production` | **By hand**: `npm run deploy:sandbox` |
| Every Worker with a `production` entry in `.github/workers.json` (`benevity-import`, `bp-feedback-notify`, `contact-roles`, `donation-rollups`, `eventbrite-sync`, `funraise-sync`, `impact-attribution`, `mailchimp-sync`, `member-map`, `member-portal` and its writer, `people-reclassification`, `report-digests`, `status-page`) | **Automatically**, by `deploy-production` on merges that touch it | **Automatically**, by `deploy-sandbox` |
| `nearby-search` | **By hand**: `npm run deploy` | **By hand**, until the deploy token covers it ([below](#the-sandbox-deploy-token)) |
| Not live yet (`dtd-sync`, `quickbooks-sync`, `zoom-phone-sync`) | **By hand**: `npm run deploy` | **By hand**: `npm run deploy:sandbox` |

So merging a pull request deploys what it touched, sandbox first, then production. Before
merging a change that needs a new secret, queue, D1 migration, custom domain or write-switch
change, do that step first (see [Order matters](#order-matters-for-a-few-workers)), or the
production deploy fails or runs code against the old setup. A Worker joins `deploy-production`
when it goes live: add `"production": {}` to its roster entry and the Worker to the production
token. Workers Builds connections are in the Cloudflare dashboard, under the Worker's Settings →
Builds, with "non-production branch builds" **off**. Keep branch builds off: a branch build runs
that branch's code with the production build token. Never give a Worker both a Workers Builds
connection and a `production` entry, or each merge deploys it twice.

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

**What it can still reach, and what watches it.** Queues: Write and Workers Routes Write have no
narrower scope. Routes are granted per zone, and Custom Domains have no per-Worker role
([Cloudflare docs](https://developers.cloudflare.com/workers/authorization/workers/#routes-and-custom-domains)). So code running in `deploy-sandbox` could repoint a production
hostname at a sandbox Worker, or add a route in front of it, because a route runs before a Custom
Domain on the same hostname ([Cloudflare docs](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#interaction-with-routes)). Cloudflare has no notification for
route changes, so `sync-watchdog` checks every hour: its `domains:bikesiliconvalley.org` subject
compares every Custom Domain and route on the zone with `sync-watchdog/config/svbc.json` and posts
any difference to the staff channel ([runbook](../runbooks/sync-alerting.md)).

**No required reviewer on `sandbox` (decided 2026-11-27).** The environment runs only on `main`.
A change gets there only through a pull request with `ci-ok` and `checks` green, and the deploy
job installs with `--ignore-scripts`. A misused route alerts within the hour. An approval on
every merge would hold every sandbox deploy for the one maintainer. Revisit if more people can
merge, or if "require a review before merging to main" is declined. `sandbox-pr` is different:
it runs a pull request's own code, so it gets a reviewer (step 3 of
[Deploying a pull request to the sandbox](#deploying-a-pull-request-to-the-sandbox)).

- **Possibly narrower:** Cloudflare says a deploy needs Workers Routes Write only when it adds,
  changes or removes a route or Custom Domain ([Cloudflare docs](https://developers.cloudflare.com/workers/authorization/workers/#routes-and-custom-domains)). The sandbox domains
  don't change between deploys, so the token may work without that permission. This is untested.
  At the next roll, try it without Routes Write and deploy one Worker with a Custom Domain
  (`member-portal`) by hand. If that works, keep it off and record it here.
- **Longer term:** a separate Cloudflare account, or a separate zone, for the sandbox would keep
  its token away from production queues and routes altogether.

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

### The production deploy token

A second account API token (`github-production-deploy`), built like the sandbox one but for the
production Workers:

| Policy | Permission | Why |
|---|---|---|
| Workers → Specified Workers | **Individual Workers Editor** on each `svbc-<worker>` Worker with a `production` entry (15 Workers, `svbc-member-portal-writer` included) | Uploads the script. |
| Entire account | **Queues: Write** | `wrangler deploy` updates queue consumers. |
| Zone `bikesiliconvalley.org` | **Workers Routes: Write** | `wrangler deploy` re-checks custom domains. |
| Entire account | **D1: Read** | The pending-migrations check reads each database's `d1_migrations` table. Read is enough: D1 refuses writes without Edit ([release notes, 2025-02-04 and 2025-05-02](https://developers.cloudflare.com/d1/platform/release-notes/)). |

Store it as `CLOUDFLARE_API_TOKEN` in a GitHub environment named `production`: Settings →
Environments → `production`, deployment branches limited to `main`
([GitHub docs](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment)).
Never make it a repository secret. To make every production deploy wait for a person, add
required reviewers to that environment; the workflow needs no change. Adding a Worker to
`deploy-production` means adding it to this token too.

## Deploying a pull request to the sandbox

Add the **`deploy-sandbox`** label to a pull request from a branch in this repo. From then on,
each push to the PR deploys its changed sandbox Workers (the same `deploy` list as
`deploy-sandbox`) once `test` passes, as the PR merged with `main` (`refs/pull/N/merge`). Remove
the label, or close the PR without merging, and `restore-sandbox-pr` deploys `main` back to those
Workers. A merged PR needs no restore: its push to `main` deploys it in the usual way.

- **One sandbox per Worker.** A PR deploy replaces main's code there, and two labelled PRs
  touching the same Worker replace each other, last push wins. Tell whoever else is testing in
  the sandbox. A merge to `main` touching that Worker also replaces the PR's code; push to the PR
  again to put it back. Each job's summary says which PR the sandbox is running.
- **Fork PRs never deploy.** The jobs check that the head branch is in this repo, and GitHub
  doesn't give secrets to runs triggered from forks.
- **Code only**, like `deploy-sandbox`: apply a PR's new sandbox D1 migrations, secrets or flags
  by hand first.

**Setup.** The token lives in a separate GitHub environment, **`sandbox-pr`**, so `sandbox` stays
restricted to `main`:

1. Create an account API token `github-sandbox-pr-deploy` with the same policies as
   [the sandbox deploy token](#the-sandbox-deploy-token). Keeping it separate means it can be
   rolled without touching main's.
2. Settings → Environments → **New environment** `sandbox-pr`. Under deployment branches and tags,
   choose selected branches and add the rule `refs/pull/*/merge`. GitHub matches the rule against
   the run's `GITHUB_REF`, which is that ref for a pull request
   ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#deployment-branches-and-tags)).
3. Add **required reviewers** to `sandbox-pr`
   ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers)).
   The PR's own `package.json` and `wrangler` run with the token, and the token reaches production
   queues and routes, so someone should look at the diff before each deploy.
4. Add the token as the environment secret `CLOUDFLARE_API_TOKEN`
   (`gh secret set CLOUDFLARE_API_TOKEN --env sandbox-pr`).
5. Create the `deploy-sandbox` label (Issues → Labels).

Until step 4 is done, a labelled PR's deploy job fails red. Nothing happens without the label.

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

Sandbox first, then production, is the habit. For a Worker in `deploy-production`, a hand
deploy is for first deploys and emergencies; the next merge that touches it deploys `main` over
it. Each Worker's README has a "Deploy" section with
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
