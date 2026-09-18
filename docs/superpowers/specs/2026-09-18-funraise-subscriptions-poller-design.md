# Funraise subscriptions poller, and dropping the registration path — Design

**Date:** 2026-09-18
**Status:** Decided (DWK, 2026-09-18), pre-implementation.
**Worker:** `funraise-sync`.
**Prior art:** `2026-08-22-funraise-sync-design.md` (the webhook shape this narrows);
`funraise-sync/README.md` "The Funraise delivery, as actually sent" and "Deployed and verified";
private planning repo `docs/03-monday-migration-mapping.md` (Recurring Gifts ← Subscription column
mapping) and `migration-plan.md` "Funraise events: ride the direct sync".

## Context

`funraise-sync` was designed for four Funraise entity types — Transaction, Subscription, Pledge,
Registration — each arriving by webhook on its own route. On 2026-09-17/18 the real delivery
turned out to be narrower: Funraise supports **one webhook per organization, and it fires only
"when a Transaction is created or edited"**. The transaction path is now deployed to the CRM
Sandbox and verified three ways (README, "Deployed and verified"). The other three routes are
routable but nothing will ever call them.

What the transaction webhook already carries, and what the REST API can and cannot supply, was
established against the live `svbc` org on 2026-09-18 with the stored API key (`X-Api-Key`, base
`https://api.funraise.io`):

* **A recurring installment is a transaction.** Each `DONATION` delivery carries
  `data.subscription.{id, sequence}` and `data.transaction.frequency` (`"One Time"`, `"Monthly"`,
  `"Yearly"`, …). So every installment already lands on the Donations board with the right amount
  and date, and `donation-rollups`' membership rule sees it. Nothing about *totals* is missing.
* **What is missing is the Recurring Gifts board item itself** — frequency, Active/Cancelled
  status, next payment date, annualized value — which staff use for retention and forecasting and
  which `salesforce-import` fills once at cutover from `funraise__Subscription__c`.
* **`GET /api/v1/crm/subscription` is pollable and filterable.** It returns pages of 10 with
  `page=N` and honours a `q` expression (`status = "Active" order by id asc`,
  `updtime > 1789000000000 order by updtime asc`, `id = 257753`): an exact id returned one row, an
  impossible one returned zero, `status = "Active"` returned only rows with `nextPaymentDate` set,
  and `page` composes with `q`. Each row has `id, name, status, lastPaymentDate, nextPaymentDate,
  cancelDate, sourceAmount, currency, frequency, tags, dedication, companyMatch, anonymous,
  comment, note, imported, paymentMethod, form, campaignPage, supporter{id, …}, cretime,
  updtime`. SVBC has ~600 subscriptions (601 in Salesforce, doc 01); Active ones update a few
  times a month.
* **`GET /api/v1/crm/donation` ignores `q` entirely** (an impossible filter still returns the
  same first page) and pages in ascending id order from 2022. Polling donations is therefore
  impractical — and unnecessary, the webhook covers them. `GET /api/v1/crm/donation/{id}` works.
* **There is no registration resource.** The reference's Fundraising Event group has only
  `create`, `update`, `completeAuctionItem`, `delete`; every guessed registration/event list path
  returned 403 or "Missing Authentication Token". A *paid* ticket arrives as a transaction whose
  `fundraisingEvent` is set (the donation object has that field; both 2026-09-18 test payloads had
  it null). A free registration never surfaces.
