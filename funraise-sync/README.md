# funraise-sync

**Status:** Decided — Option B (full retirement). Build the direct sync.
**Priority:** Blocking-adjacent — feeds ongoing donation data once Salesforce retires; the
historical side is handled by `salesforce-import`, this Worker takes over going forward.
**Owner:** Unassigned.
**Stack:** Hono + TypeScript + D1 (`npm create cloudflare@latest`).

## The ask

Funraise is SVBC's live online-donation platform. Its Salesforce integration is a **managed
package** (`funraise` namespace) that is **one-directional and Salesforce-only** — it has no
Monday.com connector. Once Salesforce retires, something has to replace it as the path from
"someone donates on Funraise" to "a Donations item exists on Monday."

Full survey of the existing Salesforce-side pipeline:
`docs/01-funraise-pipeline-current-state.md` (private planning repo).

## Blocking precondition — resolved 2026-08-22

The live pipeline's 157 sync errors (2026-04-06 → 2026-08-05) were reconciled directly against
Funraise and the error log cleared — see `docs/12-funraise-sync-error-fix.md` (private planning
repo). The originally suspected `Contact.Primary_Email__c` case-sensitivity root cause turned out
to be wrong. Historical data this Worker's donor-matching logic is tested against can now be
trusted; a handful of individual records still need human follow-up, tracked in that doc.

## Data flow

```
Funraise (SaaS)
  │  webhook, on new/updated Transaction/Subscription/Pledge/Registration
  ▼
Cloudflare Worker (webhook handler)
  │  1. verify webhook, strip do-not-migrate PII fields, upsert into D1 `events`
  │     (keyed on the *entity* — a later event for a known Transaction/Subscription/
  │     Pledge/Registration replaces its payload instead of being dropped as a duplicate)
  │  2. enqueue a Cloudflare Queue message referencing the entity
  ▼
Cloudflare Queue → consumer Worker
  │  1. resolve donor → Donors-board item (matching step)
  │  2. write to Monday via GraphQL: create the item on first sight, update it in place
  │     on later events for the same entity
  │  on failure at either step, Queues retries automatically and, once exhausted, routes
  │  to a Dead Letter Queue instead of the match or write silently disappearing
  ▼
Donations board / Recurring Gifts board / Registration board (ids in config/svbc.json)
```

Ingestion, matching, and the Monday write are separate, independently testable steps. Matching
runs in the queue consumer — not the webhook handler — so a transient Monday API failure during
*matching or writing* gets the Queue's retries and DLQ instead of dying inside the webhook
request. A daily cron empties `raw_payload` for events written more than
`funraiseSync.rawPayloadRetentionDays` (default 90) days ago, so raw donor PII doesn't accumulate
in D1 indefinitely. See `../README.md`'s Reliability section for why the Queue shape is standard
across every webhook-driven Worker in this plan.

## APIs & auth

* **Funraise REST API + webhooks** — self-serve, included on all paid plans. Rate limit: 3,000
  requests/month base, 10,000/month on "API Plus." [API overview](https://help.funraise.io/en/articles/10518268-funraise-api) ·
  [API reference](https://funraise.stoplight.io/docs/funraise/44e37c461ba67-funraise-api) ·
  [Webhooks](https://help.funraise.io/en/articles/4471107-webhooks).
* **Webhook auth**: one-time signing-secret handshake (`x-hook-secret`). **Unconfirmed**: whether
  individual deliveries also carry a per-event signature — check the full docs before assuming
  request authenticity extends beyond the initial handshake.
* **Monday.com GraphQL API** — standard API token, same pattern as every other Worker here.

## Donor matching

Match incoming Funraise donor to an existing Donors-board item by email, or by a new **Funraise
contact ID** text column mirroring the existing Salesforce ID column pattern. Reuse the
`funraise__fr_ID__c` external-ID convention from the Salesforce side rather than inventing a new
identifier scheme.

## Field mapping

Full column-by-column mapping (Donations ← Opportunity/Transaction fields, Recurring Gifts ←
Subscription, status-value mapping where `Posted` — not `Closed Won` — is the real success state,
and the full do-not-migrate list) lives in
`docs/03-monday-migration-mapping.md` (private planning repo) — this
Worker's write step should follow that mapping exactly, not redefine it. Notably: **Pledge and
Subscription are a confirmed 1:1 duplicate** — do not create separate items for both; **8 email
fields collapse to one** with precedence `npe01__Preferred_Email__c` → `Primary_Email__c` →
`Email`; **payment-method fields (last four, expiration) are PII and must never be written to
Monday**.

## Related, not yet in scope here

* **Double the Donation / 360MatchPro** — a *third*, independent pipeline (Salesforce AppExchange
  managed package, writes match data directly to Salesforce, doesn't ride on Funraise's
  connection). Not this Worker's job to replicate yet — first the actual custom fields it created
  need identifying (Pre-Migration Deliverables), then a decision on whether to build a companion
  sync or fold match data into `salesforce-import` as a one-time carry-over.
  [Double the Donation](https://doublethedonation.com/) ·
  [360MatchPro on Salesforce AppExchange](https://appexchange.salesforce.com/appxListingDetail?listingId=a0N3A00000FR4jnUAD).
* **Streamlabs Charity** — possible fourth donation pipeline (stream-driven donations via a Twitch/
  Streamlabs setup just discovered), unconfirmed and its API is
  [undocumented/unofficial](https://gist.github.com/Durss/c5c09ed46bee5283757b0c91050d2b8b). Treat
  as a discovery problem before any build, same as Funraise's mechanism was until this survey.

## Sources

* `docs/01-funraise-pipeline-current-state.md` (private planning repo)
* `docs/02-entity-field-inventory.md` (private planning repo)
* `docs/03-monday-migration-mapping.md` (private planning repo)
* [Funraise integrations page](https://www.funraise.org/integrations)
* [Funraise API overview](https://help.funraise.io/en/articles/10518268-funraise-api)
* [Funraise API reference (Stoplight)](https://funraise.stoplight.io/docs/funraise/44e37c461ba67-funraise-api)
* [Funraise webhooks](https://help.funraise.io/en/articles/4471107-webhooks)
* Plan section: Funraise (Integrations) — `migration-plan.md` (private planning repo)
