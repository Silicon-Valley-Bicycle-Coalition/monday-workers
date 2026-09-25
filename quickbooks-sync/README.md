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
  │  2. enqueues a Cloudflare Queue message naming the D1 row (a failed enqueue answers 500, so
  │     Intuit redelivers)
  ▼
Cloudflare Queue → consumer Worker
  │  calls the QuickBooks API to fetch the changed record as it stands now, then writes it to the
  │  relevant Monday board; on failure, Queues retries with backoff and, once exhausted, routes
  │  to a Dead Letter Queue rather than dropping the write
  ▼
Monday.com
```

The fetch lives in the consumer, not the webhook (#33): a fetch failure inside the webhook used
to mark the row failed and still answer 200, so Intuit never redelivered and the change was lost;
and a snapshot taken at webhook time could later overwrite Monday with stale data. The webhook
now never calls QuickBooks — which also means only the consumer ever refreshes the OAuth token.

See `../README.md`'s Reliability section — this Queue step is standard across every webhook-driven
Worker in this plan, not QuickBooks-specific. Without it, a transient Monday API failure on the
final write just silently disappears.

**Create loop guard (#33).** A Customer created in QuickBooks becomes a Monday item before its
`qb_monday_map` row exists, and Monday's `create_pulse` webhook for that item can arrive in
between. The guard lives on the item itself: the Customers board has a **QuickBooks Id** text
column (`config` `quickbooksSync.customerQbIdColumn`), which QuickBooks → Monday writes in the
same `create_item` call that makes the item (and on every update), and Monday → QuickBooks writes
after every Customer it creates. Before creating a Customer, the Monday → QuickBooks path
(1) re-checks the mapping, (2) adopts the item if a `qb_events` row recorded it as
`pending_monday_item_id`, then (3) re-reads the item from Monday and adopts the QuickBooks Id it
carries — so even an item whose `create_item` response was lost is never turned into a second
Customer. An item carrying an Id already linked to a different item (a copied item) is refused.
The QuickBooks → Monday path likewise looks for an item that already stands for the Customer
(one that created it from Monday, or one found by the QuickBooks Id column) before creating one.
Nothing defers or blocks unrelated items. A mapping is never silently re-pointed: if a record
turns out to have two live items (e.g. a Monday → QuickBooks create whose response was lost, with
QuickBooks' own webhook making a second item before the retry), the row fails terminally with
"QuickBooks customer … already has Monday item …, and item … also stands for it". Archive the
duplicate item in Monday and redrive; a link whose item is archived or deleted is moved. **Until `customerQbIdColumn` is set, Monday →
QuickBooks Customer creates are refused** ("not retried", no DLQ) — they can't be made loop-safe
without it. Customer creates also send Intuit's `requestid`, so a retried create whose first
response was lost returns the original Customer instead of a second one.

## Deletes and merges

Intuit notifications carry an `operation`. A **Delete** is acknowledged and logged but not synced
— the record can no longer be fetched — and its Monday item is left in place for staff to archive;
the Worker never deletes Monday items. A **Merge** syncs the surviving record like an update and
logs the merged-away id (`deletedId`); that record's Monday item and `qb_monday_map` row are left
for staff to reconcile. A record deleted before its update is processed fails the fetch with
`610 Object Not Found`, which is terminal (recorded, not retried). Other operations (Create,
Update, Void, Emailed) sync as updates.

## Dead letters and redrive

A consumer failure retries with backoff (1, 4, 16 minutes — `retryDelaySeconds` in
`src/consumer/processBatch.ts`); after three retries the message lands in
`quickbooks-sync-writes-dlq` (`-sandbox-dlq` in the sandbox). The Worker consumes that queue too
(`src/consumer/processDeadLetters.ts`): the row in `qb_events` / `monday_events` keeps
`status = 'failed'` and its last error gains the prefix `dead-lettered after retries: `, and each
batch logs one `console.error`. Nothing is retried from there automatically.

**Terminal failures are not retried at all.** When QuickBooks rejects the data itself (a 400
`ValidationFault` — e.g. `6240 Duplicate Name Exists`, a missing required field, `610 Object Not
Found`), or a Monday item no longer exists / has no name / carries a QuickBooks Id already linked
elsewhere, the consumer records `not retried: <Intuit's code, message and detail>` on the row and
acks the message — no retries, no DLQ.