* SVBC's events run on Eventbrite. `migration-plan.md` already assigns future Event Registrations
  to an Eventbrite-fed scheduled Worker (reusing `svbc-calendars`' organizer adapter); Funraise
  had 7 event definitions historically, 2 of them tests.

## Decision

1. **Recurring gifts: keep the board, feed it by polling subscriptions on a cron, and link each
   webhook installment to its Recurring Gift item.** The poller is a new `scheduled()` path in
   `funraise-sync`, not a new Worker — it shares the config, the Monday client, donor matching,
   and the D1 database.
2. **Registrations: drop the path.** Remove the route, the column map, the board target and the
   entity type. A paid ticket still lands on Donations via the webhook; it must not be stamped
   `Gift Type = Donation` (see "Event-tagged transactions").
3. **Subscription and pledge webhook routes go too.** Pledge and Subscription are a confirmed 1:1
   duplicate (doc 03); the poller is the only source for both.

With 2 and 3, the webhook consumer only ever writes the Donations board, which dissolves the
"per-board column ids" open item without per-board config.

## Goals

1. A new Funraise subscription appears on the Recurring Gifts board within the poll interval,
   with Installment Amount, Annualized Value, Frequency, Status, Next Payment, Designation,
   Company Match / Match Employer, the Donor link, and the Funraise ID link — the same shape
   `salesforce-import` writes, so migrated and post-cutover items are indistinguishable.
2. A cancellation, amount change, frequency change or next-payment change reaches the board on
   the next poll. Staff never edit these columns by hand.
3. Every installment on the Donations board is linked to its Recurring Gift item, whichever side
   saw the subscription first.
4. Idempotent and resumable: a poll that dies mid-page reprocesses the page and converges; a
   replayed webhook does not create a second link.
5. Under the API budget: 3,000 requests/month on the base plan.

## Non-goals

* Polling donations, supporters or forms. The webhook is the donation source; supporters are
  matched or created from it.
* Event registrations of any kind from Funraise. Eventbrite-fed, separate Worker, per the plan.
* Pledges as a separate entity, `Received Amount` / `Pledge Amount` upkeep. The Salesforce pledge
  object was the subscription's twin; the board's two pledge columns stay whatever the importer
  wrote (revisit if staff want them live).
* Dedication and payment-method fields. Dedication is a PII screen (doc 03); payment method is
  denylisted everywhere.

## Architecture

```
cron (hourly)
  │  1. read cursor from D1 poll_cursors('subscriptions') — an updtime, epoch ms
  │  2. GET /api/v1/crm/subscription?q=updtime >= <cursor> order by updtime asc&page=0,1,…
  │     until a page has < 10 rows
  │  3. for each row: upsertSubscription(row)  (below)
  │  4. after the whole page is written, cursor = max(updtime) of the page
  ▼
D1 subscriptions ledger  ──►  Recurring Gifts board (create / update in place)

webhook consumer, transaction with data.subscription.id
  │  lookup ledger by funraise_id → monday_item_id
  │  miss → GET /api/v1/crm/subscription/{id} → upsertSubscription(row) (creates the item now)
  ▼
Donations item gets Recurring Gift connect column = that item
```

**`upsertSubscription(row)`** is one function used by both paths:

1. Map the row to column values (table below); resolve the donor with the existing `matchDonor`
   (the subscription's `supporter` has the same `id`/`email`/`name` shape as the webhook's).
2. Ledger lookup by `funraise_id`. Hit with the same `updtime` → no-op. Hit with an older
   `updtime` → `change_multiple_column_values` on the stored item, then update the ledger row.
3. Miss → **adopt before create**: `items_page_by_column_values` on the Recurring Gifts board's
   Funraise ID link column with the bare id (verified live 2026-09-17 on the People board's
   identical link column: the bare id matches, the display text and url do not). Found → treat
   as a hit with no stored `updtime` (update all columns, record the item). Not found →
   `create_item`, record the item. This is what makes the first poll after cutover *adopt* the
   ~600 items `salesforce-import` already created instead of duplicating them, and what makes a
   ledger loss recoverable.

**Cursor semantics.** `updtime >= cursor`, not `>`: two rows can share an `updtime`, and a page
boundary can fall between them. The ledger's per-row `updtime` makes the resulting re-reads
no-ops, so `>=` costs nothing and loses nothing. The cursor advances **only after every row on
the page is written** (the same invariant the repo's CLAUDE.md sets for cron-driven Workers); a
failure mid-page leaves the cursor, the next run re-reads the page and the ledger skips what
already landed. Initial cursor: `0` (full walk, ~60 pages, once).

**Why hourly.** Idle cost is one request per run: 744/month, a quarter of the base budget, with
changes adding a page each. Daily would do for next-payment dates, but a donor who cancels and
calls the office the same afternoon should already show Cancelled. Config, not code.

**Why not a queue.** The poll is its own retry: a Monday failure leaves the cursor where it is
and the next run repeats the page. A dead-letter queue would add nothing but a second thing to
drain.

## Field mapping — Recurring Gifts board (sandbox v2 `18428131768`, ids read live 2026-09-17)

| Funraise subscription field | Column | Id | Shape written | Notes |
|---|---|---|---|---|
| `id` | Funraise ID (link) | `link_mm6jryz2` | `{url: "https://platform.funraise.io/transaction/<id>", text: "<id>"}` | transaction URL on purpose — Funraise's UI shows subscriptions as recurring transactions; same as the importer (`funraiseTransactionLink`), so bare-id lookups work on both |
| `supporter` → `matchDonor` | Donor (connect) | `board_relation_mm6j443g` | `{item_ids: [n]}` | People board only; the importer also linked orgs, this Worker never creates orgs |
| `sourceAmount` | Installment Amount (numbers) | `numeric_mm6jg878` | number | per-installment (doc 03) |
| `sourceAmount × multiplier[frequency]` | Annualized Value (numbers) | `numeric_mm6jt3sp` | number | computed, never copied — `{Monthly: 12, Quarterly: 4, Yearly: 1}` (doc 03) |
| `frequency` | Frequency (status) | `color_mm6jc24s` | `{label}` | labels Monthly / Yearly / Quarterly; live values seen: Monthly, Yearly; unknown → leave unset and log |
| `status` | Status (status) | `color_mm6j1tk1` | `{label}` | labels Redacted / Active / Cancelled / Failed; live values seen: Active, Cancelled; map via config, unknown → unset and log |
| `nextPaymentDate` (epoch ms, null when cancelled) | Next Payment (date) | `date_mm6j20p6` | `{date: 'YYYY-MM-DD'}` via `toISODate` | cleared (`{}`) when null so a cancelled gift doesn't keep a stale date |
| `name` | Item name | — | string | Funraise's own name for the subscription |
| `companyMatch.companyName` present | Company Match (checkbox) | `boolean_mm6jbmvy` | `{checked: 'true'}` / `{}` | |
| `companyMatch.companyName` | Match Employer (text) | `text_mm6jma3d` | string | partner-prospecting signal (doc 03) |
| `form.name` or allocation name if present | Designation (text) | `text_mm6jvmje` | string | the importer used `funraise__Allocation_Name__c`; the API row has `form`, no allocation — confirm on first real rows, may stay blank |

Not written: `dedication.*`, `paymentMethod`, `note`, `comment`, `tags`, `lastPaymentDate`,
`cancelDate` (no columns; the last two are derivable from the Donations installments and the
Status). `Pledge Amount` / `Received Amount` untouched (non-goal).

## Webhook side — two small changes to the transaction consumer

1. **Recurring Gift link.** When `data.subscription.id` is present: ledger lookup → item id;
   miss → `GET /api/v1/crm/subscription/{id}` and `upsertSubscription` (one API call per
   never-seen subscription, so a brand-new monthly donor's first installment links immediately
   instead of waiting for the poll) → set `recurringGiftLinkColumn` (`board_relation_mm6jbjtd`)
   on the Donations item. On create and on update alike — it is a fact, not a stamp.
2. **Event-tagged transactions.** When `data.fundraisingEvent` is non-null, stamp
   `eventGiftTypeValue` (proposed label `Event Ticket`; confirm the Gift Type vocabulary staff
   want) instead of `giftTypeValue` on first write. `donation-rollups`' membership rule counts
   only its eligible list (`Donation`), so a ticket never extends a membership. Everything else
   about the gift (amount, date, donor, Thank You Sent) is unchanged — it *is* revenue.

## Configuration (`config/svbc.json`)

```jsonc
"monday": { "boards": { "donations:live": 18428131791, "recurring-gifts": 18428131768, "people-live": 18428131737 } },
//                       ^ "event-registrations" removed
"funraiseSync": {
  "columnMap": { "transaction.amount": "…", "transaction.status": "…", "donationDate": "…" },
  //  ^ flat: one entity type now; recurringGift/registration maps removed
  "itemNameField": "description", "entityIdField": "id",     // scalars, not per-entity maps
  "recurringGiftLinkColumn": "board_relation_mm6jbjtd",     // Donations → Recurring Gift; null disables
  "eventGiftTypeValue": "Event Ticket",                       // used when data.fundraisingEvent is set
  … (thankYouSentColumn, giftTypeColumn, fiscalYearColumn, donor* keys unchanged)
},
"subscriptionsPoll": {
  "enabled": true,
  "cron": "0 * * * *",                                        // must match wrangler.jsonc triggers
  "pageSize": 10,                                             // what the API returns; not adjustable
  "columns": {
    "funraiseId": "link_mm6jryz2", "donor": "board_relation_mm6j443g",
    "installmentAmount": "numeric_mm6jg878", "annualizedValue": "numeric_mm6jt3sp",
    "frequency": "color_mm6jc24s", "status": "color_mm6j1tk1", "nextPayment": "date_mm6j20p6",
    "designation": "text_mm6jvmje", "companyMatch": "boolean_mm6jbmvy", "matchEmployer": "text_mm6jma3d"
  },
  "frequencyMultiplier": { "Monthly": 12, "Quarterly": 4, "Yearly": 1 },
  "statusLabelMap": { "Active": "Active", "Cancelled": "Cancelled", "Failed": "Failed" },
  "funraiseLinkBase": "https://platform.funraise.io/transaction/"
}
```

`validateConfig` gains the `subscriptionsPoll` block (every column id a non-empty string or
`null`; multipliers positive numbers; label map string→string) and loses the per-entity maps.

**Secrets:** `FUNRAISE_API_KEY` (`wrangler secret put`). The key already used for the 2026-08-24
and 2026-09-18 probes lives locally in `funraise-sync/.env` under the misspelled name
`FUNRISE_API_KEY`; rename it when storing. Scope it read-only in Funraise if the platform offers
that when a fresh key is minted.

**Cron:** `wrangler.jsonc` `triggers.crons` gains `"0 * * * *"` beside the existing daily purge
`"0 9 * * *"`; `scheduled()` dispatches on `controller.cron`.

## Components

* `src/funraise/client.ts` — `listSubscriptionsUpdatedSince(cursor, page)`,
  `getSubscription(id)`. `X-Api-Key`; 429/5xx → throw (the cron retries next run).
* `src/subscriptions/map.ts` — row → column values (pure; the table above).
* `src/subscriptions/upsert.ts` — `upsertSubscription(row, deps)`: ledger, adopt-before-create,
  Monday write, ledger update.
* `src/subscriptions/poll.ts` — cursor read, paging, per-page write, cursor advance.
* `src/db/subscriptions.ts` — D1 ledger. Migration `0004`:

  ```sql
  CREATE TABLE subscriptions (
    funraise_id TEXT PRIMARY KEY,
    monday_item_id TEXT NOT NULL,
    donor_item_id TEXT,
    status TEXT NOT NULL,
    updtime INTEGER,            -- Funraise updtime last written; NULL for an adopted item
    written_at TEXT NOT NULL
  );
  CREATE TABLE poll_cursors (name TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at TEXT NOT NULL);
  ```

* `src/consumer/processBatch.ts` — the two webhook-side changes; `EntityType` narrows to
  `'transaction'`; `BOARD_FOR_ENTITY` and `ENTITY_MAP_KEY` go.
* `src/webhook/route.ts` — the `:entityType` param is dropped; the route is
  `/webhooks/funraise/transaction` only (the registered URL, unchanged).
* Removed: `columnMap.recurringGift` / `.registration`, the `event-registrations` board key, the
  per-entity `itemNameField` / `entityIdField` maps, `isEntityType`.

## Error handling

* **Funraise API down or 429:** the run throws before touching the cursor; nothing partial. Logged
  once per run. Three consecutive failed runs → `console.error` with a distinct prefix (the only
  alerting the Free plan offers is `wrangler tail` and the 3-day Workers Logs).
* **Monday write fails mid-page:** cursor stays; ledger rows already written skip on the re-read.
* **Unknown frequency or status value:** column left unset, row still written, warning logged
  with the value — a new Funraise vocabulary must not stall the poll.
* **Donor can't be matched or created:** the item is still created without a Donor link and the
  ledger records `donor_item_id = NULL`; the next poll that sees the row (any change) retries the
  match. Mirrors the transaction path's tolerance.
* **Ledger miss + adopt finds two items** with the same bare id: take the first, log the
  duplicate id for staff; never create a third.

## Budget

| Component | Requests / month |
|---|---|
| Hourly idle poll | 744 |
| Changed-subscription pages (≈ 30 changes/month at 10 per page, generously) | ≤ 30 |
| Webhook-side `getSubscription` for never-seen subscriptions | ≈ new monthly donors, < 20 |
| Initial full walk (once) | ≈ 60 |
| **Total** | **< 900 of 3,000** |

The poll frequency is the only knob that matters; every 6 hours drops idle cost to 120.

## Testing

* Unit: `map.ts` against a fixture built from the live row shape (keys listed in Context);
  annualized value per frequency; null `nextPaymentDate` clears the column; unknown labels leave
  the column unset.
* D1-backed (existing vitest-pool-workers setup): ledger upsert semantics; cursor only advances
  after a full page; `>=` re-read is a no-op.
* Consumer: an installment with `subscription.id` gets the connect column set on create and on
  update; a never-seen id triggers one `getSubscription` and one create; `fundraisingEvent` set
  → `Event Ticket` stamp, never `Donation`.
* Live, on the sandbox: run the poll once with cursor `0` and verify it **adopts** the importer's
  existing Recurring Gifts items (ledger count ≈ board count, no new items), then cancel nothing
  and re-run to see one idle request. Then re-run Funraise's webhook Test button: its payload has
  no `subscription`, so the link column must stay empty.

## Sequencing

Ships after the Donations path is stable in the sandbox (it is, as of 2026-09-18) and before
cutover, because the first poll's adopt pass is what reconciles the importer's Recurring Gifts
items with live Funraise state. Independent of `donation-rollups`. The registration removal is
part of the same change; nothing depends on those routes.

## Sources

* Funraise webhooks article — https://help.funraise.io/en/articles/4471107-webhooks (single
  transaction webhook; envelope shape).
* Funraise API reference (Stoplight, rendered in the built-in browser 2026-09-18): base URL
  `https://api.funraise.io`, `X-Api-Key`; groups Address, Campaign Site, Donation, Subscription,
  Supporter, Donor, Form, Household, Task, Task Automation, Fundraising Event (create /
  completeAuctionItem / update / delete only), Custom Question, Supporter Relationships, Note,
  Notification.
* Live probes against the `svbc` org, 2026-09-18 (status codes, key names and dates only, no
  donor data read into notes): `crm/subscription` `q` filter/order/exact/page behaviour and row
  keys; `crm/donation` ignoring `q`; `crm/donation/{id}`; 403 on every guessed registration path.
* `salesforce-import/src/transform/boards.ts` (Recurring Gifts column shapes, `funraiseTransactionLink`).
* CRM Sandbox v2 board 18428131768 (Recurring Gifts) and 18428131791 (Donations) column ids, read
  live 2026-09-17.
* Private planning repo: `docs/01` (601 subscriptions, 616 registrations, 7 events),
  `docs/03` (Recurring Gifts mapping, annualized-value rule), `migration-plan.md` (Eventbrite
  Worker for registrations).
