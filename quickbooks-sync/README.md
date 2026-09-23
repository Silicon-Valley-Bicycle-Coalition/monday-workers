# quickbooks-sync

**Status:** Built — rules out the Monday Ultimate-plan upgrade and the QuickBooks Complete
Marketplace app (both carry an ongoing cost this avoids). 133 tests passing across 19 files;
webhook routes, OAuth token store, rate limiting, and both sync directions are implemented. The
sandbox environment's Cloudflare side (D1, queues, `MONDAY_API_TOKEN`, `MONDAY_WEBHOOK_SECRET`) is
provisioned and verified (2026-09-22), and the Intuit app-review question is resolved, but it's
still not connected to a real QuickBooks company — that needs an Intuit developer account and app
credentials, a staff/admin task (see "Sandbox environment" and "Open question" below), which
hasn't happened yet.
**Priority:** Post-migration, non-blocking — nothing here affects Salesforce cutover readiness.
**Owner:** Unassigned.
**Stack:** Hono + TypeScript + D1, same shape as `funraise-sync`.

## The ask

Sync Customers and Invoices/Products between QuickBooks Online and Monday. Monday's native
QuickBooks integration requires the **Ultimate** plan (SVBC is on Pro) and even then doesn't
support `connect boards`, `dropdown`, `location`, `files`, or `link` columns as sync targets. A
paid Marketplace alternative ([QuickBooks Complete](https://monday.com/marketplace/10000070))
exists but also costs money on an ongoing or one-time-upgrade basis.

## Data flow

```
QuickBooks Online
  │  webhook: change notification only (no payload — just "something changed")
  ▼
Cloudflare Worker (webhook handler)
  │  1. webhook receiver logs the notification to D1
  │  2. follow-up step calls the QuickBooks API to fetch the actual changed record
  │  3. enqueues a Cloudflare Queue message with the fetched record
  ▼
Cloudflare Queue → consumer Worker
  │  writes the record to the relevant Monday board; on failure, Queues retries automatically
  │  and, once exhausted, routes to a Dead Letter Queue rather than dropping the write
  ▼
Monday.com
```

See `../README.md`'s Reliability section — this Queue step is standard across every webhook-driven
Worker in this plan, not QuickBooks-specific. Without it, a transient Monday API failure on the
final write just silently disappears.

## APIs & auth

* **QuickBooks Online Accounting API** — free up to 500,000 read operations/month on the Builder
  tier (SVBC's volume should sit well under that); rate-limited at 500 requests/minute per company.
  [Pricing & rate limits](https://truto.one/blog/how-much-does-the-quickbooks-api-cost-2026-pricing-rate-limits/) ·
  [Integration guide](https://www.getknit.dev/blog/quickbooks-online-api-integration-guide-in-depth).
* **Auth**: standard OAuth2, same pattern as every other Worker here.
* **Webhooks** signal only that a record changed — the payload itself doesn't carry the changed
  data, so every webhook triggers a follow-up API read.

## Secrets

Set with `wrangler secret put <NAME>` (never commit them) — the full list with descriptions is in
`wrangler.jsonc`'s comments: `MONDAY_API_TOKEN`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`,
`QB_WEBHOOK_VERIFIER_TOKEN`, `MONDAY_WEBHOOK_SECRET`.

Monday doesn't sign webhook payloads, so the Monday webhook is authenticated by
`MONDAY_WEBHOOK_SECRET` embedded in the subscription URL (same pattern as `mailchimp-sync`, but
fail-closed — the route 401s everything, including the challenge handshake, until the secret is
set). Register the webhook subscription on the Customers board as
`https://<worker>/webhooks/monday?secret=<MONDAY_WEBHOOK_SECRET>`, and **re-register the
subscription whenever the secret rotates** — an existing subscription keeps the old URL and will
be rejected.

## Sandbox environment — inbound only, no outbound data

`npm run deploy:sandbox` deploys `svbc-quickbooks-sync-sandbox` (`wrangler.jsonc` `env.sandbox`)
against **Intuit's sandbox host** — `config/sandbox.json`'s `quickbooks.apiBaseUrl` is
`https://sandbox-quickbooks.api.intuit.com/v3/company`, chosen at request time by the
`ENVIRONMENT` var (`src/environment.ts`); the host moved out of `src/quickbooks/client.ts` into
config for exactly this. A sandbox company is reachable only with the app's *development* keys,
so `QB_CLIENT_ID`/`QB_CLIENT_SECRET` and the seeded token pair are different secrets per
environment (`wrangler secret put … --env sandbox`), and a production key presented to the sandbox
host fails authentication. `config/split.test.ts` fails if the two configs ever share the host.
Own D1 and queue (`quickbooks-sync-writes-sandbox` and its `-dlq`). Local development against the sandbox uses `npm run dev:sandbox`; `npm run dev` targets the production config and, once production secrets exist in `.dev.vars`, would write to production sinks. Monday board ids are `null`
in both configs until the Customers/Invoices/Products boards exist. Staff prerequisites (the step 3
plan's Task 15): an Intuit sandbox company, development keys, a token pair seeded via the OAuth
Playground, and a webhook subscription. `npm run deploy:sandbox` fails until
`env.sandbox.d1_databases[0].database_id` is replaced with the id `wrangler d1 create` prints.
Design: `../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.

**Provisioned and verified 2026-09-22:** D1 `svbc-quickbooks-sync-sandbox` (id wired 2026-09-20)
and both queues (`quickbooks-sync-writes-sandbox`, `-dlq`) exist. Found and closed a gap: the
`0002_qb_events_pending_monday_item_id` migration (added 2026-09-21, after the D1 id was wired)
had never been applied to the remote sandbox database — `wrangler d1 migrations list --env
sandbox --remote` showed it pending, so the deployed Worker's queue consumer would have failed
writing that column on its first real message. Applied it and confirmed
`qb_events.pending_monday_item_id` exists via `PRAGMA table_info`. `config/split.test.ts`, the
full unit suite, `wrangler types && tsc --noEmit`, and `wrangler deploy --dry-run --env sandbox`
all pass; the sandbox Worker itself auto-deployed via Workers Builds on the 2026-09-21 merge to
main. **`MONDAY_API_TOKEN` set 2026-09-22** — reused the existing shared `Sandbox Integration`
user (`dwk+sandbox-integration@bikesiliconvalley.org`, the single sandbox-wide integration user
the [sandbox design](../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md) §4
calls for; verified via a `me` query before use, not minted fresh so the other sandbox Workers
already using it keep working). **`MONDAY_WEBHOOK_SECRET` generated and set 2026-09-22** — a
fresh random value (this one doesn't come from an external account, so no reuse concern); a copy
is saved in this Worker's gitignored `.dev.vars` for when the Monday webhook subscription is
registered as `.../webhooks/monday?secret=<value>`. **Not yet done:** `QB_CLIENT_ID`,
`QB_CLIENT_SECRET`, and `QB_WEBHOOK_VERIFIER_TOKEN` remain unset, and Monday board ids are still
`null` — these wait on the staff prerequisites above (an Intuit sandbox company and development
keys, a token pair seeded via the OAuth Playground) plus the Intuit app-review question below,
now resolved.

## Open question before starting — resolved 2026-09-21

**A private, single-company integration does not need the full app-store review, but does need a
shorter self-assessment questionnaire — confirmed directly from Intuit's own FAQ:**

> I have a private app and don't plan to list it on the app store. Do I still need to submit this
> questionnaire? Yes. If your app has any connections to production QuickBooks Online companies,
> you will need to submit this questionnaire even if your app is not listed on the QuickBooks App
> store. The app assessment and compliance process applies to both private (i.e. unlisted) apps
> and apps that are, or want to be listed, on the QuickBooks App Store.
>
> What is the difference between the current technical, legal, security, and marketing reviews
> and the new app assessment? Apps that you submit to be published on the QuickBooks app store
> undergo an in-depth technical, legal, security, and marketing review annually. These in-depth
> reviews only apply to apps that are listed on the app store. Any app that requests access to
> production data must undergo the new self-assessment process.
>
> — [App assessment and compliance FAQ](https://help.developer.intuit.com/s/article/New-app-assessment-process-FAQ) (Intuit Developer)

So for this Worker: no annual technical/legal/security/marketing review (that's app-store-listing
only), but the ~40-minute self-assessment questionnaire is still required before production keys
are issued, whether or not the app is ever listed — confirmed independently in a
[developer-forum answer](https://help.developer.intuit.com/s/question/0D54R00008fCxd7SAC/production-keys-credentials-for-single-company-use-only-internal-use-only)
to the exact "single company use only / internal use only" question: *"This applies to all apps,
whether or not they are listed in the QuickBooks app store."* Whoever sets up the Intuit developer
account and app credentials (staff prerequisite, above) should budget for that questionnaire —
it's a one-time step, not a lightweight skip, but also not the multi-week review this question
was worried it might be.

## Sources

* [App assessment and compliance FAQ (Intuit Developer)](https://help.developer.intuit.com/s/article/New-app-assessment-process-FAQ)
* [How Much Does the QuickBooks API Cost? (Truto)](https://truto.one/blog/how-much-does-the-quickbooks-api-cost-2026-pricing-rate-limits/)
* [QuickBooks Online API Integration Guide (getknit.dev)](https://www.getknit.dev/blog/quickbooks-online-api-integration-guide-in-depth)
* [QuickBooks Integration (Monday.com native, not used)](https://support.monday.com/hc/en-us/articles/25274611229330-QuickBooks-Integration)
* [QuickBooks Complete (Marketplace, not used)](https://monday.com/marketplace/10000070)
* Plan section: QuickBooks (Integrations) — `migration-plan.md` (private planning repo)