To find rows needing attention: `wrangler d1 execute <db> --remote --command "SELECT event_id,
error FROM monday_events WHERE status = 'failed'"` (same for `qb_events`); the error says whether
it was dead-lettered or not retried. Fix the cause first — for a Monday → QuickBooks create, that
usually means editing the item in Monday (rename a duplicate, fill in the name); the consumer
re-reads the item on every attempt, so the fix is what gets sent. Then redrive by sending the
row's message to the write queue — Cloudflare dashboard → Queues → `quickbooks-sync-writes` →
*Send message*, body `{"direction":"monday-to-qb","eventId":"<Monday item id>"}` (or
`"qb-to-monday"` with the `qb_events.event_id`). Every consumer step is idempotent against its D1
row, so a redrive of a row that half-finished resumes rather than duplicates. A Monday → QuickBooks
create sends Intuit `requestid=monday-item-<id>[-r<n>]`: `n` (`monday_events.create_attempt`)
advances on each terminal failure, so a redrive after one is a new request rather than a replay
of the cached failure, while retries and redrives after transient failures reuse it (a create
whose response was lost must return the original Customer).

## APIs & auth

* **QuickBooks Online Accounting API** — free up to 500,000 read operations/month on the Builder
  tier (SVBC's volume should sit well under that); rate-limited at 500 requests/minute per company.
  [Pricing & rate limits](https://truto.one/blog/how-much-does-the-quickbooks-api-cost-2026-pricing-rate-limits/) ·
  [Integration guide](https://www.getknit.dev/blog/quickbooks-online-api-integration-guide-in-depth).
* **Auth**: standard OAuth2, same pattern as every other Worker here.
* **Webhooks** signal only that a record changed — the payload itself doesn't carry the changed
  data, so every webhook triggers a follow-up API read.

## OAuth tokens

The token pair lives in D1 (`qb_oauth_tokens`, one row). Only the queue consumer calls
QuickBooks, and it refreshes the access token a minute before expiry. Intuit rotates the refresh
token and expires the previous one, so refreshes have a single writer (#33): the refresher takes a
D1 lease at the row's `version` and saves by compare-and-swap on it; other callers wait and
re-read. On `invalid_grant` the consumer re-reads D1 and uses a newer pair if one landed;
otherwise the message fails with "re-seed the token pair" and retries/dead-letters.

To seed or re-seed (initial handshake, or after that error), get a fresh pair from Intuit's OAuth
Playground and write it with an expiry in the past so the first call refreshes immediately:

```sh
npx wrangler d1 execute <db> --remote [--env sandbox] --command "
  INSERT INTO qb_oauth_tokens (id, realm_id, access_token, refresh_token, access_token_expires_at, updated_at)
  VALUES (1, '<realmId>', '<accessToken>', '<refreshToken>', '1970-01-01T00:00:00.000Z', datetime('now'))
  ON CONFLICT (id) DO UPDATE SET realm_id = excluded.realm_id, access_token = excluded.access_token,
    refresh_token = excluded.refresh_token, access_token_expires_at = excluded.access_token_expires_at,
    updated_at = excluded.updated_at, version = version + 1,
    refresh_lease_token = NULL, refresh_lease_until = NULL"
```

Bumping `version` makes any refresh in flight against the old pair lose its compare-and-swap
instead of overwriting the new one.

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

**Workers Builds:** connect a second Worker, `svbc-quickbooks-sync-sandbox`, to this repo with
root directory `/quickbooks-sync`, production branch `main`, and deploy command
`npx wrangler deploy --env sandbox`. The sandbox then tracks `main` alongside production. If the
dashboard refuses two connections on one root directory, fall back to the
`deploy-sandbox:quickbooks-sync` job in `../.gitlab-ci.yml` — same command, gated on a
`CLOUDFLARE_API_TOKEN` CI variable so it stays inert until that variable is set.

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
