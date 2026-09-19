# quickbooks-sync

**Status:** Decided — build the Cloudflare Workers sync, rules out the Monday Ultimate-plan
upgrade and the QuickBooks Complete Marketplace app (both carry an ongoing cost this avoids).
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
Own D1 and queue (`quickbooks-sync-writes-sandbox` and its `-dlq`). Monday board ids are `null`
in both configs until the Customers/Invoices/Products boards exist. Staff prerequisites (the step 3
plan's Task 15): an Intuit sandbox company, development keys, a token pair seeded via the OAuth
Playground, and a webhook subscription. `npm run deploy:sandbox` fails until
`env.sandbox.d1_databases[0].database_id` is replaced with the id `wrangler d1 create` prints.
Design: `../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.

## Open question before starting

Confirm with Intuit whether a **single-company internal integration** (as opposed to a public
app-marketplace listing) needs the same formal app review as a multi-tenant product — the docs
reviewed for this plan don't make that distinction clear. Resolve before assuming the OAuth setup
is as lightweight as a typical internal tool.

## Sources

* [How Much Does the QuickBooks API Cost? (Truto)](https://truto.one/blog/how-much-does-the-quickbooks-api-cost-2026-pricing-rate-limits/)
* [QuickBooks Online API Integration Guide (getknit.dev)](https://www.getknit.dev/blog/quickbooks-online-api-integration-guide-in-depth)
* [QuickBooks Integration (Monday.com native, not used)](https://support.monday.com/hc/en-us/articles/25274611229330-QuickBooks-Integration)
* [QuickBooks Complete (Marketplace, not used)](https://monday.com/marketplace/10000070)
* Plan section: QuickBooks (Integrations) — `migration-plan.md` (private planning repo)
