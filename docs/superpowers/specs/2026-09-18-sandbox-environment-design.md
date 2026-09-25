# Sandbox environment — inbound only, no outbound data — Design

**Date:** 2026-09-18
**Status:** Approved and implemented — rollout steps 1–3 landed 2026-09-18 (donor-portal; funraise-sync and donation-rollups; mailchimp-sync, quickbooks-sync, monday-backup, benevity-import). Live provisioning per Worker follows each step's plan runbook.
**Workers:** every deployed Worker in this repo except `svbc-calendars` (not migration-related,
no donor data). Outbound sinks change in `donor-portal`, `mailchimp-sync`, `quickbooks-sync`,
`monday-backup`; the environment split alone applies to `funraise-sync`, `donation-rollups`,
`benevity-import`.
**Prior art:** `2026-08-22-donor-portal-design.md` (Pre-launch checklist — the email dependency
this design finally resolves for testing); root `README.md` "Least-privilege Monday tokens" and
"Deploys"; private planning repo `docs/16-staff-uat-guide.md` (the CRM Sandbox workspace and
what staff test there) and `docs/18-sandbox-load-rehearsal-lessons.md` §1 (integration users
need a member seat).

## Context

SVBC's end-to-end sandbox has one rule: **inbound data only, no outbound data.** Real donor
records may flow *into* the sandbox (the CRM Sandbox workspace, id `17141226`, is already a
one-time copy of production Salesforce), and Workers may write to sandbox boards, but nothing
the Workers do in the sandbox may reach a donor, a vendor's production account, or any surface
outside SVBC staff. A staff tester requesting a donor-portal login link as a real donor must
never cause that donor to receive an email.

Today the repo cannot express that rule, for two structural reasons:

1. **No Worker has an environment.** Every `wrangler.jsonc` defines one Worker name, one D1,
   one queue set, one cron. Two Workers are already deployed against the sandbox *under their
   production names* — `svbc-donation-rollups` (D1 `58bbaabb-…`, verified end-to-end against
   the sandbox per the plan) and `svbc-funraise-sync` (D1 `526c360c-…`, provisioned 2026-09-18).
   Their `config/svbc.json` files hold sandbox v2 board ids. When production boards exist in
   October there is no way to run both.
2. **Config is a build-time import.** Each entrypoint does
   `import rawConfig from '../config/svbc.json'`, and most validate it at module scope, so
   sandbox versus production board ids cannot be chosen at deploy time.

What leaves Monday and Cloudflare today, per Worker:

| Worker | What leaves | Destination | Control today |
|---|---|---|---|
| `donor-portal` | Login magic links; "your letter is ready" emails | The donor's own address, via the `EMAIL` send binding | None. `ConsoleEmailSender` is wired only in `index.local.ts`. |
| `mailchimp-sync` | Contact upsert (merge fields, tags), interest-category create/rename/archive | Real Mailchimp audience | None. `mailchimp.audienceId` and `apiBaseUrl` are config, no test flag. |
| `quickbooks-sync` | `createCustomer` POST | Production QuickBooks company | None. `QB_API_BASE` is a hardcoded production host in `src/quickbooks/client.ts`. |
| `monday-backup` | Full board snapshots; failure alerts | Google Drive folder (config); Slack incoming webhook (secret) | Destinations are config/secret. Internal, staff-owned. |
| `salesforce-import` | Address strings | Google Places / Geocoding | Lookup, not export; already exercised in rehearsals. CLI, not deployed. Out of scope here. |
| `funraise-sync`, `benevity-import`, `donation-rollups` | Nothing | Monday only | Already inbound-only. |

Decisions taken 2026-09-18 before this design:

* The sandbox is a **permanent parallel environment** that keeps running beside production
  after the October cutover, as a staging tier — not a pre-cutover deployment to be repointed.
* Sandbox donor-portal email delivers to **`sandbox@bikesiliconvalley.org`**, enforced at the
  binding, not only in code.
* Mailchimp and QuickBooks writes in the sandbox go to **vendor test targets** (a separate
  Mailchimp audience, an Intuit sandbox company), so the integrations are actually exercised.
  A log-only capture was rejected because it tests nothing.
* Cloudflare's send binding supports `allowed_destination_addresses`; a send outside the list
  fails with `E_RECIPIENT_NOT_ALLOWED`. Verified against
  <https://developers.cloudflare.com/email-service/configuration/send-bindings/> 2026-09-18.

