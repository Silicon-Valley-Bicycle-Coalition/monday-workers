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
Donations board (+ Donor and Recurring Gift links)

Cloudflare cron, hourly ("0 * * * *")
  │  GET /api/v1/crm/subscription?q=updtime >= <cursor> order by updtime asc&page=N …
  │  each row → Recurring Gifts item (adopt by Funraise ID, else create; update in place);
  │  D1 `subscriptions` ledger + `poll_cursors`; cursor advances after each full page
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
(default 365), so raw donor PII doesn't accumulate in D1 indefinitely on either path. Created
Donations items can be stamped with the Funraise transaction id (`funraiseSync.entityIdColumn`)
for orphan recovery before every create — `null` on the sandbox, see "Monday targets". See
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
| `monday.boards["donations:live"]` | Donations (sandbox v2) | `18428131791` | webhook consumer's only target |
| `monday.boards["recurring-gifts"]` | Recurring Gifts (sandbox v2) | `18428131768` | subscriptions poller's target |
| `monday.boards["people-live"]` | People (sandbox v2) | `18428131737` | People (Historical) is not a match target |
| `columnMap["transaction.amount"]` | Donations → Amount (numbers) | `numeric_mm6jkxrs` | Funraise nests amount and status under `transaction` |
| `columnMap["transaction.status"]` | Donations → Status (status) | `color_mm6jqdhn` | labels: Received / Received (Historical) / Failed / Pending; `Complete → Received` via `statusValueMap` |
| `columnMap.donationDate` | Donations → Date (date) | `date_mm6jthpq` | epoch ms in, `{ date: 'YYYY-MM-DD' }` out — see "Fiscal Year Ending" |
| `entityIdColumn` | — | `null` | see below |
| `thankYouSentColumn` | Donations → Thank You Sent (checkbox) | `boolean_mm78nf5s` | |
| `giftTypeColumn` | Donations → Gift Type (text) | `text_mm6j66w3` | `giftTypeValue` "Donation"; `eventGiftTypeValue` "Event Ticket" when the transaction carries `fundraisingEvent` — see "Gift Type" |
| `fiscalYearColumn` | Donations → Fiscal Year Ending (text) | `text_mm70czyd` | |
| `recurringGiftLinkColumn` | Donations → Recurring Gift (connect) | `board_relation_mm6jbjtd` | set on every write of an installment |
| `donorExternalIdColumn` | People → Funraise Profile (link) | `link_mm6j7djp` | lookup by bare id; create writes `{url, text}` |
| `donorEmailColumn` | People → Personal Email (email) | `email_mm6j5e9q` | lookup by address; create writes `{email, text}` |
| `donorLinkColumn` | Donations → Donor (connect) | `board_relation_mm6jf5jb` | |
| `subscriptionsPoll.columns.funraiseId` | Recurring Gifts → Funraise ID (link) | `link_mm6jryz2` | transaction URL + bare id as text, same as the importer; the adopt-before-create lookup key |
| `subscriptionsPoll.columns.donor` | Recurring Gifts → Donor (connect) | `board_relation_mm6j443g` | |
| `subscriptionsPoll.columns.installmentAmount` | Recurring Gifts → Installment Amount (numbers) | `numeric_mm6jg878` | per-installment, per docs/03 |
| `subscriptionsPoll.columns.annualizedValue` | Recurring Gifts → Annualized Value (numbers) | `numeric_mm6jt3sp` | computed: amount × `frequencyMultiplier[frequency]` (Monthly 12, Quarterly 4, Yearly 1) |
| `subscriptionsPoll.columns.frequency` | Recurring Gifts → Frequency (status) | `color_mm6jc24s` | labels: Monthly / Yearly / Quarterly; a frequency missing from `frequencyMultiplier` leaves this and Annualized Value unset, with a warning |
| `subscriptionsPoll.columns.status` | Recurring Gifts → Status (status) | `color_mm6j1tk1` | labels: Redacted / Active / Cancelled / Failed; via `statusLabelMap`, unmapped → unset with a warning |
| `subscriptionsPoll.columns.nextPayment` | Recurring Gifts → Next Payment (date) | `date_mm6j20p6` | epoch ms in; cleared when the subscription has none (cancelled) |
| `subscriptionsPoll.columns.designation` | Recurring Gifts → Designation (text) | `text_mm6jvmje` | from the subscription's `form.name` |
| `subscriptionsPoll.columns.companyMatch` / `.matchEmployer` | Recurring Gifts → Company Match (checkbox) / Match Employer (text) | `boolean_mm6jbmvy` / `text_mm6jma3d` | from `companyMatch.companyName` |

Two ids are deliberately absent:

* **No `description` column.** The Donations board has no description text column; `description`
  is already the item name via `itemNameField`. The importer's `Salesforce Debug` long-text is
  provenance, not a description, and stays untouched.
