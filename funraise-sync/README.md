# funraise-sync

**Status:** Decided — Option B (full retirement). Build the direct sync. **Deployed to the CRM
Sandbox and receiving Funraise's live webhook since 2026-09-18** — see "Deployed and verified".
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
`funraiseSync.rawPayloadRetentionDays` (default 90) days ago, and for events that never completed
their write once they're older than `unresolvedPayloadRetentionDays` (default 365), so raw donor
PII doesn't accumulate in D1 indefinitely on either path. Created items are stamped with the
Funraise entity id (`funraiseSync.entityIdColumn`), which the consumer checks before every create
so a retry after a lost status update adopts the existing item instead of duplicating it. See `../README.md`'s Reliability section for why the Queue shape is standard
across every webhook-driven Worker in this plan.

## APIs & auth

* **Funraise REST API + webhooks** — self-serve, included on all paid plans. Rate limit: 3,000
  requests/month base, 10,000/month on "API Plus." [API overview](https://help.funraise.io/en/articles/10518268-funraise-api) ·
  [API reference](https://funraise.stoplight.io/docs/funraise/44e37c461ba67-funraise-api) ·
  [Webhooks](https://help.funraise.io/en/articles/4471107-webhooks).
* **Webhook auth**: Funraise's own mechanism is a one-time REST-Hooks subscribe handshake
  (`x-hook-secret`), and it's unconfirmed whether individual deliveries carry any per-event
  signature — so this Worker does not rely on it for request authenticity. Instead, every
  delivery must carry a shared secret in the webhook URL's query string, checked on every POST:

  1. `wrangler secret put FUNRAISE_WEBHOOK_SECRET` (generate a long random value, e.g.
     `openssl rand -hex 32`).
  2. Register the webhook URL in Funraise **with that secret embedded**:
     `https://<worker-host>/webhooks/funraise/<entityType>?secret=<value>`.

  The route **fails closed**: any POST whose `secret` query param doesn't match — including
  every POST while the secret is unset — is rejected with 401. The `x-hook-secret` handshake is
  still honored, but only after the secret check passes, and only when the request body isn't a
  valid event payload (empty body or non-event shape); a valid event that happens to carry an
  `x-hook-secret` header is processed normally, so a per-delivery secret can never swallow real
  deliveries.

  Registering it, as done 2026-09-18: Funraise → Settings → Webhooks, one webhook per org. The
  card shows a **Webhook Signing Secret** (three-dot menu → Generate) — that value is *Funraise's*,
  sent as the `x-hook-secret` header on its verify call; it is **not** the URL secret and never
  goes into this Worker. Then Edit → Webhook Target URL (the full URL above, transaction path,
  `?secret=` = the Worker secret) + Contact Email (delivery-failure notices after ~24 h of
  retries) → Save. Save fires the verify call; the webhook only flips from Disabled to Enabled
  when the Worker answers 200 with the header echoed. The first attempt stayed Disabled because
  the signing secret had been pasted over the URL secret in the shared `.env`, the URL was built
  from it, and the Worker answered 401 — so if it reads Disabled after Save, check which secret is
  in the URL before anything else. The drawer's **Test** button sends a real `DONATION` delivery
  (transaction id `-1`, supporter "Lorem Ipsum", `donor@example.com`, amount 123.12, status
  Complete); the Worker treats it like any gift, so expect a donor and a Donations item to clean
  up afterwards (see "Deployed and verified").
* **Monday.com GraphQL API** — standard API token, same pattern as every other Worker here.

## Donor matching

Match incoming Funraise donor to an existing Donors-board item by email, or by a new **Funraise
contact ID** text column mirroring the existing Salesforce ID column pattern. Reuse the
`funraise__fr_ID__c` external-ID convention from the Salesforce side rather than inventing a new
identifier scheme.

In practice the sandbox v2 People board carries that id as a **link** column, `Funraise Profile`
(`link_mm6j7djp`, `https://platform.funraise.io/supporter/<id>` with the bare id as the link
text), because `salesforce-import` writes it that way — not as a text column. Verified live
2026-09-17: `items_page_by_column_values` on that column matches the bare id (`3682773` found its
person; the display text and the url did not), and on `Personal Email` (`email_mm6j5e9q`) it
matches the address. So the two lookups in `matchDonor` pass the bare id and the bare address.
The *create* path writes the shapes those columns require — `{url, text}` with the supporter
URL for the link column and `{email, text}` for the email column (Monday rejects bare strings on
both; see `salesforce-import`'s `load/columnValues.ts`) — so a donor this Worker creates looks
like a migrated one. Funraise sends `supporter.id` as a **number**; it is stringified before the
lookup and the write. `donorExternalIdColumn` must therefore be a link column and
`donorEmailColumn` an email column; a fork with a plain text id column changes `matchDonor`.

## Monday targets (sandbox v2 ids, verified live 2026-09-17)

`config/svbc.json` now carries the real ids for the CRM Sandbox v2 boards — the same boards
`salesforce-import` loads and `donation-rollups` reads — instead of placeholders. Re-verify
against production ids before cutover; the sandbox gets rebuilt. Every id below was read from the
board schemas via the Monday API on 2026-09-17.

| Config key | Board / column | Id | Notes |
|---|---|---|---|
| `monday.boards["donations:live"]` | Donations (sandbox v2) | `18428131791` | |
| `monday.boards["recurring-gifts"]` | Recurring Gifts (sandbox v2) | `18428131768` | |
| `monday.boards["event-registrations"]` | Event Registrations (sandbox v2) | `18428131782` | |
| `monday.boards["people-live"]` | People (sandbox v2) | `18428131737` | People (Historical) is not a match target |
| `columnMap.transaction["transaction.amount"]` | Donations → Amount (numbers) | `numeric_mm6jkxrs` | Funraise nests amount and status under `transaction` |
| `columnMap.transaction["transaction.status"]` | Donations → Status (status) | `color_mm6jqdhn` | labels: Received / Received (Historical) / Failed / Pending; `Complete → Received` via `statusValueMap` |
| `columnMap.transaction.donationDate` | Donations → Date (date) | `date_mm6jthpq` | epoch ms in, `{ date: 'YYYY-MM-DD' }` out — see "Fiscal Year Ending" |
| `columnMap.recurringGift.amount` | Recurring Gifts → Installment Amount (numbers) | `numeric_mm6jg878` | per-installment, per docs/03 |
| `columnMap.recurringGift.frequency` | Recurring Gifts → Frequency (status) | `color_mm6jc24s` | labels: Monthly / Yearly / Quarterly — a **status**, not text; the raw value must equal a label |
| `columnMap.recurringGift.status` | Recurring Gifts → Status (status) | `color_mm6j1tk1` | labels: Redacted / Active / Cancelled / Failed |
| `columnMap.registration` | Event Registrations | `{}` | see below |
| `entityIdColumn` | — | `null` | see below |
| `thankYouSentColumn` | Donations → Thank You Sent (checkbox) | `boolean_mm78nf5s` | |
| `giftTypeColumn` | Donations → Gift Type (text) | `text_mm6j66w3` | |
| `fiscalYearColumn` | Donations → Fiscal Year Ending (text) | `text_mm70czyd` | |
| `donorExternalIdColumn` | People → Funraise Profile (link) | `link_mm6j7djp` | lookup works; create-write shape is a code gap |
| `donorEmailColumn` | People → Personal Email (email) | `email_mm6j5e9q` | same |
| `donorLinkColumn` | Donations → Donor (connect) | `board_relation_mm6jf5jb` | Donations only; see below |

Three placeholders became something other than an id, on purpose:

* **`columnMap.transaction.description` is gone.** The Donations board has no description text
  column; `description` is already the item name via `itemNameField`. The importer's
  `Salesforce Debug` long-text is provenance, not a description, and stays untouched.
* **`columnMap.registration` is empty.** Event Registrations has no text column for an event
  name and no date column for a registration time: `Event` is a connect column to the Events
  board (`board_relation_mm6jatgp`, needs an Events item id, not a name), and the remaining
  columns (Attendee Name/Email, Ticket Amount, Deductible Amount, Ticket Type, Attendance, Role,
  Source) map to Funraise registration fields this Worker has never seen a payload for. Mapping
  those needs a verified payload, not a guess. `itemNameField.registration` still names the item.
* **`entityIdColumn` is `null`.** The column it was meant to be — a text id "on every target
  board" — doesn't exist on these boards. Donations and Recurring Gifts carry the Funraise id in
  a **link** column (`link_mm6jhcj8` and `link_mm6jryz2`, transaction URL + bare id as text, the
  same shape as `Funraise Profile`), Event Registrations has none, and the ids differ per board
  while the config key is a single string. The lookup half would work (bare-id search on the
  Donations link column found its item, verified live), but the consumer writes `entityId` as a
  bare string, which Monday rejects on a link column, so every create would fail. `null`
  disables orphan recovery (a retry after a lost status update can duplicate an item) rather
  than break creates. Fix is code: per-board ids plus link-shaped values, tracked below.
* **`donorLinkColumn` is the Donations board's `Donor` column only.** Recurring Gifts' `Donor`
  is `board_relation_mm6j443g` and Event Registrations' `Attendee` is `board_relation_mm6j98ft`;
  the config key is a single string, so subscription/pledge/registration items would be written
  with a column id that doesn't exist on their board. Same per-board fix as `entityIdColumn`.

## Field mapping

Full column-by-column mapping (Donations ← Opportunity/Transaction fields, Recurring Gifts ←
Subscription, status-value mapping where `Posted` — not `Closed Won` — is the real success state,
and the full do-not-migrate list) lives in
`docs/03-monday-migration-mapping.md` (private planning repo) — this
Worker's write step should follow that mapping's *targets* exactly, not redefine them; its
*source* field names are the Salesforce package's, not the webhook's (see "The Funraise
delivery, as actually sent" for the translation). One board-side constraint on top of that doc:
`config/svbc.json` maps the webhook's `Complete` to `Received` (the doc's `Posted` is the same
gift as seen from Salesforce) because the Donations board's status vocabulary (seeded by
`salesforce-import`) is exactly `Received` /
`Received (Historical)` / `Failed` / `Pending`, and `donation-rollups` counts only `Received` —
mapping to any label outside that set silently drops the gift from rollups. Notably: **Pledge and
Subscription are a confirmed 1:1 duplicate** — do not create separate items for both; **8 email
fields collapse to one** with precedence `npe01__Preferred_Email__c` → `Primary_Email__c` →
`Email`; **payment-method fields (last four, expiration) are PII and must never be written to
Monday**.

**`Fiscal Year Ending` is stamped on create (derived, not mapped).** The Donations board has a
text `Fiscal Year Ending` column that `salesforce-import` writes on every migrated gift (SVBC's
July–June fiscal year, named for the year it ends in, so a 2026-08-15 gift is FY 2027 and a
2026-06-30 gift is FY 2026). It isn't a Funraise field, so `columnMap.transaction` can't map it;
instead the consumer derives it from the transaction's `donationDate` (Funraise sends epoch
milliseconds; `toISODate` in `src/util/isoDate.ts` normalizes it to a UTC `YYYY-MM-DD`, which is
also the value written to the Date column as `{ date }`, so the two never disagree) with
`fiscalYearEnding()` in `src/mapping/fiscalYear.ts` (same July rule as `salesforce-import`'s
`fiscalYear()` and `donation-rollups`' `fiscalYearFromDate`) and writes it as a string to
`funraiseSync.fiscalYearColumn`. Decided 2026-09-17 (see `donation-rollups`'s README, "Fiscal
year, not calendar year"): `donation-rollups` treats a blank cell as missing and derives from
Date, but will *not* backfill the column, so the writer that creates the item owns it. Rules,
matching `Thank You Sent`: transactions only (never recurring gifts or registrations); first
write only, including adoption of an orphaned item, never a later update that could clobber a
staff correction; a missing or unparseable `donationDate` logs a warning and leaves the cell
blank, and leaves the Date column out too rather than writing a raw number (rollups then derive
from whatever Date holds). Set `fiscalYearColumn` to `null`
for a board without the column. `config/svbc.json` points it at `text_mm70czyd`, the text column
titled "Fiscal Year Ending" on the sandbox v2 Donations board (`18428131791`, verified live
2026-09-17) — the same one `donation-rollups` reads — not the older numbers column titled "Fiscal
Year" (`numeric_mm6jm0g4`) that `salesforce-import` no longer stamps. Known edge: the year is read
from the UTC date of `donationDate`, the same way the Date column is written, so a gift made
between 5 pm and midnight Pacific on June 30 lands in the new fiscal year on both columns.

## Acknowledgment / receipting

**Decided (private planning repo, `migration-plan.md` Decisions Needed, 2026-08-24, Option 2):**
this Worker sets `Thank You Sent = true` when it creates a Donations item, treating Funraise's own
transaction-time donor receipt as satisfying Salesforce's donation-acknowledgment automation for
Funraise-sourced gifts. Hand-entered gifts (checks, cash) are out of scope here — staff handle
those manually, unchanged from today.

**Verified 2026-08-24.** `GET /api/v1/form` against the live `svbc` Funraise org (`X-Api-Key` auth,
see API & auth below) returned all 20 active forms with a fully populated `receiptFromEmail`,
`receiptFromName`, `receiptSubject`, and merge-tagged HTML `emailResponse` body — each customized
per campaign, not left at template defaults. That's deliberate configuration, strong evidence the
receipt actually sends on every donation through these forms. Note the API doesn't expose a single
`sendReceipt: true/false` toggle to check directly — `sendReceipt` only exists as a write parameter
on `TransactionApiCreate` (for donations created *through* the API), not as a readable field on the
canonical `GET /api/v1/crm/donation/{id}` donation record or on webhook payloads, so donor-form
receipting has to be inferred from the Form-level config like this instead. If a new form gets
added later without these fields populated, its gifts won't be auto-receipted — worth a periodic
spot-check (`GET /api/v1/form`, check `receiptSubject` is non-empty for any `status: active` form)
rather than a one-time assumption.

This Worker does **not** need to compute the $200-and-up "major gift" tier — that's a native
Monday status automation on the Donations board (`Amount ≥ $200 → Acknowledgment Tier: Major`),
independent of write source. Just don't overwrite that column on create/update.

## Gift Type

**Every transaction item is stamped `giftTypeValue` (default `Donation`) in `giftTypeColumn` on its
first write, never on updates.** `donation-rollups`' membership rule (spec
`docs/superpowers/specs/2026-09-15-membership-renewal-write-path-design.md`) only counts gifts whose
Gift Type is in its eligible list, so without this stamp a Funraise renewal would never extend a
membership. Staff can reclassify a gift afterwards (e.g. to `Matching Donation`) and this Worker will
not undo it.

## The Funraise delivery, as actually sent

This Worker was first written against the *Salesforce-side* Funraise package fields
(`funraise__*` in `docs/01` and `docs/03` of the private planning repo): a bare object with a
string `id`, `createdAt`, `donor.contactId`, and a `Posted` status. Funraise's own
[webhooks article](https://help.funraise.io/en/articles/4471107-webhooks) — its only public
payload documentation; the Stoplight API reference is a JS app and unreadable without a browser
— shows something else, and on 2026-09-18 the route, config, and donor matching were rewritten
to it, with `src/integration.test.ts` carrying a fixture trimmed from the documented example:

* **Envelope.** `{ "sentAt": <epoch ms>, "event": "DONATION", "data": { … } }`. `validateEnvelope`
  unwraps `data`; everything downstream (D1 `raw_payload`, every field path in `config/svbc.json`)
  sees the entity object, not the envelope. The pre-envelope bare shape is rejected.
* **Ids are numbers.** `data.id` and `data.supporter.id` are numbers (`123`, `7276`); both are
  stringified. Funraise sends no per-delivery id, so `events.event_id` is `<data.id>:<sentAt>`
  (fallback `data.updtime`, then the bare id): an edit of the same transaction arrives with a new
  `sentAt` and takes the entity-keyed *update* path, while an identical redelivery is a duplicate.
  The send time is also stored (`events.sent_at`, migration `0003`) and the upsert refuses to
  replace a row with an *older* delivery — at-least-once delivery can replay the original
  `Complete` after a `Refunded` edit was already written, and without the guard the consumer
  would push the stale columns back onto the Monday item. A stale delivery is reported as a
  duplicate; a NULL send time on either side (pre-`0003` rows, envelopes without one) never
  blocks an update, since their order is unknown.
* **Field names.** Amount and status live under `data.transaction`; the donor under
  `data.supporter` (`id`, `email`, `name`); the gift's date is `donationDate` (epoch ms, see
  "Fiscal Year Ending"); the item name is `description`. `statusValueMap` maps `Complete` — the
  documented success value — to `Received`. Anything else (`Refunded`, `Failed`, …) is written
  verbatim, so a value outside the Donations status vocabulary fails the write and lands in the
  DLQ rather than silently mislabeling; extend the map when Funraise's other statuses are known.
* **PII denylist** is the `data.transaction.*` card and billing fields Funraise actually sends
  (`lastFour`, `expirationDate`, `cardType`, `billingFirstName`/`LastName`/`Zip`) plus
  `transaction.errors`, the gateway response (it carries a Stripe source fingerprint). They are
  stripped before the row reaches D1. Not stripped, flagged for a decision: `dedication.*`
  (a third party's name and email, "⚠ PII screen" in docs/03) and `comment`.

## Deployed and verified (CRM Sandbox, 2026-09-18)

Hand-deployed with `wrangler deploy` (D1 `svbc-funraise-sync`, migrations 0001–0003 applied
remotely; queues `funraise-sync-writes` and `-dlq`; secrets `FUNRAISE_WEBHOOK_SECRET` and
`MONDAY_API_TOKEN`), then proven three ways, each time leaving nothing behind:

1. **Documented example, by hand.** The trimmed example from Funraise's webhooks article,
   POSTed to the live route: accepted, and 12 s later the consumer had created the donor on
   the People board (email object + Funraise Profile link) and the Donations item with amount
   51.5, `Complete → Received`, Date 2020-09-02 from the epoch-ms `donationDate`, Fiscal Year
   Ending 2021, Gift Type Donation, Thank You Sent, Donor link. The stored payload held no card
   number, billing zip, or gateway response. `donation-rollups` picked the create up on its own
   and rolled the gift onto the donor.
2. **Webhook registration.** Funraise's verify call reached the Worker (Cloudflare invocation
   analytics, `workersInvocationsAdaptive` by minute) and the card flipped to **Enabled** — on
   the second attempt; see "APIs & auth" for the secret mix-up on the first.
3. **Funraise's own Test button.** A genuine Funraise-originated `DONATION` delivery
   (transaction id `-1`, "Lorem Ipsum", 123.12, Complete, `sentAt` = now): stored with
   `event_id` `-1:<sentAt>`, written in 8 s, donor + Donations item created with amount 123.12,
   Received, the day's date, Fiscal Year Ending 2027, Gift Type, Thank You Sent; the drawer
   showed its green check; `donation-rollups` rolled it up. This is the closest thing to a real
   gift that doesn't move money or put a fake transaction in Funraise's books.

Cleanup after 1 and 3, verified each time: the two Monday items deleted (`delete_item`; Monday
reports them `state: deleted` and keeps them in its recycle bin), the `events` row removed from
this Worker's D1, and the gift's rows removed from `donation-rollups`' D1 (`pending_recomputes`,
`donation_links`, `gifts`). The next real Funraise transaction flows the same way and stays.

Re-verify the same three steps after the sandbox rebuild and again against production ids at
cutover — every board and column id in `config/svbc.json` is a sandbox id.

## Open

1. **One webhook, transactions only.** Funraise supports a single webhook per org and it fires
   "when a Transaction is created or edited". There is no subscription, pledge, or registration
   webhook, so the `/webhooks/funraise/subscription|pledge|registration` routes, the
   `recurringGift` and `registration` column maps, and the Recurring Gifts / Event Registrations
   board targets have nothing to receive unless those come from polling the REST API instead.
   A recurring payment does arrive as a transaction carrying `data.subscription.id` and
   `data.subscription.sequence`, which is how the Recurring Gift connect column
   (`board_relation_mm6jbjtd` on Donations) could be linked. Decide: poll, or drop those paths.
2. **Per-board column ids.** `entityIdColumn` and `donorLinkColumn` are one id for three boards
   whose ids differ (see "Monday targets"). Moot until item 1 gives the other boards a source.
3. ~~Register the webhook at `/webhooks/funraise/transaction?secret=…`~~ **Done 2026-09-18**
   (see "APIs & auth"); the other three entity paths stay routable but will never be called by
   Funraise.

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