## Goals

* A staff member can exercise every Worker end to end against the CRM Sandbox — request a login
  link as any donor, change a Donor column and watch Mailchimp update, create a Customer and
  watch QuickBooks — with **zero** possibility of a donor or a vendor production account being
  touched, even by a code bug.
* Sandbox and production deployments of the same Worker coexist with nothing shared: names,
  D1s, queues, secrets, cron schedules, and Monday tokens are all separate.
* The rule is enforced by the platform wherever the platform can (email binding allowlist,
  Monday workspace-scoped tokens) and by a repo test everywhere else.
* One entrypoint per Worker. No `index.sandbox.ts`, no duplicated route wiring.

## Non-goals

* A Monday "Outbound Log" board or any new staff-facing surface. Cloudflare Workers Logs
  (observability is already enabled on every Worker) is the audit trail; a structured log line
  per redirected send is enough.
* Redesigning `salesforce-import` — it is a CLI with its own `config/svbc.json`, `workspaceId`,
  and `boardSuffix`, and it already targets the sandbox by operator choice.
* Changing `svbc-calendars`.
* A production-to-sandbox tee for Funraise webhooks (see "Inbound feeds" below — deferred).
* Any change to the queue/D1/retry shape of the Workers.

## Design

### 1. One Wrangler environment per Worker: `env.sandbox`

Each affected `wrangler.jsonc` gains an `env.sandbox` block. The top level stays production.
Wrangler names the sandbox deployment `<name>-sandbox` automatically
(`svbc-donor-portal-sandbox`, `svbc-funraise-sync-sandbox`, …); no explicit `name` override.