* **`entityIdColumn` is `null`.** It was meant to be a text column holding the transaction id
  for orphan recovery. The Donations board carries the Funraise id in a **link** column
  (`link_mm6jhcj8`, transaction URL + bare id as text); the lookup half would work (bare-id
  search matches, verified live), but the consumer writes `entityId` as a bare string, which
  Monday rejects on a link column, so every create would fail. `null` disables orphan recovery
  (a retry after a lost status update can duplicate a Donations item) rather than break creates.
  Fix, if wanted: write the same `{url, text}` shape the donor and subscription paths use.

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
2026-06-30 gift is FY 2026). It isn't a Funraise field, so `columnMap` can't map it;
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

* **Hourly cron** `0 * * * *` → `pollSubscriptions`: `GET /api/v1/crm/subscription` with
  `q = updtime >= <cursor> order by updtime asc`, pages of 10 via `page=N`, until a short page.
  Every row goes through `upsertSubscription`. Three cursors in `poll_cursors`: `subscriptions`
  (the timestamp the query filters on), `subscriptions:page` (the next page of that query) and
  `subscriptions:max` (the largest `updtime` seen in it). A run walks pages and persists the page
  index; the timestamp cursor moves only when a short page proves the query exhausted, to that
  max, and the page index resets. It cannot be moved sooner: a bulk import gave hundreds of
  subscriptions one identical `updtime`, and a cursor equal to it re-selects the same first page
  forever (seen live 2026-09-18). A failed page leaves every cursor untouched, so the next run
  re-reads it and the ledger's per-row `updtime` makes already-landed rows no-ops; `>=` re-reads
  the boundary rows on purpose. Idle cost: one request per run. Two more Funraise quirks live in
  `src/funraise/client.ts`: the list answers HTTP 500 to any `updtime` filter below about 2001,
  so a fresh cursor is floored there, and the page size is fixed at 10.
* **One page per run on Workers Free.** A Free-plan invocation may make 50 external
  subrequests (and a cron gets 10 ms CPU); a page of ten rows costs up to ~45 Monday and
  Funraise calls (donor lookup, adopt lookup, write). `subscriptionsPoll.maxPagesPerRun` ships as
  `1`, so a busy hour with more than ten changed subscriptions catches up over the following
  hours from the cursor — and the ~60-page bootstrap walk cannot run deployed at all. Raise the
  value when the account moves to Workers Paid (10,000 subrequests, 15 min CPU per hourly cron).
* **Adopt before create.** A subscription the ledger doesn't know is looked up on the board by
  bare id in the Funraise ID link column; found → updated and recorded, not found → created.
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
  (gitignored; delete it afterwards), start `npx wrangler dev --remote --test-scheduled`, and
  hit `http://localhost:8787/__scheduled?cron=0+*+*+*+*` once per page — each invocation is one
  deployed-shaped run that advances the cursor, so a loop of ~60 requests walks the board. Read
  the `subscriptions poll read …` log line each time; the last one reads `0 rows`. Then
  `select count(*) from subscriptions` on the remote D1 should equal the board's item count and
  `created` should have stayed ≈ 0 (everything adopted). There is no CLI to fire a deployed cron;
  after the bootstrap, wait for the top of the hour and expect a one-request run with
  `unchanged` = the boundary row only. Funraise's webhook Test payload has no `subscription`, so
  its Donations item must show an empty Recurring Gift column.

## Open

1. ~~One webhook, transactions only — poll or drop?~~ **Decided 2026-09-18**, above.
2. ~~Per-board column ids.~~ Dissolved by the same decision: once the registration and
   subscription routes are gone the webhook consumer writes only the Donations board, and the
   poller carries its own column block.
3. ~~Register the webhook at `/webhooks/funraise/transaction?secret=…`~~ **Done 2026-09-18**
   (see "APIs & auth"). The former subscription / pledge / registration paths are gone; any
   other path 404s.
4. **Deploy the poller build and run the first poll** (see "Recurring gifts and registrations",
   "Verify after deploy"): `FUNRAISE_API_KEY` secret, migration `0004`, then one hourly run.
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

## Sources

* `docs/01-funraise-pipeline-current-state.md` (private planning repo)
* `docs/02-entity-field-inventory.md` (private planning repo)
* `docs/03-monday-migration-mapping.md` (private planning repo)
* [Funraise integrations page](https://www.funraise.org/integrations)
* [Funraise API overview](https://help.funraise.io/en/articles/10518268-funraise-api)
* [Funraise API reference (Stoplight)](https://funraise.stoplight.io/docs/funraise/44e37c461ba67-funraise-api)
* [Funraise webhooks](https://help.funraise.io/en/articles/4471107-webhooks)
* Plan section: Funraise (Integrations) — `migration-plan.md` (private planning repo)
