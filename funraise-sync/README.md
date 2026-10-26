# funraise-sync

**Staff UAT script:** [`docs/uat/funraise-sync.md`](../docs/uat/funraise-sync.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status:** Decided — Option B (full retirement). Build the direct sync. **Running as
`svbc-funraise-sync-sandbox` against the CRM Sandbox and receiving Funraise's live webhook since
2026-09-18** (moved onto the sandbox environment 2026-09-19; the production name
`svbc-funraise-sync` is retired until cutover) — see "Deployed and verified". **Remapped to the
`(sandbox v3)` boards, D1 re-bootstrapped and the gifts held since 2026-09-21 re-driven on
2026-09-30** — see "Rebuilt boards".
**Priority:** Blocking-adjacent — feeds ongoing donation data once Salesforce retires; the
historical side is handled by `salesforce-import`, this Worker takes over going forward.
**Owner:** David (decided 2026-09-30, [svbc-monday-migration#49](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-migration/-/issues/49)).
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
  │  the one webhook, on a Transaction created or edited        (Funraise has no other)
  ▼
Cloudflare Worker (webhook handler)   POST /webhooks/funraise/transaction?secret=…
  │  1. verify the shared secret, unwrap `data`, strip do-not-migrate PII fields, upsert
  │     into D1 `events` keyed on the transaction id — a later edit (newer sentAt) replaces
  │     the payload, an identical or older redelivery is a duplicate
  │  2. enqueue a Cloudflare Queue message referencing the transaction
  ▼
Cloudflare Queue → consumer
  │  1. resolve donor → People-board item (match by Funraise supporter id, then email; create)
  │  2. an installment (`data.subscription.id`) → its Recurring Gifts item, from the ledger,
  │     or fetched from Funraise and created on the spot if never seen
  │  3. write to Monday via GraphQL: create the Donations item on first sight, update it in
  │     place on later events; first-write stamps (Thank You Sent, Gift Type, Fiscal Year)
  │  on failure at any step, Queues retries automatically and, once exhausted, routes
  │  to a Dead Letter Queue instead of the match or write silently disappearing
  ▼
Donations board (+ Donor and Recurring Gift links; board ids in config/sandbox.json, or svbc.json for production)

Cloudflare cron, hourly ("0 * * * *")
  │  GET /api/v1/crm/subscription?q=updtime > T order by updtime asc          (keyset on
  │      …or q=updtime = T and id > I order by id asc  (walking a tie group)   (updtime, id))
  │  each row → Recurring Gifts item (adopt by Funraise ID, else create; update in place);
  │  D1 `subscriptions` ledger + `poll_cursors`; cursors advance after each page lands
  ▼
Recurring Gifts board (+ Donor link)
```

Ingestion, matching, and the Monday write are separate, independently testable steps. Matching
runs in the queue consumer — not the webhook handler — so a transient Monday API failure during
*matching or writing* gets the Queue's retries and DLQ instead of dying inside the webhook
request. The subscriptions poll is its own retry: a failed run leaves its cursor where it was and
the next hour re-reads the page. A daily cron ("0 9 * * *") empties `raw_payload` for events
written more than `funraiseSync.rawPayloadRetentionDays` (default 90) days ago, and for events
that never completed their write once they're older than `unresolvedPayloadRetentionDays`
(default 365), so raw donor PII doesn't accumulate in D1 indefinitely on either path. Every
Donations write stamps the Funraise transaction link (`funraiseSync.entityIdColumn`), and before
any create the consumer looks that id up and adopts an existing item instead — see "Adopt before
create". See
`../README.md`'s Reliability section for why the Queue shape is standard
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
     `https://<worker-host>/webhooks/funraise/transaction?secret=<value>`.

  The route **fails closed**: any POST whose secret doesn't match — including every POST while
  the secret is unset — is rejected with 401. The comparison is constant-time (SHA-256 both
  sides, then an early-exit-free byte compare; #25). Callers that can set headers — the
  redrive and replay scripts, a hand replay — send the secret as the `X-Webhook-Secret` header
  instead, which is checked first. **Funraise itself can't:** its webhook configuration is only a target
  URL and a contact email, so its deliveries keep `?secret=`. The tradeoff: a URL secret lands
  wherever the full request URL is recorded — Cloudflare's Workers Logs / observability
  invocation records for this Worker, and anyone with dashboard access to them. Mitigations:
  keep observability access limited to people who could read the secret anyway, never log
  `c.req.url` in this Worker, and rotate the secret (new `wrangler secret put` + Edit the URL
  in Funraise) if logs are ever shared. The `x-hook-secret` handshake is
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
* **Funraise REST API key** — `wrangler secret put FUNRAISE_API_KEY`, sent as `X-Api-Key` to
  `https://api.funraise.io` by the subscriptions poller and the consumer's never-seen-subscription
  lookup only (read-only use; nothing here writes to Funraise). Rate limit 3,000 requests/month
  on the base plan — see "Recurring gifts and registrations" for the budget.
* **Monday.com GraphQL API** — standard API token, same pattern as every other Worker here.

## Donor matching

Match incoming Funraise donor to an existing Donors-board item by email, or by a new **Funraise
contact ID** text column mirroring the existing Salesforce ID column pattern. Reuse the
`funraise__fr_ID__c` external-ID convention from the Salesforce side rather than inventing a new
identifier scheme.

In practice the sandbox People board carries that id as a **link** column, `Funraise Profile`
(`link_mm79dag0` on sandbox v3, `https://platform.funraise.io/supporter/<id>` with the bare id as
the link text), because `salesforce-import` writes it that way — not as a text column. Verified
live 2026-09-17 (on the v2 board; same column shapes on v3): `items_page_by_column_values` on
that column matches the bare id (`3682773` found its person; the display text and the url did
not), and on `Personal Email` (`email_mm79m5qa`) it matches the address. So the two lookups in `matchDonor` pass the bare id and the bare address.
The *create* path writes the shapes those columns require — `{url, text}` with the supporter
URL for the link column and `{email, text}` for the email column (Monday rejects bare strings on
both; see `salesforce-import`'s `load/columnValues.ts`) — so a donor this Worker creates looks
like a migrated one. Funraise sends `supporter.id` as a **number**; it is stringified before the
lookup and the write. `donorExternalIdColumn` must therefore be a link column and
`donorEmailColumn` an email column; a fork with a plain text id column changes `matchDonor`.

## Monday targets (sandbox v3 ids, read live 2026-09-30)

`config/sandbox.json` carries the real ids for the CRM Sandbox `(sandbox v3)` boards — the same
boards `salesforce-import` loads and `donation-rollups` reads — instead of placeholders. Re-verify
against production ids before cutover; the sandbox gets rebuilt. Every id below was read from the
board schemas via the Monday API, by column title, on 2026-09-30. (The v2 boards these replaced
were deleted when v3 went up on 2026-09-20; People moved on 2026-09-22, the rest on 2026-09-30.
A rebuild changes every column id, not just the board ids, and strands this Worker's D1 pointers
too — see "Rebuilt boards: remap, re-bootstrap, re-verify".)

| Config key | Board / column | Id | Notes |
|---|---|---|---|
| `monday.boards["donations:live"]` | Donations (sandbox v3) | `18431577310` | webhook consumer's only target |
| `monday.boards["recurring-gifts"]` | Recurring Gifts (sandbox v3) | `18431577263` | subscriptions poller's target |
| `monday.boards["people-live"]` | People (sandbox v3) | `18431577220` | People (Historical) is not a match target |
| `columnMap["transaction.amount"]` | Donations → Amount (numbers) | `numeric_mm79nz8b` | Funraise nests amount and status under `transaction` |
| `columnMap["transaction.status"]` | Donations → Status (status) | `color_mm79q3b3` | labels: Received / Received (Historical) / Failed / Pending, plus **Refunded — not yet on the board, staff must add it** (#25); `Complete → Received`, `Refunded → Refunded`, `Failed → Failed` via `statusValueMap` |
| `columnMap.donationDate` | Donations → Date (date) | `date_mm7938jk` | epoch ms in, `{ date: 'YYYY-MM-DD' }` out — see "Fiscal Year Ending" |
| `entityIdColumn` | Donations → Funraise ID (link) | `link_mm79jtzp` | transaction URL + bare id as text, same as the importer; the adopt-before-create lookup key |
| `thankYouSentColumn` | Donations → Thank You Sent (checkbox) | `boolean_mm7ddybs` | |
| `giftTypeColumn` | Donations → Gift Type (text) | `text_mm79fzs3` | `giftTypeValue` "Donation"; `eventGiftTypeValue` "Event Ticket" when the transaction carries `fundraisingEvent` — see "Gift Type" |
| `fiscalYearColumn` | Donations → Fiscal Year Ending (text) | `text_mm7973ah` | |
| `recurringGiftLinkColumn` | Donations → Recurring Gift (connect) | `board_relation_mm79pphw` | set on every write of an installment |
| `donorExternalIdColumn` | People → Funraise Profile (link) | `link_mm79dag0` | lookup by bare id; create writes `{url, text}` |
| `donorEmailColumn` | People → Personal Email (email) | `email_mm79m5qa` | lookup by address; create writes `{email, text}` |
| `donorLinkColumn` | Donations → Donor (connect) | `board_relation_mm795r2d` | connects to People, People (Historical) and Organizations |
| `subscriptionsPoll.columns.funraiseId` | Recurring Gifts → Funraise ID (link) | `link_mm79bx08` | transaction URL + bare id as text, same as the importer; the adopt-before-create lookup key |
| `subscriptionsPoll.columns.donor` | Recurring Gifts → Donor (connect) | `board_relation_mm792b0c` | |
| `subscriptionsPoll.columns.installmentAmount` | Recurring Gifts → Installment Amount (numbers) | `numeric_mm79vnnj` | per-installment, per docs/03 |
| `subscriptionsPoll.columns.annualizedValue` | Recurring Gifts → Annualized Value (numbers) | `numeric_mm79zpt1` | computed: amount × `frequencyMultiplier[frequency]` (Monthly 12, Quarterly 4, Yearly 1) |
| `subscriptionsPoll.columns.frequency` | Recurring Gifts → Frequency (status) | `color_mm793249` | labels: Monthly / Yearly / Quarterly; a frequency missing from `frequencyMultiplier` leaves this and Annualized Value unset, with a warning |
| `subscriptionsPoll.columns.status` | Recurring Gifts → Status (status) | `color_mm79tvkt` | labels: Redacted / Active / Cancelled / Failed; via `statusLabelMap`, unmapped → unset with a warning |
| `subscriptionsPoll.columns.nextPayment` | Recurring Gifts → Next Payment (date) | `date_mm79de3c` | epoch ms in; cleared when the subscription has none (cancelled) |
| `subscriptionsPoll.columns.designation` | Recurring Gifts → Designation (text) | `text_mm79gmge` | from the subscription's `form.name` |
| `subscriptionsPoll.columns.companyMatch` / `.matchEmployer` | Recurring Gifts → Company Match (checkbox) / Match Employer (text) | `boolean_mm79pqy4` / `text_mm79rpky` | from `companyMatch.companyName` |

One id is deliberately absent:

* **No `description` column.** The Donations board has no description text column; `description`
  is already the item name via `itemNameField`. The importer's `Salesforce Debug` long-text is
  provenance, not a description, and stays untouched.
### Adopt before create

Before creating a Donations item, the consumer looks up the transaction's Funraise id in
`entityIdColumn` (a bare-id search matches the link's text, verified live) and, if an item
exists, updates it instead. That covers two cases:

* **Gifts `salesforce-import` migrated.** The first Funraise update to a pre-cutover gift, such as
  an edit or a refund, arrives with no D1 row. Without the lookup it created a second Donations
  item that `donation-rollups` then counted twice.
* **This Worker's own orphans.** A create succeeded but the D1 update recording its item id
  didn't.

An adopted item gets only the Funraise-owned columns (amount, status, date, the Funraise link,
the Recurring Gift link). It never gets the first-write stamps (Thank You Sent, Gift Type,
Fiscal Year Ending), and never the Donor link. A migrated gift's values for those came from
Salesforce, and the Donor there can deliberately be an Organization. An orphan of our own
already got all of them when it was created.

**Archived fiscal years: flagged, not created (2026-10-06).** `items_page_by_column_values`
doesn't return archived items, and `salesforce-import` archives Donations older than its active
fiscal-year window, so the lookup above can't see an archived migrated gift. Without a guard, a
Funraise edit or refund to one would create a second Donations item that `donation-rollups`
counts twice. `funraiseSync.oldestActiveFiscalYear` is the importer's `cutoffFY` (cutover fiscal
year − `donationsActiveFiscalYears` + 1; 2026 for the 2026-10-09 cutover with two active years).
When no item carries the transaction's Funraise ID **and** the gift's fiscal year is earlier, the
consumer creates nothing: the `events` row goes to `needs_review` with the reason in `error`, the
message is acked (no retries), and one `console.error` line names the transaction id. A later
edit is judged afresh. Staff list them with

```sh
wrangler d1 execute svbc-funraise-sync --remote \
  --command "SELECT entity_id, error, received_at FROM events WHERE status = 'needs_review'"
```

(`svbc-funraise-sync-sandbox` for the sandbox) and either update the archived item by hand or, for a
back-dated gift that was never migrated, add it. Nothing writes these to a Monday board yet.
`null` disables the check; a gift with an unparseable date is created as before.

Gone with the registration path (2026-09-18): the `event-registrations` board key, the
per-entity `columnMap.recurringGift` / `.registration` maps, and the per-board column-id
question — the webhook consumer writes only the Donations board and the poller has its own
column block.

## Field mapping

Full column-by-column mapping (Donations ← Opportunity/Transaction fields, Recurring Gifts ←
Subscription, status-value mapping where `Posted` — not `Closed Won` — is the real success state,
and the full do-not-migrate list) lives in
`docs/03-monday-migration-mapping.md` (private planning repo) — this
Worker's write step should follow that mapping's *targets* exactly, not redefine them; its
*source* field names are the Salesforce package's, not the webhook's (see "The Funraise
delivery, as actually sent" for the translation). One board-side constraint on top of that doc:
`config/sandbox.json` maps the webhook's `Complete` to `Received` (the doc's `Posted` is the same
gift as seen from Salesforce) because the Donations board's status vocabulary (seeded by
`salesforce-import`) is exactly `Received` /
`Received (Historical)` / `Failed` / `Pending` / `Lost` (plus `Refunded`, which staff must add — #25;
`Lost` is migrated pipeline only, never a Funraise outcome),
and `donation-rollups` counts only `Received` —
mapping to any label outside that set silently drops the gift from rollups. Notably: **Pledge and
Subscription are a confirmed 1:1 duplicate** — do not create separate items for both; **8 email
fields collapse to one** with precedence `npe01__Preferred_Email__c` → `Primary_Email__c` →
`Email`; **payment-method fields (last four, expiration) are PII and must never be written to
Monday**.

**`Fiscal Year Ending` is stamped on create (derived, not mapped).** The Donations board has a
text `Fiscal Year Ending` column that `salesforce-import` writes on every migrated gift (SVBC's
July–June fiscal year, named for the year it ends in, so a 2026-08-15 gift is FY 2027 and a
2026-06-30 gift is FY 2026). It isn't a Funraise field, so `columnMap` can't map it;
instead the consumer derives it from the transaction's `donationDate` (Funraise sends epoch
milliseconds; `toISODate` in `src/util/isoDate.ts` normalizes it to an `America/Los_Angeles`
`YYYY-MM-DD`, which is
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
for a board without the column. `config/sandbox.json` points it at `text_mm7973ah`, the text column
titled "Fiscal Year Ending" on the Donations (sandbox v3) board (`18431577310`, read live
2026-09-30) — the same one `donation-rollups` reads. (The v2 board also had an older numbers
column titled "Fiscal Year" that `salesforce-import` no longer stamps; v3 doesn't.) The date is the **Pacific**
calendar day of `donationDate` (#25): it used to be the UTC day, which put a gift made between
~5 pm and midnight Pacific on June 30 (or Dec 31) into the next fiscal (or calendar) year on both
columns, disagreeing with the local-date CloseDates `salesforce-import` migrated. Recurring
Gifts' Next Payment goes through the same function.

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
  unwraps `data`; everything downstream (D1 `raw_payload`, every field path in
  `config/sandbox.json` (or `svbc.json` for production))
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
  documented success value — to `Received`, and `Refunded` / `Failed` to the Donations labels of
  the same name (#25), so a refunded gift stops being `Received` and drops out of
  `donation-rollups`' totals. **`Refunded` is not yet a label on the Donations Status column** —
  staff must add it (sandbox and production boards) or every refund write still fails. Anything
  else is written verbatim, so a value outside the Donations status vocabulary fails the write
  and dead-letters (see "Failures and the dead-letter queue") rather than silently mislabeling;
  extend the map when Funraise's other statuses are known.
* **PII denylist** is the `data.transaction.*` card and billing fields Funraise actually sends
  (`lastFour`, `expirationDate`, `cardType`, `billingFirstName`/`LastName`/`Zip`) plus
  `transaction.errors`, the gateway response (it carries a Stripe source fingerprint). They are
  stripped before the row reaches D1. Not stripped, flagged for a decision: `dedication.*`
  (a third party's name and email, "⚠ PII screen" in docs/03) and `comment`.

## Failures and the dead-letter queue (#25)

A failed consumer run marks the `events` row `failed` with the error and retries the message
with backoff — 1, 4, then 16 minutes (`retryDelaySeconds` in `src/consumer/processBatch.ts`).
Once `max_retries` (3) is exhausted the message goes to `funraise-sync-writes-dlq`
(`…-sandbox-dlq` in the sandbox), which this Worker **also consumes**
(`src/consumer/processDeadLetters.ts`, same shape as `donation-rollups`'): the row's error is
prefixed `dead-lettered after retries: ` and each batch logs one `console.error` naming the
transactions, so a dead gift is visible in Workers Logs and in D1 instead of expiring from the
DLQ unseen after ~4 days. A dead message is evidence only as of when it was sent: a row written,
or replaced by a newer Funraise delivery, since then is left alone. Nothing re-drives from the
DLQ automatically — fix the cause, then:

```sh
FUNRAISE_WEBHOOK_SECRET=... node scripts/redrive-failed.mjs --worker-url https://<worker-host> [--env sandbox] --dry-run
FUNRAISE_WEBHOOK_SECRET=... node scripts/redrive-failed.mjs --worker-url https://<worker-host> [--env sandbox]
```

It reads `failed` rows older than an hour from the remote D1 and POSTs each stored payload back
as the envelope it arrived in (secret in the `X-Webhook-Secret` header); the route's
duplicate-recovery path re-enqueues it, so the write happens on the normal path. Rows whose
payload the retention purge has emptied (`unresolvedPayloadRetentionDays`) are listed for
manual recovery from Funraise. To find dead gifts directly:
`select entity_id, error, received_at from events where error like 'dead-lettered%'`.

## Replaying one Worker's deliveries into another (cutover handoff)

At cutover Funraise's single webhook moves from the sandbox Worker to production
(svbc-monday-migration#48, runbook `docs/23` step 5). The sandbox Worker's D1 `events` table is
the record of every gift delivered while the webhook still pointed there, so after the repoint
those deliveries are replayed into production. In order:

1. **Run the subscriptions bootstrap walk first** ("Bootstrap walk, run locally", under
   "Recurring gifts and registrations"), so each replayed installment finds its Recurring Gift
   in the ledger instead of fetching it from Funraise.
2. **Plan with `--dry-run`.** It reads the source D1 and prints what would be sent, and needs no
   secret or `--worker-url`. It is also the reachability check: the read is
   `wrangler d1 execute --remote` with the local wrangler login, and a failure is reported with
   wrangler's own reason (an expired login, an unknown database) before anything is sent.
3. **Replay**, with the **target** Worker's secret in `FUNRAISE_WEBHOOK_SECRET`.
4. **Re-run until every row reads `already present`**, then run the window check (below).

```sh
# Plan only: reads the sandbox D1, needs no secret
node scripts/replay-window.mjs --since 2026-10-09T17:30:00.000Z --dry-run
# Replay into production, with the PRODUCTION Worker's secret
FUNRAISE_WEBHOOK_SECRET=... node scripts/replay-window.mjs --since 2026-10-09T17:30:00.000Z \
  --worker-url https://<production-worker-host> [--until <ISO UTC>] [--source-env sandbox|production] [--pause-ms 2000]
```

`--since` (required, ISO UTC) is when the final extract **started**, not when it finished; the
overlap with what it carried is harmless because adopt-before-create updates a gift the import
already put on the board. `--until` is an exclusive upper bound (default: none). `--source-env`
names whose D1 to read (default `sandbox`; `production` turns it round, for replaying production
deliveries into the sandbox host). `--pause-ms` is the wait between deliveries (default 2000; the
consumer writes one gift at a time). Both timestamps are validated before they reach
`wrangler d1 execute`.

How it differs from `redrive-failed.mjs`, which it reuses `planRedrive` from:

* **Selects by time, not status.** The gap's deliveries are `written` in the sandbox ledger, so a
  status filter finds none of them. An edit replaces its row and `received_at`, so the window
  catches edits to gifts first seen earlier. Rows come back ordered by `received_at`.
* **Skips Funraise's Test-button transaction (id `-1`)**, which would otherwise create a fake
  donor and Donations item in production.
* **A `duplicate` answer is success.** The route answers it for a delivery it already holds, or
  when the stored `sent_at` is newer (the stale-delivery guard), so the replay never undoes a
  later edit, and re-running it is safe. A bad secret stops the run at the first delivery.
* **Reports what it can't replay:** rows whose payload the retention purge emptied
  (`rawPayloadRetentionDays`, 90 days after the write) must be recovered from Funraise by hand.
  Exit codes: 0 clean, 1 a delivery failed or the secret was rejected, 2 only unreplayable rows.
* **Mind the Worker's rate limit.** The route allows 60 requests a minute per client address
  (`REQUEST_RATE_LIMITER`, keyed on `CF-Connecting-IP`), so concurrent runs from one machine
  share the budget, and a rejected request comes back `429` and counts as `failed` — never
  hidden. Keep the default `--pause-ms 2000` (30 a minute), and after a run that ended with
  429s wait a minute before re-running: the re-run's first requests land in the window the
  first run used up. Seen in the 2026-10-06 rehearsal against a local Worker
  (`docs/superpowers/specs/2026-10-06-funraise-replay-rehearsal-design.md`); the same behavior
  is expected deployed, but has not been observed there.
* **A refund in the window fails until `Refunded` exists.** The consumer maps a Funraise refund
  to the Donations `Refunded` label (see "The Funraise delivery, as actually sent"); until staff
  add it, the replay reports the delivery `enqueued` and the write dead-letters, leaving the
  gift `Received`. Add the label before replaying, or expect those rows under
  `error like 'dead-lettered%'`.
* **Archived-year gifts are flagged, not written.** A replayed gift dated before
  `funraiseSync.oldestActiveFiscalYear` with no active item carrying its Funraise ID lands in
  `status = 'needs_review'` (see "Archived fiscal years: flagged, not created"); list them with
  the query there once the queue has drained.

It sends the stored, already PII-stripped payload, and the production route strips it again. It
changes nothing in D1 or Monday itself; each accepted delivery goes through the normal queue
consumer, so replayed gifts are subject to everything it does. The script reports what the
route accepted, not what was written: check the result with the runbook's **post-repoint window
check** (`docs/23` step 5), run once the queue has drained. Of its five checks — ledger to
ledger, against Funraise's own dashboard, nothing doubled, no archived-year duplicate, refunds
can land — only the first is a query, and check 3 (nothing doubled) is scripted below; the rest are by hand on the board.

Window check 3 (one Donations item per Funraise ID) is scripted and read-only:

```sh
MONDAY_API_TOKEN=... node scripts/check-funraise-ids.mjs [--env sandbox]
```

It pages through the Donations board (`monday.boards["donations:live"]`, Funraise ID column
`funraiseSync.entityIdColumn`) and exits 1 listing every Funraise ID carried by more than one
item. Archived items aren't returned by the API, so it shares adopt-before-create's blind spot —
which is why the consumer flags old gifts instead of creating them.

**Open (not decided):** which control pauses the Funraise → Salesforce sync after Gate C is not
written down anywhere (svbc-monday-migration docs/23). Funraise's managed package has no
documented off switch in this repo; someone with Funraise/Salesforce admin access has to name the
control and the runbook has to say who flips it and when.

## Resetting for new board ids

When the boards this Worker writes are deleted and rebuilt (a cutover retry — private runbook,
Rollback step 8 — or a sandbox rebuild), every Monday item id in D1 is dead, and the Worker
goes on using them: a Funraise edit to a known gift updates an item that no longer exists and
dead-letters, an installment is written with a link to a Recurring Gifts item that no longer
exists, and the poll skips each subscription as already written. Reset D1 before Funraise's
webhook points at the Worker on the new boards. This is the procedure; "Rebuilt boards: remap,
re-bootstrap, re-verify" below is the run that proved it on the sandbox (2026-09-30).

**First:** delete or archive the old boards. The hourly poll keeps running on whatever config is
deployed: while the old boards exist and the old config is live, it starts re-adopting their
items into the emptied ledger; once they're gone its Monday calls fail and it writes nothing.

```sh
# 1. Export, to somewhere outside the repo (it holds donor payloads). Besides being the backup,
#    it is the record of the gifts received against the old boards. The database is unavailable
#    while the export runs (seconds). `wrangler d1 time-travel info` gives a restore point too.
npx wrangler d1 export svbc-funraise-sync --remote --output <dir>/svbc-funraise-sync.sql

# 2. The subscriptions ledger, always. -y answers any wrangler confirmation prompt; unanswered
#    without a TTY, one cancels silently with exit 0.
npx wrangler d1 execute svbc-funraise-sync --remote -y --command \
  "DELETE FROM subscriptions; DELETE FROM subscription_claims; DELETE FROM poll_cursors;"

# 3. events: pick 3a or 3b (see the table).
# 3a. Keep the gifts and hand them to the redrive.
npx wrangler d1 execute svbc-funraise-sync --remote -y --command \
  "DELETE FROM events WHERE entity_id = '-1'; UPDATE events SET matched_donor_item_id = NULL WHERE status = 'failed'; UPDATE events SET status = 'failed', monday_item_id = NULL, matched_donor_item_id = NULL, written_at = NULL, error = 'boards rebuilt: was written to the old Donations board; re-drive' WHERE status = 'written';"
# 3b. Or forget them.
npx wrangler d1 execute svbc-funraise-sync --remote -y --command "DELETE FROM events;"

# 4. Check: the ledger tables are 0, and no events row still names an item. Run it again just
#    before deploying the new config, and repeat step 2 if the poll has written anything back.
npx wrangler d1 execute svbc-funraise-sync --remote --command \
  "SELECT 'subscriptions' AS t, COUNT(*) AS n FROM subscriptions UNION ALL SELECT 'subscription_claims', COUNT(*) FROM subscription_claims UNION ALL SELECT 'poll_cursors', COUNT(*) FROM poll_cursors UNION ALL SELECT 'events with an item id', COUNT(*) FROM events WHERE monday_item_id IS NOT NULL OR matched_donor_item_id IS NOT NULL"
```

Sandbox: `svbc-funraise-sync-sandbox`, with `--env sandbox` on every command.

| Table | Reset | Why |
|---|---|---|
| `subscriptions` | cleared | Recurring Gifts and People item ids on the old boards. |
| `subscription_claims` | cleared | No item ids, only in-flight create claims; they shouldn't outlive the ledger they guard. |
| `poll_cursors` | cleared | Not ids, but a kept cursor would leave every subscription behind it out of the new ledger until it next changed. Cleared, the walk starts from the beginning. |
| `events` | **3a: kept, pointers cleared, marked `failed`** | `monday_item_id` and `matched_donor_item_id` are Donations and People items on the old boards. Use 3a when gifts this Worker received against the old boards may be missing from the new ones: the redrive sends each stored payload through the normal path, where adopt-before-create updates a gift the new board already carries and creates one it doesn't. The first statement drops Funraise's Test-button row (transaction id `-1`) so the redrive doesn't recreate it. A row whose payload the retention purge has emptied can't be replayed; the script lists those. |
| | **3b: cleared** | Use 3b when nothing in the table should reach the new boards: the production-named D1 before its first deploy (it holds sandbox rows — see "Rebuilt boards", Cutover), or a cutover retry whose Funraise handoff covers the failed window another way. With no row, the next delivery for a gift is matched to a donor again and adopted on the new board by its Funraise ID (or created). |

`d1_migrations` is untouched, so nothing is re-applied. After 3b, a message still in the write
queue finds no `events` row, retries, and is acked by the dead-letter consumer without writing
anything.

**Then**, in this order: deploy with the new ids; run the bootstrap walk locally ("Bootstrap
walk, run locally" below; expect `adopted ≈ board count`, and `select count(*) from
subscriptions` equal to the board); after 3a, run `scripts/redrive-failed.mjs` — only after the
walk, so each installment finds its Recurring Gift in the ledger; then repoint Funraise's webhook.

Tested: step 2 and 3a ran on the deployed sandbox D1 on 2026-09-30 (the "Rebuilt boards" run,
without the Test-button delete; 53 gifts re-driven and created). 3b and the Test-button delete
ran on local D1 copies only.

## Deployed and verified (CRM Sandbox, 2026-09-18)

**The running deployment is `svbc-funraise-sync-sandbox`** (`npm run deploy:sandbox`; D1
`svbc-funraise-sync-sandbox`, queues `funraise-sync-writes-sandbox` and `-sandbox-dlq`, secrets
`FUNRAISE_WEBHOOK_SECRET`, `MONDAY_API_TOKEN`, `FUNRAISE_API_KEY` under `--env sandbox`). It was
moved there on 2026-09-19 per the sandbox design's §9: D1 created and migrations 0001–0004
applied, data copied from `svbc-funraise-sync` with counts verified equal, secrets set, deployed,
Funraise's webhook repointed to the `…-sandbox` host (its verify call reached the new Worker and
the card read Enabled), Funraise's Test button delivery written end to end on the new path and
cleaned up, and the production-named Worker deleted (queue consumer removed first — Cloudflare
refuses to delete a consumer Worker). D1 `svbc-funraise-sync` and the production-named queues
survive for the cutover deploy. Nothing arrived in the old D1 between the snapshot and the
repoint, so no re-sync was needed. Note for the rollups half of §9: the cron poll here means two
pollers overlap while both Workers exist — keep that window short.

First deployed 2026-09-18 under the production name (`wrangler deploy`; D1 `svbc-funraise-sync`,
migrations 0001–0003; queues `funraise-sync-writes` and `-dlq`; secrets `FUNRAISE_WEBHOOK_SECRET`
and `MONDAY_API_TOKEN`), then proven three ways, each time leaving nothing behind:

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
cutover. Since the sandbox environment split (below), every sandbox id lives in
`config/sandbox.json`; `config/svbc.json` is production and holds placeholders until cutover.

## Rebuilt boards: remap, re-bootstrap, re-verify (sandbox v3, 2026-09-30)

The `(sandbox v2)` boards were deleted when the `(sandbox v3)` boards went up on 2026-09-20.
This Worker kept pointing at them until 2026-09-30 (People alone was moved on 2026-09-22), and in
that window every Funraise delivery failed its Monday write with `User unauthorized to perform
action` (Monday's answer for a deleted board), retried, and dead-lettered: 41 real gifts. The
hourly subscriptions poll stopped advancing on 2026-09-21. Nothing was lost: the route had
stored every payload in D1.

**A rebuild strands more than the config.** Four things point at the old boards, and all four
have to move:

1. `config/sandbox.json`: the board ids *and every column id* (a rebuilt board gets new ones).
   Read them from the live schemas by column title; see "Monday targets".
2. D1 `subscriptions`: each ledger row holds the Recurring Gifts item it wrote. A ledger hit
   updates that item in place and hands its id to the Donations write as the Recurring Gift
   link, so with stale rows the poll fails on its first changed subscription and every recurring
   installment fails with it.
3. D1 `poll_cursors`: with the ledger gone the walk has to restart from zero.
4. D1 `events`: `matched_donor_item_id` (a People item) and `monday_item_id` (a Donations item).
   A stored donor match is reused without a lookup, and a row with a Monday item is updated in
   place rather than adopted or created.

**What was run, in this order** (each step is safe to repeat):

1. Config remapped, tests and typecheck green, `npm run deploy:sandbox`.
2. Restore point noted: `npx wrangler d1 time-travel info svbc-funraise-sync-sandbox --env
   sandbox` (bookmark `0000012e-00000000-000050f7-ade33e83d0c27e31bab45393296a5cff`, good for
   30 days).
3. Stale pointers cleared with `wrangler d1 execute … --remote`:

   ```sql
   DELETE FROM subscriptions;
   DELETE FROM subscription_claims;
   DELETE FROM poll_cursors;
   UPDATE events SET matched_donor_item_id = NULL WHERE status = 'failed';
   -- Gifts written to the old board: hand them to the redrive as well.
   UPDATE events
      SET status = 'failed', monday_item_id = NULL, matched_donor_item_id = NULL, written_at = NULL,
          error = 'sandbox v3 remap 2026-09-30: was written to the deleted Donations (sandbox v2) board; re-drive'
    WHERE status = 'written';
   ```

   That removed 1,175 ledger rows and 4 cursors, and left 53 events to re-drive: the 41 failures
   plus 12 gifts written to the v2 board between 2026-09-19 and its deletion.
4. The bootstrap walk, run locally exactly as in "Recurring gifts and registrations" below
   (`wrangler dev --remote --test-scheduled --env sandbox`, one `__scheduled` request per page,
   secrets in a temporary `.dev.vars`): 167 invocations in 47 minutes, every one HTTP 200. The
   deployed hourly cron came due at 01:00 UTC partway through, and nothing was duplicated.
   Result: all 604 importer items adopted and 572 created, ledger 1,176 =
   board 1,176 with no item in the ledger twice (543 Active, 61 Cancelled, 4 Failed, 568
   Redacted: one new Active subscription since 2026-09-19), every row with a Donor; cursor
   `1790752061709`, no tie walk pending. People (sandbox v3) grew from 8,044 to 8,046 items over the walk,
   consistent with two supporters the importer never carried. The poll's log line did not
   appear in this run's `wrangler dev --remote` output, so progress was read from D1 between runs
   (`select count(*) from subscriptions` and the two cursors); the walk is done when two runs in
   a row leave both cursors unchanged with `subscriptions:id` at `-1`.
5. The redrive, only after the walk so each installment found its Recurring Gift in the ledger:
   `node scripts/redrive-failed.mjs --env sandbox --worker-url https://svbc-funraise-sync-sandbox.svbc-account.workers.dev`.
   All 53 were re-enqueued and written within two and a half minutes. None was found on the v3 board
   by its Funraise ID, so all 53 were created: Donations (sandbox v3) went from
   3,828 to 3,881 items, each with Amount, Date, Donor link, Funraise ID, Fiscal Year Ending
   2027, Gift Type Donation and Thank You Sent, 38 of them installments linked to their
   Recurring Gift. Statuses as Funraise reported them: 42 Received, 10 Failed, 1 Pending.
   `donation-rollups` has its webhooks on this board and picks the creates up on its own.
6. Proof on the deployed Worker, both paths. **Webhook:** the next real Funraise gift
   (transaction `14316775`, a one-time $10) arrived at 01:58:39 UTC and was a Donations
   (sandbox v3) item 9 s later: Amount 10, Status Received, Date 2026-09-30 (the Pacific day),
   Fiscal Year Ending 2027, Gift Type Donation, Thank You Sent, Funraise ID, Donor linked to the
   existing People item, Recurring Gift empty as it should be for a one-time gift. It is a real
   gift and stays. **Poll:** the 02:00 UTC cron was the first deployed run against the rebuilt
   ledger; it read nothing new and left the cursor where the walk put it. Funraise's own
   Test-button delivery (verification 3 above) has **not** been repeated on v3: it needs a
   Funraise login. It exercises the same route and consumer the real gift just did.
7. Redeployed once more after rebasing onto `main` (the shared transport's API-Version pin,
   #39), so the running sandbox Worker is `main` plus this remap.

**Still true on v3:** `Refunded` is not a label on the Donations Status column (see "The Funraise
delivery, as actually sent"), so a refund write still dead-letters until staff add it.

**Cutover: the production-named D1 carries sandbox pointers.** `svbc-funraise-sync`, kept for the
production deploy, still holds what was copied out of it on 2026-09-19: 1,175 ledger rows, three
poll cursors and six events, every one pointing at a deleted sandbox v2 item. Run step 3 against
it (or recreate it from the migrations) **before** the production Worker's first deploy, then do
the walk against the production Recurring Gifts board. Same lesson `donation-rollups` wrote up in
`docs/22` §5 of the private planning repo: bootstrap the D1 for the new board ids before
anything writes.

## Sandbox environment — inbound only, no outbound data

This Worker has a permanent `sandbox` Wrangler environment (`wrangler.jsonc` `env.sandbox`):
`npm run deploy:sandbox` deploys `svbc-funraise-sync-sandbox` against the CRM Sandbox boards in
`config/sandbox.json`, chosen at request time by the `ENVIRONMENT` var (`src/environment.ts`).
It has its own D1 (`svbc-funraise-sync-sandbox`), queues (`funraise-sync-writes-sandbox` and
`-sandbox-dlq`), and secrets (`wrangler secret put … --env sandbox`); it shares nothing with
the production-named Worker. Local development against the sandbox uses `npm run dev:sandbox`; `npm run dev` targets the production config and, once production secrets exist in `.dev.vars`, would write to production sinks. This Worker writes only to Monday, so there is no outbound sink to
lock — the split exists so the sandbox and production deployments can coexist after cutover.
`config/split.test.ts` fails if the two configs ever share an id or if `env.sandbox` shares a
resource with the top level. Design:
`../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`; the move of the existing
deployment onto this environment is its §9, run once from the runbook in the step 2 plan.
`npm run deploy:sandbox` fails until `env.sandbox.d1_databases[0].database_id` in
`wrangler.jsonc` is replaced with the id `wrangler d1 create` prints — see the step 2 plan's
Task 9.

**Workers Builds:** connect a second Worker, `svbc-funraise-sync-sandbox`, to this repo with root
directory `/funraise-sync`, production branch `main`, and deploy command
`npx wrangler deploy --env sandbox`. The sandbox then tracks `main` alongside production. If the
dashboard refuses two connections on one root directory, fall back to the
`deploy-sandbox:funraise-sync` job in `../.gitlab-ci.yml` — same command, gated on a
`CLOUDFLARE_API_TOKEN` CI variable so it stays inert until that variable is set.

Funraise allows one webhook per organization. Until cutover it points at the sandbox Worker;
at cutover it moves to production and the sandbox loses its live feed (design doc §7) — after
that, sandbox testing uses Funraise's Test button or a replay of stored production deliveries
(`scripts/replay-window.mjs --source-env production` against the sandbox host, with the sandbox
Worker's secret; see "Replaying one Worker's deliveries into another").

## Recurring gifts and registrations — decided 2026-09-18

Funraise supports a single webhook per org and it fires only "when a Transaction is created or
edited"; there is no subscription, pledge, or registration webhook. Established against the live
API the same day (`X-Api-Key`, base `https://api.funraise.io`): every recurring installment already
arrives as a transaction carrying `data.subscription.{id, sequence}` and
`data.transaction.frequency`; `GET /api/v1/crm/subscription` is pollable with a working `q`
filter (`status`, `updtime`, `order by`, exact id) and pages of 10, and returns frequency, status,
next payment, amount and supporter; `GET /api/v1/crm/donation` ignores `q`; and there is **no
registration resource at all** (the Fundraising Event group has only create / update /
completeAuctionItem / delete). SVBC's events run on Eventbrite and the plan already assigns
Event Registrations to an Eventbrite-fed Worker.

**Decision (DWK, 2026-09-18):** keep the Recurring Gifts board and feed it by polling
subscriptions on an hourly cron inside this Worker, link each webhook installment to its
Recurring Gift item, and **drop the registration path** along with the never-called subscription
and pledge routes. A paid Funraise ticket still lands on Donations via the webhook and gets its
own Gift Type so it never counts toward membership. Full design, mapping, config, budget and
tests: `docs/superpowers/specs/2026-09-18-funraise-subscriptions-poller-design.md`.

**Built 2026-09-18** (`src/subscriptions/`, `src/funraise/client.ts`, `src/db/subscriptions.ts`,
migration `0004`, `src/scheduled.ts`). How it runs:

* **Hourly cron** `0 * * * *` → `pollSubscriptions`: **keyset pagination on (`updtime`, `id`)**
  (#25), always `page=0`. Two cursors in `poll_cursors`: `subscriptions` (T) and
  `subscriptions:id` (I, or `-1` for none). Each request is either the forward query
  `updtime > T order by updtime asc` or, while walking a tie group, `updtime = T and id > I
  order by id asc`. A short forward page means caught up (T moves to its max `updtime`); a full
  one moves T to its max `updtime` M and walks M's tie group by id from 0, because Funraise
  promises no order among rows sharing an `updtime` — a bulk import gave hundreds of
  subscriptions one identical `updtime` (seen live 2026-09-18). Every row goes through
  `upsertSubscription`; the ledger's per-row `updtime` makes re-reads no-ops. A failed page
  leaves the cursors untouched, so the next run re-reads it. Idle cost: one request per run.
  **Why keyset:** this used to page by offset (`updtime >= cursor`, `page=N`, cursors
  `subscriptions:page` / `subscriptions:max`, now unused). `updtime` changes during a walk that
  spans hours at one page per run: an edited row jumps to the end and every later row shifts up
  a slot, so the row sliding onto an already-read page was never read — and once the cursor
  passed its `updtime`, never would be, cancellation included. A keyset query selects by value,
  so rows moving elsewhere can't push an unread one behind the cursor. On the first run after
  upgrading, `subscriptions:id` is absent, so the poll re-walks the tie group at the stored
  cursor (no-ops) and carries on. **Before deploying, confirm Funraise accepts `and` in `q`**
  (the 2026-09-18 probes exercised `>`, `>=`, `=`, `order by` and exact id, each alone): one
  read-only `GET /api/v1/crm/subscription?q=updtime = <a real updtime> and id > 0 order by id
  asc&page=0` should return only rows at that `updtime`; an HTTP 500 or rows at other times
  means the tie query needs rewriting. Two more Funraise quirks live in
  `src/funraise/client.ts`: the list answers HTTP 500 to any `updtime` filter below about 2001,
  so a fresh cursor is floored there, and the page size is fixed at 10.
* **One page per run — sized for Workers Free.** A Free-plan invocation may make 50 external
  subrequests (and a cron gets 10 ms CPU); a page of ten rows costs up to ~45 Monday and
  Funraise calls (donor lookup, adopt lookup, write). `subscriptionsPoll.maxPagesPerRun` ships as
  `1`, so a busy hour with more than ten changed subscriptions catches up over the following
  hours from the cursor — and the ~60-page bootstrap walk cannot run deployed at all. The account
  is on Workers Paid now (confirmed 2026-09-29; 10,000 subrequests, 15 min CPU per hourly cron), so the value
  can be raised — not yet done.
* **Adopt before create.** A subscription the ledger doesn't know is looked up on the board by
  bare id in the Funraise ID link column; found → updated and recorded, not found → created.
  **Claim first (#25):** the poll and the queue consumer's never-seen-subscription path can miss
  the ledger for one subscription at the same moment, and both used to create an item. A ledger
  miss now takes a D1 claim (`subscription_claims`, one atomic `INSERT … ON CONFLICT`) before
  any Monday call; the loser throws having written nothing (the poll re-reads the page next run;
  the consumer leaves that gift's Recurring Gift link unset, as for any lookup failure), and the
  winner re-reads the ledger in case the other writer just finished. The claim is released once
  the ledger records the item; a writer that dies midway leaves it to expire after 10 minutes.
  **The first run on a board `salesforce-import` has loaded therefore adopts its ~600 existing
  Recurring Gifts items** (expect `adopted ≈ board count, created ≈ 0` in the run's log line)
  instead of duplicating them. A row older than the ledger is a no-op, so nothing regresses.
* **Never-seen subscription on the webhook side.** An installment whose subscription isn't in
  the ledger triggers one `GET /api/v1/crm/subscription/{id}` and the same upsert, then the
  Donations item gets its Recurring Gift link — a new monthly donor's first gift links at once.
* **Secret:** `wrangler secret put FUNRAISE_API_KEY` (the key used for the 2026-08-24 and
  2026-09-18 probes lives locally in `funraise-sync/.env` under the misspelled name
  `FUNRISE_API_KEY`; rename when storing). Unset → the poll logs and skips; the webhook path
  still writes gifts, minus the Recurring Gift link. `subscriptionsPoll.enabled: false` also
  skips.
* **Budget (Funraise API):** hourly idle 744 requests/month + one page per ten changed
  subscriptions + one request per never-seen subscription on the webhook side; under 900 of
  the base plan's 3,000. The bootstrap walk is ~60 requests, once.
* **Bootstrap walk, run locally.** Wrangler's limits are not enforced in local development, so
  the one-time reconciliation of the importer's items runs from a laptop against the *remote*
  D1 and the real APIs: put `MONDAY_API_TOKEN` and `FUNRAISE_API_KEY` in `funraise-sync/.dev.vars`
  (gitignored; delete it afterwards), start `npx wrangler dev --remote --test-scheduled
  --env sandbox` (since the 2026-09-19 move: the sandbox D1, queues and `ENVIRONMENT` var come
  from `env.sandbox`; before it, `--var ENVIRONMENT:sandbox` against the top-level binding), and hit
  `http://localhost:8788/__scheduled?cron=0+*+*+*+*` once per page — each invocation is one
  deployed-shaped run that advances the cursors. Read the `subscriptions poll read …` log line
  each time. The walk is done when the log line ends `caught up` (since #25's keyset change an
  idle run reads `0 rows`; before it, `>=` re-read the boundary rows every run). Then `select count(*) from subscriptions` on the remote D1 should equal
  the board's item count and Funraise's own subscription count.
  **Do it while the deployed hourly cron cannot fire** (deploy with `subscriptionsPoll.enabled:
  false`, or finish between two top-of-the-hour runs): on 2026-09-19 the 02:00 cron and the local
  loop reached the same page within a second and both created subscription 197170 before either
  had recorded it; the copy the ledger didn't own was deleted by hand. (Since #25 a ledger miss
  first takes an atomic D1 claim — `subscription_claims`, migration `0005` — so two writers can
  no longer both create; the loser skips that row until the next run. Still prefer a quiet
  window: a loser's page is simply re-read.) Funraise's webhook Test
  payload has no `subscription`, so its Donations item must show an empty Recurring Gift column.
* **Done 2026-09-19 (CRM Sandbox, run locally as above, ~140 invocations).** Funraise holds
  1,175 subscriptions — 542 Active, 61 Cancelled, 4 Failed, 568 Redacted. The importer had put
  604 on the board (the Salesforce package never carried 567 of the Redacted ones, which are
  historical agreements bulk-imported into Funraise on 2024-10-09 with their payment method
  scrubbed; decision DWK 2026-09-18: mirror Funraise fully, so they were created). Result,
  across the local walk and the hourly cron runs that overlapped it: all 604 importer items
  adopted, 571 created, ledger 1,175 = board 1,175 = Funraise 1,175, every row with a
  Donor link and a Status; cursor `1789733255690`, page 0. Three things this walk uncovered
  and fixed on the way: Funraise 500s on an `updtime` filter below ~2001 (cursor floored), a
  bulk import gave hundreds of rows one `updtime` (page index persisted across runs), and
  `Redacted` was not in `statusLabelMap` (mapped).
* **Redone 2026-09-30 on Recurring Gifts (sandbox v3)** after the board rebuild left the ledger
  pointing at deleted items: ledger and cursors cleared, 167 local invocations, 604 adopted and
  572 created, ledger 1,176 = board 1,176. See "Rebuilt boards: remap, re-bootstrap, re-verify".

## Open

1. ~~One webhook, transactions only — poll or drop?~~ **Decided 2026-09-18**, above.
2. ~~Per-board column ids.~~ Dissolved by the same decision: once the registration and
   subscription routes are gone the webhook consumer writes only the Donations board, and the
   poller carries its own column block.
3. ~~Register the webhook at `/webhooks/funraise/transaction?secret=…`~~ **Done 2026-09-18**
   (see "APIs & auth"). The former subscription / pledge / registration paths are gone; any
   other path 404s.
4. ~~Deploy the poller build and run the first poll~~ **Done 2026-09-18/19**: `FUNRAISE_API_KEY`
   set, migration `0004` applied, poller deployed, bootstrap walk finished (see "Recurring gifts
   and registrations"). The deployment is still under the production name with sandbox ids
   baked in; the move onto `env.sandbox` (D1 export/import, secrets, `deploy:sandbox`, repoint
   Funraise's webhook, delete the production-named Worker) is the sandbox design's §9.
5. **Gift Type vocabulary for tickets.** `eventGiftTypeValue` ships as `Event Ticket`; confirm
   the label staff want on the Donations board before the first paid Funraise ticket arrives.

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

## Development

```sh
npm install
npm test            # vitest
npm run typecheck   # wrangler types, then tsc --noEmit — the only supported typecheck
```

Type-check with `npm run typecheck`, never a bare `tsc --noEmit`. Binding types (`DB`,
`WRITE_QUEUE`, `REQUEST_RATE_LIMITER`, …) come from `worker-configuration.d.ts`, which
`wrangler types` generates from `wrangler.jsonc` and which is deliberately not committed (root
`.gitignore`: it can absorb local `.dev.vars` names, and every Worker here regenerates it). A bare
`tsc` reads whatever copy is on disk — missing on a fresh clone, stale after a binding is added —
and fails with errors like `Property 'REQUEST_RATE_LIMITER' does not exist on type 'Env'` that
say nothing about the code. CI (`.gitlab-ci.yml`) already runs `npm test` and
`npm run typecheck`.

## Sources

* `docs/01-funraise-pipeline-current-state.md` (private planning repo)
* `docs/02-entity-field-inventory.md` (private planning repo)
* `docs/03-monday-migration-mapping.md` (private planning repo)
* [Funraise integrations page](https://www.funraise.org/integrations)
* [Funraise API overview](https://help.funraise.io/en/articles/10518268-funraise-api)
* [Funraise API reference (Stoplight)](https://funraise.stoplight.io/docs/funraise/44e37c461ba67-funraise-api)
* [Funraise webhooks](https://help.funraise.io/en/articles/4471107-webhooks)
* Plan section: Funraise (Integrations) — `migration-plan.md` (private planning repo)