Wrangler's non-inheritable keys — `vars`, `d1_databases`, `queues`, `send_email`, `triggers`,
`services`, `kv_namespaces`, and secrets — must be redefined per environment. That is the
property this design relies on: **a sandbox deployment cannot accidentally pick up a
production binding**, because it inherits none. `ratelimits` is treated as non-inheritable too
(donor-portal's `LOGIN_RATE_LIMITER` gets `namespace_id: 1002` in the sandbox block).

Every `env.sandbox` block contains, at minimum:

```jsonc
"env": {
  "sandbox": {
    "vars": { "ENVIRONMENT": "sandbox" },
    "d1_databases": [{ "binding": "DB", "database_name": "svbc-<worker>-sandbox",
                       "database_id": "…", "migrations_dir": "migrations" }],
    "queues": { /* same shape as top level, every queue name suffixed -sandbox */ },
    "triggers": { "crons": [ /* same schedule as production */ ] },
    "observability": { "enabled": true }
  }
}
```

Queue names carry the `-sandbox` suffix (`donor-portal-change-requests-sandbox`,
`…-sandbox-dlq`). The `batch.queue` string comparisons in `donor-portal/src/index.ts`
(`routeQueueBatch`) and `mailchimp-sync/src/index.ts` compare against
`queueBaseName(batch.queue)`, which strips exactly one trailing `-sandbox` and nothing else, so
one router serves both environments and a `-dlq` name can never match a consumer branch.

Custom domains and `workers_dev`: `donor-portal` (login portal, `workers_dev: false`) gets the
custom domain `portal-sandbox.bikesiliconvalley.org` in `env.sandbox.routes`. `monday-backup`
stays cron-only in both. Every other Worker keeps `workers_dev` on in the sandbox; the
`*-sandbox.<subdomain>.workers.dev` URL is what its sandbox webhook subscriptions point at.

Secrets are set per environment: `wrangler secret put NAME --env sandbox`. Each Worker's
`wrangler.jsonc` secrets comment gains one line stating that every secret exists twice.

### 2. Config selection at request time

Each affected Worker gets a second config file, `config/sandbox.json`, with the same schema as
`config/svbc.json` and validated by the same `validateConfig`. The entrypoint imports both and
selects by `env.ENVIRONMENT`:

```ts
import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { configFor } from './environment';

// src/environment.ts (per Worker, ~20 lines; same shape in every Worker)
export type Environment = 'production' | 'sandbox';
export function environmentOf(env: { ENVIRONMENT?: string }): Environment { … }  // unset → 'production'; anything else but 'sandbox' → throw
export function configFor(env, production, sandbox, validate) { … }             // memoized per Environment
```

This moves the `const config = validateConfig(rawConfig)` line that `funraise-sync`,
`mailchimp-sync`, `quickbooks-sync`, `benevity-import`, `donation-rollups`, and `monday-backup`
run at module scope into the handlers, memoized on first call. `donor-portal` already validates
lazily per request for a different reason (placeholder ids), so it only swaps the import. The
memo means validation still runs once per isolate, not per request.

Two consequences worth stating:

* **`config/svbc.json` goes back to production.** In `funraise-sync` and `donation-rollups`
  the sandbox v2 ids currently in `svbc.json` move verbatim to `sandbox.json`, and `svbc.json`
  returns to placeholders until production boards exist. This is the single riskiest edit in
  the rollout — it is a rename, and the repo test in §5 exists so it stays one.
* `monday-backup`'s config file is `config/backup.json`, not `svbc.json`; its sandbox twin is
  `config/backup.sandbox.json`. Same mechanism.

### 3. Outbound sinks, per Worker

**`donor-portal` — two independent layers.**

*Platform layer.* The sandbox binding is declared with the allowlist:

```jsonc
"send_email": [{ "name": "EMAIL", "allowed_destination_addresses": ["sandbox@bikesiliconvalley.org"] }]
```

Any `send()` to another recipient throws `E_RECIPIENT_NOT_ALLOWED` inside Cloudflare, before
any mail exists. This holds even if every line of application code below is wrong.

*Code layer.* A `sandboxEmailBinding(inner: SendEmail, sink: string): SendEmail` wrapper in
`src/email/sandboxBinding.ts`, applied in `index.ts` when `environmentOf(env) === 'sandbox'`.
It wraps the binding, not the `EmailSender`, so `CloudflareEmailSender` and both email
templates stay untouched. For each `send()`:

* `to` is replaced with the sink address;
* `subject` becomes `[sandbox → <original recipient>] <original subject>`, so testers see who
  would have received it;
* one line is prepended to both `text` and `html`: "Sandbox copy. Production would have sent
  this to <original recipient>.";
* a structured log line is emitted: `{"sandboxOutbound":"email","originalTo":…,"subject":…}`.

`config/sandbox.json` sets `email.fromName` to `SVBC Donor Portal (sandbox)`, keeps
`email.fromAddress` on the already-onboarded `login@mail.bikesiliconvalley.org` (no second
sending domain), and sets `auth.portalBaseUrl` to `https://portal-sandbox.bikesiliconvalley.org`
so the links in those emails open the sandbox portal.

The wrapper is not applied in production. Without the sandbox flag `index.ts` passes
`env.EMAIL` through unchanged, exactly as today.

**`mailchimp-sync` — config, plus the feedback-loop rule.** `config/sandbox.json` points
`mailchimp.audienceId` at a dedicated "SVBC Sandbox" audience in the same Mailchimp account;
`apiBaseUrl` is the same data center. The sandbox audience needs the same six merge fields and
Interest Category as production (README "Prerequisites"), and its audience webhook points at
the sandbox Worker with the "API" event source unchecked, for the same feedback-loop reason as
production. `MAILCHIMP_API_KEY` may be the same key in both environments — Mailchimp keys are
account-scoped — which is why the repo test in §5, not the secret, is what keeps the sandbox
off the production audience. The sandbox also needs its own "Mailchimp Campaigns (sandbox)"
board and a People connect column pointed at it — created 2026-09-18 (step 3 plan, Task 2).

**`quickbooks-sync` — host into config, separate app.** `QB_API_BASE` moves from a constant in
`src/quickbooks/client.ts` to `config.quickbooks.apiBaseUrl`, validated as a URL. The client takes
the base as a constructor argument (`HttpQuickBooksClient(tokenStore, clientId, clientSecret,
apiBaseUrl)`).
`config/svbc.json` carries `https://quickbooks.api.intuit.com/v3/company`;
`config/sandbox.json` carries `https://sandbox-quickbooks.api.intuit.com/v3/company`. The
OAuth token endpoint is the same for both. Intuit sandbox companies are only reachable with an
app's *development* keys, so `QB_CLIENT_ID`/`QB_CLIENT_SECRET` and the seeded token pair are
genuinely different secrets per environment, and the sandbox app's webhook subscription points
at the sandbox Worker. Because the host differs, a production key presented to the sandbox host
fails authentication; that is the platform-side guard here.

**`monday-backup` — three config/secret swaps.** `config/backup.sandbox.json` sets
`destinationParentFolderId` to a "CRM Sandbox backups" Drive folder; the sandbox
`GOOGLE_SERVICE_ACCOUNT_*` secrets are a service account shared only into that folder;
`SLACK_WEBHOOK_URL` in the sandbox posts to a `#crm-sandbox` channel. Snapshot contents are
real donor data either way — that is acceptable because the destination is staff-only Drive,
the same trust boundary as the sandbox workspace itself. `config/backup.sandbox.json` also sets
`workspaceIds: ["17141226"]` (the CRM Sandbox workspace), an optional config-level scope guard
that `runBackup` applies to both boards and docs, skipping anything whose `workspaceId` isn't
listed; `config/backup.json` leaves it unset, preserving today's "snapshot everything the token
can see" behaviour. This is belt-and-braces on top of the §4 workspace-scoped token, which
remains the primary guard — added as a follow-up from the step 3 final review (2026-09-18).

**Inbound-only Workers** (`funraise-sync`, `benevity-import`, `donation-rollups`) get §1 and §2
and nothing else.

### 4. Monday-side guard: workspace-scoped integration users

Sandbox `MONDAY_API_TOKEN` secrets are minted from a **single shared sandbox integration user**
(`sandbox-integration@bikesiliconvalley.org`) whose only board access is the CRM Sandbox
workspace. Production tokens come from the per-exposure-class users the root README already
requires, none of which can see the sandbox workspace. So a production board id in a sandbox
config — or the reverse — fails at Monday with `USER_UNAUTHORIZED` rather than writing to the
wrong workspace.

One shared sandbox user, not one per Worker, is deliberate: member seats are a Pro-plan
constraint (15), and least privilege *between* Workers matters far less inside a disposable
workspace than the boundary *around* it. That user still needs a Work Management member seat
(`docs/18` §1).

### 5. Repo test: the two configs must disagree on every sink

Each affected Worker gets `config/split.test.ts` (vitest, alongside the existing suite) that
loads both config files and asserts, for that Worker's list of **sink keys**, that the values
differ and that neither is a placeholder:

| Worker | Sink keys |
|---|---|
| `donor-portal` | `auth.portalBaseUrl`, `email.fromName` |
| `mailchimp-sync` | `mailchimp.audienceId` |
| `quickbooks-sync` | `quickbooks.apiBaseUrl` |
| `monday-backup` | `destinationParentFolderId` |
| `donor-portal`, `mailchimp-sync`, `quickbooks-sync`, `funraise-sync`, `benevity-import`, `donation-rollups` | every board id under `monday.*` — the assertion is "sandbox is a real id, and production is either a placeholder or a different real id", since production boards do not exist until October |

Plus one assertion in `donor-portal/config/split.test.ts` that reads `wrangler.jsonc` and
checks `env.sandbox.send_email[0].allowed_destination_addresses` equals exactly
`["sandbox@bikesiliconvalley.org"]`, so the platform guard cannot be removed without a test
failing. `wrangler.jsonc` has comments; parse with a JSONC-tolerant reader (strip comments —
there is no `wrangler` import at test time).

This is per-Worker rather than a root script because the repo has no root-level code by design.

### 6. Observability

No new surface. Every redirected or rewritten send logs one structured line under a
`sandboxOutbound` key (email in `donor-portal`; Mailchimp upsert and QuickBooks
`createCustomer` log the target host/audience once per isolate at first call, not per record).
Cloudflare Workers Logs already retains these; access is Cloudflare account membership, which
is a subset of staff. If staff outside that set need to see sends, the `sandbox@` group is the
answer for email, and the vendor test accounts for the rest.

### 7. Inbound feeds in the sandbox

The inbound-only rule is about data leaving. Getting data *in* is mostly free, with one
exception:

* **Monday webhooks** are per board — sandbox boards subscribe to sandbox Workers. Nothing
  changes from today.
* **Mailchimp audience webhooks** are per audience; **QuickBooks webhooks** are per app.
  Both are naturally separate once §3's targets exist.
* **Funraise supports one webhook per org** (funraise-sync README "Open before first deploy").
  Until cutover it points at the sandbox `funraise-sync`, as today. **At cutover it moves to
  production and the sandbox loses its live feed.** Decision: accept that. Sandbox testing of
  `funraise-sync` after cutover uses the existing signed-POST test pattern or a hand replay of a
  production `raw_payload` row (which is within the retention window and is internal traffic).
  A production-to-sandbox tee is deferred until someone actually needs live sandbox Funraise
  traffic post-cutover.

### 8. Deploys

Each outbound-capable Worker becomes **two Workers Builds connections** to the same repo and
root directory: the existing one (deploy command default, production branch `main`) and a
sandbox one whose deploy command is `npx wrangler deploy --env sandbox`, also from `main`. The
sandbox therefore always runs what production runs, or is about to. Non-production branch
previews stay as they are (version uploads) on the production connection only.

**Verify before relying on it:** that the Cloudflare dashboard allows two Workers Builds
connections on one repo + root directory. If it does not, the fallback is a GitLab CI job on
`main` running `npx wrangler deploy --env sandbox` from each Worker directory with a
`CLOUDFLARE_API_TOKEN` CI variable. Either way, every `package.json` gains
`"deploy:sandbox": "wrangler deploy --env sandbox"` for first-time provisioning and emergencies,
mirroring the existing `deploy`.

**Code side done, 2026-09-22 (issue #16):** every `env.sandbox` Worker (`member-portal`,
`funraise-sync`, `donation-rollups`, `mailchimp-sync`, `quickbooks-sync`, `monday-backup`,
`benevity-import`, `bp-feedback-notify`) has the `deploy:sandbox` script, a "Workers Builds" note
in its README/DEPLOY.md naming its sandbox Worker and root directory, and a matching
`deploy-sandbox:<worker>` job in the root `.gitlab-ci.yml` gated on `CLOUDFLARE_API_TOKEN` so it
stays inert unless that variable is set. The dashboard-side verification above — whether
Cloudflare actually allows the second connection per Worker — is still a manual step for dwk;
this only makes the fallback real and ready rather than prose.

### 9. Moving the two already-deployed Workers

`svbc-donation-rollups` and `svbc-funraise-sync` are deployed under production names against
sandbox boards. Order, per Worker:

1. Land the code change (§1, §2, §5) with `sandbox.json` holding today's sandbox ids and
   `svbc.json` back on placeholders.
2. `wrangler d1 create svbc-<worker>-sandbox`; put the id in `env.sandbox`; apply migrations
   with `--env sandbox`.
3. Data: copy **both** D1s with `wrangler d1 export … --remote --output` and
   `wrangler d1 execute … --remote --file`. `funraise-sync`'s holds ingested sandbox events.
   `donation-rollups`' is mostly a derived index, but its `membership_baseline` table was
   captured once (2026-09-17) from board values that the rollups have since overwritten, so
   re-capturing it would not reproduce the original — copy rather than rebuild.
4. `wrangler secret put … --env sandbox` for each secret (sandbox integration user token, §4).
5. `npm run deploy:sandbox`; re-register each Monday webhook subscription at the
   `…-sandbox.workers.dev` URL; for `funraise-sync`, repoint Funraise's webhook.
6. Delete the production-named Worker (`wrangler delete --name svbc-<worker>`) once the sandbox
   deployment is verified. Leaving it deployed is not safe even with every subscription moved:
   its daily cron (the rollups custodian, the funraise-sync purge) would keep running the old
   build against the sandbox boards beside the new one. Its D1 and queues survive the delete;
   the production deploy at cutover recreates the Worker with production config.

`donor-portal`, `mailchimp-sync`, `quickbooks-sync`, `monday-backup`, `benevity-import` have
never been deployed, so they simply gain the environment before their first deploy, sandbox
first.

## Rollout order

1. **`donor-portal`** — the Worker whose outbound reaches donors directly, and the one that
   has been unable to complete an end-to-end test since 2026-08-22 because login is inert
   without delivery. Also carries the reference implementation of `environment.ts`, the config
   split, the split test, and the binding wrapper.
2. **`funraise-sync` and `donation-rollups`** — the §9 move, so the sandbox stops squatting on
   production names before October.
3. **`mailchimp-sync`, `quickbooks-sync`, `monday-backup`, `benevity-import`** — in any order,
   each gated on its vendor-side prerequisite below.

Each step is its own feature branch and MR, in its own worktree, and gets its own
implementation plan. The first plan covers step 1 only; steps 2 and 3 copy its `environment.ts`,
split test, and `env.sandbox` shape rather than re-deriving them.

## Testing

* Unit: `environment.ts` (unset → production; `sandbox`; anything else throws); the email
  wrapper (recipient rewritten, subject prefixed, body line prepended, original recipient never
  appears in `to`); `configFor` memoization; queue-router prefix matching for both names.
* Repo: `config/split.test.ts` per Worker (§5).
* Live, before the sandbox is declared usable for staff: from the sandbox portal, request a
  login link for a real donor email and confirm it lands **only** in `sandbox@`; then
  temporarily remove the code wrapper on a preview version and confirm the same request fails
  with `E_RECIPIENT_NOT_ALLOWED` in the logs — proving the platform layer alone holds. Restore.
* Live, per vendor: one Donor column change reaches the sandbox audience and not production
  (check both audiences); one Customer create appears in the Intuit sandbox company.

## Staff and operator prerequisites

These are not code and gate the corresponding rollout step:

* **Google Workspace group `sandbox@bikesiliconvalley.org`**, members: staff who test. Its
  posting policy must accept mail from `login@mail.bikesiliconvalley.org` (an external sender),
  or every redirected send bounces. Verify with the `wrangler email sending send` test from
  `donor-portal/DEPLOY.md` Phase 3 before the first sandbox deploy. Then add that address as a
  verified destination in Cloudflare Email Service (see Open items).
* **`portal-sandbox.bikesiliconvalley.org`** DNS on the Cloudflare zone (a custom domain the
  sandbox deploy attaches).
* **Monday:** the shared sandbox integration user with a member seat and access to workspace
  `17141226` only; its token.
* **Mailchimp:** the "SVBC Sandbox" audience with the six merge fields, the Interest Category,
  and its webhook.
* **Intuit:** a sandbox company under the SVBC developer account, development keys, a seeded
  token pair via the OAuth Playground, and a webhook subscription — the same manual step the
  production app needs, done twice.
* **Google Drive:** a "CRM Sandbox backups" folder shared with a sandbox service account.
* **Slack:** `#crm-sandbox` with an incoming webhook.

## Open items

* **Workers Builds, two connections on one root directory** — verify in the dashboard before
  step 1's deploy (§8 has the fallback).
* **Rate-limit namespace scope.** Whether `ratelimits[].namespace_id` must be unique per
  account or per Worker is not stated clearly in the docs read for this design; the sandbox
  uses `1002` either way, which is safe under both readings.
* **Confirmed 2026-09-18:** a `wrangler deploy --env sandbox --dry-run` on Wrangler 4.125
  accepted `ratelimits` and `routes` inside `env.sandbox` with no warning, and the production
  dry-run was unaffected. This confirms the config shape, not the namespace-scope question above,
  which stays open but is moot while the sandbox is a separate script.
* **Sink must be a verified destination address.** Sends to verified destination addresses are
  free and quota-exempt on every plan, and on Workers Free (SVBC's current plan) they are the
  only sends allowed. `sandbox@bikesiliconvalley.org` must therefore be added and verified under
  Email Service → Email Routing → Destination Addresses before the first sandbox deploy —
  `donor-portal/DEPLOY.md` lists it as a staff prerequisite. Production sends to donors are
  not verified-destination sends and need the Workers Paid plan.

## Decision history

* **Rejected: a separate `wrangler.sandbox.jsonc` per Worker.** Full duplication of queue and
  cron blocks across nine Workers with no inheritance; would drift. No advantage over
  `env.sandbox`.
* **Rejected: a runtime `SANDBOX=true` flag on a single deployment.** Cannot switch board ids at
  deploy time, offers no platform enforcement, and contradicts the parallel-environment
  decision.
* **Rejected: an "Outbound Log" Monday board.** A log tests nothing, adds a staff-facing
  surface to maintain, and Workers Logs already exist. Email goes to a real inbox instead so
  rendering is tested; vendor writes go to vendor sandboxes so the integration is tested.
* **Rejected: wrapping `EmailSender` instead of the binding.** The subject is composed inside
  `CloudflareEmailSender`, so a sender-level wrapper could not prefix it without widening the
  `EmailSender` interface. Wrapping the `SendEmail` binding sees the final message.
* **Rejected: one sandbox integration user per Worker.** Seats are the constraint; the
  workspace boundary is what matters.
* **Deferred: Funraise production-to-sandbox tee.** Wait for a real need.
