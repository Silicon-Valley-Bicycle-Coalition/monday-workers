# Eventbrite orders → Donations — Design

**Date:** 2026-10-06
**Status:** Proposed, implementing on `feat/eventbrite-orders` (svbc-monday-workers#44).
**Worker:** `eventbrite-sync` (new).
**Prior art:** `funraise-sync` (webhook → D1 ledger → queue → Monday write, adopt-before-create,
first-write stamps, the sandbox environment); `benevity-import` (donor matching by email);
`2026-09-18-funraise-subscriptions-poller-design.md` (why Funraise can't feed event revenue);
`2026-09-18-sandbox-environment-design.md`; private planning repo issue [GL#56](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-migration/-/issues/56) (the decision this
implements) and `migration-plan.md` "Eventbrite".

## Context

**Decision, 2026-09-30 (migration repo [GL#56](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-migration/-/issues/56)): Eventbrite ticket revenue counts as giving.** After
the Oct 9–11 cutover every paid Eventbrite order becomes a Donations item with Status
`Received` and Gift Type `Event Ticket` — the same labels `funraise-sync` writes for a paid
Funraise ticket — linked to the buyer on People by email like every other Worker here.

Nothing does this today. The Salesforce-era path is `eb4sf` (the Eventbrite-for-Salesforce
package), which writes orders and attendees only to Salesforce and retires with it. No Eventbrite
Worker exists in this repo; `svbc-calendars` reads Eventbrite's public event feed for the website
and never sees orders. `salesforce-import` migrates historical Eventbrite *attendees* onto Event
Registrations (with `Eventbrite ID` / `Eventbrite Attendee ID` text columns) but migrates **no
Eventbrite order as a Donations item** — the decision postdates its transform, so there is nothing
on the Donations board for this Worker to collide with at cutover.

Timing: Bike Summit 2026 ticket sales run straight through the cutover, and the Summit itself is
Oct 22. This Worker will not be registered against the live organization before then, so a
one-off export after the Summit covers the gap (see "Backfill"). The Worker is built now so that
the export can go through the *same* code path instead of a hand-keyed spreadsheet.

### What Eventbrite offers (API v3 blueprint, read 2026-10-06)

Everything below is from Eventbrite's published API Blueprint
(`/platform/new/docs/eventbrite-api-v3-public.apib`, the source of the rendered reference at
<https://www.eventbrite.com/platform/api>) and the Webhooks guide
(<https://www.eventbrite.com/platform/docs/webhooks>). Nothing is assumed beyond it.

* **Webhooks are organization-level, created in the dashboard or via
  `POST /v3/organizations/{organization_id}/webhooks/`** with `endpoint_url` (required),
  `actions` (one or more of `attendee.checked_in`, `attendee.checked_out`, `attendee.updated`,
  `event.created`, `event.published`, `event.updated`, `event.unpublished`, `order.placed`,
  `order.refunded`, `order.updated`, `organizer.updated`, `ticket_class.*`, `venue.updated`) and
  an optional `event_id` ("Leave blank for all events"). The blueprint's wording for
  `order.placed`: "Generated Webhook's API endpoint is to the Order endpoint."
* **A delivery carries a pointer, not the object.** The documented payload is
  `{ "api_url": "https://www.eventbriteapi.com/v3/orders/<id>/", "config": { "action":
  "order.placed", "user_id": "<organization id>", "webhook_id": "<id>", "endpoint_url": "…" } }`,
  POSTed as `application/json`. The receiver fetches `api_url` with its own token.
* **No signature.** Eventbrite documents no HMAC header, no shared secret and no verification
  handshake for webhooks (the blueprint's Webhook object has `id`, `resource_uri`, `created`,
  `actions`, `user_id`, `event_id` and nothing else). Third-party guides that show an
  `x-eventbrite-signature` header cite no Eventbrite source and are not relied on.
* **Retries.** The guide says a delivery that doesn't get a 2xx is retried; the schedule is not
  in the blueprint. The dashboard's webhook page has a per-webhook delivery log and a *Test*
  button.
* **Order object** (`GET /v3/orders/{order_id}/`, `Authorization: Bearer <private token>`):
  `id`, `created` (ISO datetime, "when the attendee was created (order placed)"), `changed`,
  `name` ("use this field instead of `first_name`/`last_name`"), `first_name`, `last_name`,
  `email`, `event_id`, `status`, `time_remaining`, `resource_uri`, `costs` — a Cost object whose
  members (`gross`, `base_price`, `eventbrite_fee`, `payment_fee`, `tax`, `display_price`, …)
  are each a Currency Cost `{ currency, value (minor units, integer), major_value (string),
  display }`. "`gross` — The total amount the buyer was charged"; "`base_price` — The organizer
  ticket revenue" (i.e. net of Eventbrite's fees). Expansions `event` (full Event, whose `name`
  is multipart text `{ text, html }`) and `attendees`.
* **Order status.** The blueprint enumerates `started`, `pending`, `placed`, `abandoned` on the
  object and `refunded` elsewhere (a refunded order's status is `refunded`; an attendee carries
  a `refunded` boolean). `placed` is the only "money changed hands" state.
* **Listing orders** for the backfill: `GET /v3/events/{event_id}/orders/` (and
  `/v3/organizations/{organization_id}/orders/`), `status=all_not_deleted`,
  `changed_since=<datetime>`, paginated by `pagination.continuation` /
  `pagination.has_more_items`.
* **Auth.** A private token from the organization's Eventbrite account (Account Settings →
  Developer Links → API Keys), sent as `Authorization: Bearer <token>`. Eventbrite has no
  read-only or per-resource token scope; the token acts as the user that minted it.

## Decision

Build **`eventbrite-sync`**, a webhook-driven Worker in the standard `funraise-sync` shape, that
turns `order.placed` / `order.updated` / `order.refunded` deliveries into one Donations item per
paid order.

1. **Subscribe to the three order actions** on one organization-wide webhook (no `event_id`
   filter: every paid order in every event is giving). `order.updated` is subscribed so a buyer's
   name/email correction or a status change that fires without `order.refunded` still reaches the
   board. Attendee, event, ticket-class, venue and organizer actions are not subscribed; a
   delivery carrying one is acknowledged and ignored.
2. **The webhook is a trigger, never a source.** The route never reads order data from the
   delivery. It parses the order id out of `api_url` — which must match
   `https://www.eventbriteapi.com/v3/orders/<digits>/` exactly, so a forged payload can at most
   name a real order id — records the delivery in D1 and enqueues the id. The **consumer fetches
   the order from Eventbrite with the Worker's own token**, `?expand=event`, at processing time.
   That gives three properties for free: the data written is always authoritative, out-of-order
   deliveries don't matter (whatever Eventbrite says *now* wins), and the D1 ledger never holds a
   payload.
3. **Idempotency key = the Eventbrite order id**, stored in a new Donations **text** column
   **`Eventbrite Order ID`** (config `eventbriteSync.orderIdColumn`) — the bare id, looked up with
   `items_page_by_column_values` the way `funraise-sync` looks up `Funraise ID`. Text rather than
   link because nothing in Eventbrite's organizer UI deep-links an order by id. The column is a
   **prerequisite**: it does not exist on Donations (sandbox v3) or on the production board as
   of 2026-10-06. Someone with write access adds it (board → `+` → Text, title exactly
   `Eventbrite Order ID`; or add `{ title: 'Eventbrite Order ID', type: 'text' }` to the
   `donations` entry of `salesforce-import/src/configure/spec.ts` and run
   `npm run cli -- configure --only donations`, which is idempotent) and puts its id in
   `config/sandbox.json` and `config/svbc.json`. Until then the config holds the
   `REPLACE_WITH_COLUMN_ID` placeholder, the route still accepts and stores deliveries, and the
   consumer refuses to write (a clear error, retried, then dead-lettered) so nothing is created
   without its idempotency key. Re-drive once the column exists.
4. **Adopt before create on that column.** Before creating, the consumer looks the order id up
   on Donations; a hit is updated in place. That covers this Worker's own orphans (a create whose
   D1 update was lost), a backfill re-run, and any gift staff entered by hand with the id filled
   in. As in `funraise-sync`, an adopted item gets only the order-owned columns (Amount, Status,
   Date, the order id), never the first-write stamps or the Donor link.
5. **Refunds → Status `Refunded`.** `statusLabelMap` maps Eventbrite `placed → Received` and
   `refunded → Refunded`; any other status (`started`, `pending`, `abandoned`, …) is **not
   giving** and is skipped — the row is marked `skipped` with the status named, nothing is
   written. `Refunded` is the same label `funraise-sync` relies on, and it is **still missing
   from the Donations Status column** on sandbox v3 (funraise-sync README, "Still true on v3"):
   adding it is already on the pre-cutover list and this Worker inherits the dependency.
   A *partial* refund (some attendees refunded, order still `placed`) is written as `placed` with
   whatever `gross` Eventbrite now reports, and logged; see "Out of scope".
6. **Amount = `costs.gross.major_value`** — what the buyer paid, fees and tax included — by
   default (`amountSource: "gross"`). Eventbrite's service fee and the payment-processing fee are
   **not** deducted: the gift is recorded gross, as Funraise gifts are (Funraise's processing
   fees are likewise not netted off the Donations amount), and fees are a books-side cost for
   QuickBooks. SVBC collects no sales tax on tickets, so `tax` is normally zero; if it is ever
   non-zero it is inside `gross` too. A fork that wants organizer net revenue sets
   `amountSource: "base_price"`. **Free orders are skipped** (`skipFreeOrders: true`; an order
   whose amount is 0 and that has no Donations item yet is marked `skipped`) — a free
   registration is not giving; the Event Registrations side is a separate Worker (below). An
   order already on the board is always updated, even if its amount is now 0, so a refund can
   never be masked by the skip.
7. **Gift date = the order's `created`**, normalized to the Pacific calendar day with the same
   `toISODate` rule as `funraise-sync` ([GL#25](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/25)); Fiscal Year Ending is derived from that same date on
   first write.
8. **Item name = `{buyer} - {event}`** (config `itemNameTemplate`; placeholders `{buyer}`,
   `{event}`, `{orderId}`), e.g. `Jane Rider - Bike Summit 2026`, mirroring Funraise's
   "Debbie Donor - Funraise …" descriptions. The Donations board has no notes/description column
   (funraise-sync README, "One id is deliberately absent"), so the event name lives in the item
   name. Fallback `Eventbrite order <id>` when the expansion is missing.
9. **First-write stamps, exactly as `funraise-sync`:** `Thank You Sent = true` (Eventbrite sends
   the buyer its own order confirmation, the same reasoning as Funraise's receipt), `Gift Type =
   Event Ticket` (`giftTypeValue`; the label `donation-rollups`' membership rule excludes, so a
   ticket never extends a membership), `Fiscal Year Ending`. Never on an update, never on an
   adopted item.
10. **Donor = People item matched by the order's `email`** on `donorEmailColumn` (the Personal
    Email column; bare-address lookup verified live for funraise-sync 2026-09-17), created with
    `name` and `{ email, text }` when no match — `funraise-sync`'s `matchDonor` minus the
    Funraise-profile step (Eventbrite has no stable buyer id worth a People column). People
    (Historical) and Organizations are not match targets. The match is cached on the ledger row
    so a retry or a later update doesn't re-run it.
11. **PII at rest: none.** The ledger stores the order id, event id, last action, Eventbrite
    status, amount, currency, order date, the Monday item ids, timestamps and the last error.
    No name, no email, no payload — so there is no retention purge to run and no cron.
12. **Reuse, verbatim:** the canonical Monday GraphQL transport (`src/monday/graphql.ts`,
    byte-identical copy; path added to the `monday-graphql-copies` CI job), `environment.ts` and
    the sandbox split (`config/sandbox.json`, `config/split.test.ts`, `env.sandbox` in
    `wrangler.jsonc`), the request rate limiter, the dead-letter consumer, retry backoff
    (1, 4, 16 minutes), the constant-time secret compare. Log safety: console lines name order
    ids and item ids only.

### Webhook verification

Eventbrite offers no signature, so this Worker uses the same two layers `funraise-sync` does for
Funraise (which has the same gap), plus one Eventbrite-specific one:

1. **A shared secret in the registered URL**, `POST /webhooks/eventbrite/order?secret=<value>`,
   compared in constant time on every delivery; callers that can set headers (the backfill
   script, a hand replay) send `X-Webhook-Secret` instead. Fails closed: 401 on every POST until
   `EVENTBRITE_WEBHOOK_SECRET` is set. Eventbrite's webhook form takes only a URL, so the secret
   must ride in it; the tradeoff (the secret appears wherever the full request URL is logged) and
   its mitigations are the ones already written up in funraise-sync's README.
2. **The payload is never trusted for data** (decision 2). The only thing read from it is the
   order id, after the URL is matched against the Eventbrite API host and path. Everything
   written to Monday comes from the Worker's own authenticated fetch, so a forged delivery can
   make the Worker re-read a real order (a no-op write) and nothing else.
3. **`config.user_id` sanity check.** When `eventbrite.organizationId` is configured and the
   delivery carries `config.user_id`, they must match or the delivery is acknowledged (200) and
   ignored with a warning — a filter against a webhook registered on the wrong account, not an
   auth control.

A malformed body (no `api_url`, wrong host, no order id) is answered 200 with `ok: false` and a
`console.error`, so Eventbrite does not retry it forever and the shape change is visible in
Workers Logs — the same choice funraise-sync made. An enqueue failure is a 500 so Eventbrite
retries.

## Architecture

```
Eventbrite (SaaS)
  │  webhook: order.placed | order.updated | order.refunded
  │  { api_url: "https://www.eventbriteapi.com/v3/orders/<id>/", config: { action, user_id, … } }
  ▼
Cloudflare Worker (webhook handler)   POST /webhooks/eventbrite/order?secret=…
  │  1. verify the shared secret (constant time); check the action is subscribed; parse the
  │     order id out of api_url (host and path must match — nothing else is read)
  │  2. upsert D1 `orders` keyed on the order id (status 'received', deliveries += 1)
  │  3. enqueue { orderId, action }; mark 'queued'; 500 if the enqueue fails
  ▼
Cloudflare Queue → consumer (max_concurrency 1)
  │  1. GET /v3/orders/{id}/?expand=event with the private token (404 → mark failed, ack)
  │  2. map: status → label (unmapped → skip), amount (gross, or base_price), date (Pacific
  │     day of `created`), item name, fiscal year
  │  3. donor: ledger's cached match, else People lookup by email, else create
  │  4. write: ledger has an item id → update; else adopt by Eventbrite Order ID → update; else
  │     create with the first-write stamps. Record the item id and the order facts in D1.
  │  failure at any step → retry with backoff (1, 4, 16 min), then the dead-letter consumer
  │  stamps the row and logs one error naming the order ids
  ▼
Donations board (+ Donor link to People)
```

### D1 ledger (migration `0001_create_orders.sql`)

```sql
CREATE TABLE orders (
  order_id TEXT PRIMARY KEY,         -- Eventbrite order id (the idempotency key)
  event_id TEXT,                     -- Eventbrite event id, filled by the consumer
  last_action TEXT NOT NULL,         -- the most recent webhook action seen
  status TEXT NOT NULL DEFAULT 'received',  -- received | queued | written | skipped | failed
  eventbrite_status TEXT,            -- placed | refunded | … as last fetched
  amount TEXT,                       -- major_value string as last written (e.g. "45.00")
  currency TEXT,
  order_created TEXT,                -- Eventbrite `created`, ISO
  matched_donor_item_id TEXT,        -- People item, cached after the first match
  monday_item_id TEXT,               -- Donations item once written or adopted
  error TEXT,
  deliveries INTEGER NOT NULL DEFAULT 1,
  received_at TEXT NOT NULL,         -- last delivery
  written_at TEXT
);
```

No `raw_payload`, no name, no email. `status` means *ingested*, as in every Worker here; the
queue is what makes the write durable.

### Consumer rules

* **Always re-fetch.** Every message, including a retry, fetches the order fresh. Two
  deliveries for one order (placed, then updated seconds later) cost two fetches and two
  idempotent writes; that is cheaper than guessing which is newer.
* **404 from Eventbrite** (a deleted order, or the dashboard's Test button pointing at a
  non-existent one): mark `failed` with "not found in Eventbrite", ack — a retry cannot help.
  401/403 (bad token), 429, 5xx, timeouts: throw, so the queue retries and dead-letters.
* **Unmapped status, or a free order with no item yet:** mark `skipped` with the reason, ack.
  Nothing is written. A later delivery for the same order (a `pending` order that becomes
  `placed`) re-evaluates from scratch.
* **Missing `orderIdColumn` (placeholder):** throw before any Monday call. The row goes
  `failed` → dead-lettered with a message naming the config key; re-drive after the column
  exists.
* **No email on the order:** write the gift without a Donor link and log a warning (order id
  only). A later `order.updated` with an email picks the link up.
* **Donor match or create fails:** throw (retry, DLQ) — same as funraise-sync; a gift without a
  donor is worse than a late one.

### Configuration

`config/svbc.json` (production, placeholders until cutover) and `config/sandbox.json` (sandbox v3
ids), chosen by `ENVIRONMENT`:

```jsonc
{
  "monday": { "apiUrl": "https://api.monday.com/v2", "boards": { "donations:live": 18431577310, "people-live": 18431577220 } },
  "eventbrite": {
    "apiUrl": "https://www.eventbriteapi.com/v3",
    "organizationId": null,             // string; sanity-checked against config.user_id when both present
    "actions": ["order.placed", "order.updated", "order.refunded"]
  },
  "eventbriteSync": {
    "orderIdColumn": "REPLACE_WITH_COLUMN_ID",   // Donations → Eventbrite Order ID (text) — the prerequisite
    "amountColumn": "numeric_mm79nz8b",          // Donations → Amount
    "statusColumn": "color_mm79q3b3",            // Donations → Status
    "dateColumn": "date_mm7938jk",               // Donations → Date
    "amountSource": "gross",                     // or "base_price"
    "skipFreeOrders": true,
    "statusLabelMap": { "placed": "Received", "refunded": "Refunded" },
    "itemNameTemplate": "{buyer} - {event}",
    "thankYouSentColumn": "boolean_mm7ddybs",    // null disables each stamp
    "giftTypeColumn": "text_mm79fzs3",
    "giftTypeValue": "Event Ticket",
    "fiscalYearColumn": "text_mm7973ah",
    "donorEmailColumn": "email_mm79m5qa",        // People → Personal Email
    "donorLinkColumn": "board_relation_mm795r2d" // Donations → Donor
  }
}
```

`validateConfig` runs once per isolate and rejects anything missing or mistyped. The sandbox
column ids are the ones `funraise-sync` already carries for Donations (sandbox v3) and People
(sandbox v3), read live 2026-09-30 — the same columns, deliberately, so a Funraise ticket and an
Eventbrite ticket look identical on the board.

**Secrets** (`wrangler secret put …`, and again with `--env sandbox`): `MONDAY_API_TOKEN` (the
shared `Sandbox Integration` user in the sandbox; a dedicated integration user in production —
root README "Least-privilege Monday tokens", and `scripts/check-monday-token-scope.mjs` before
calling it scoped), `EVENTBRITE_PRIVATE_TOKEN` (an Eventbrite private token from SVBC's
organizer account; it can read every order, so treat it like the Monday token), and
`EVENTBRITE_WEBHOOK_SECRET` (`openssl rand -hex 32`, embedded in the registered URL).

**Sandbox.** Same `env.sandbox` shape as funraise-sync: `svbc-eventbrite-sync-sandbox`, its own
D1, queues `eventbrite-sync-writes-sandbox` / `-sandbox-dlq`, rate limiter, secrets. This Worker
writes only to Monday, so there is no outbound sink to lock; the split keeps the two deployments
apart after cutover. Eventbrite allows many webhooks per organization, so unlike Funraise the
sandbox can keep its own live webhook beside production's.

## Backfill — the Oct 22 Summit gap, and any later outage

`scripts/backfill-orders.mjs` lists an event's orders from Eventbrite
(`GET /v3/events/{event_id}/orders/?status=all_not_deleted`, following `continuation`) and POSTs
each as a synthetic delivery — `{ api_url: order.resource_uri, config: { action:
"order.placed" } }` with the secret in `X-Webhook-Secret` — to the deployed Worker. Every order
then goes through the route, the ledger and the consumer exactly as a live delivery would, and
adopt-before-create makes a re-run a no-op. The script never touches D1 or Monday itself, and
prints the plan with `--dry-run`. Procedure for the Summit: once this Worker is deployed to
production with the column in place, run it once for the Bike Summit 2026 event id (and once per
other event that sold tickets between cutover and the webhook registration). Orders refunded by
then arrive as `refunded` and are written `Refunded`.

## Out of scope (documented follow-ups)

* **Event Registrations linkage.** The plan assigns Event Registrations to an Eventbrite-fed
  Worker that upserts attendees onto Event Registrations by `Eventbrite Attendee ID` (the
  importer already stamps it). That is the `attendees` expansion plus the `attendee.*` actions
  and a second board; it is a separate design, and this Worker leaves a hook for it (the ledger
  keeps `event_id`). Until then a Donations item from a ticket has no link to its registration.
* **Per-attendee gifts.** One order = one Donations item, however many tickets it holds. The
  buyer is the donor. Splitting an order across attendees needs the Registrations Worker.
* **Partial refunds.** Written as `placed` with Eventbrite's current `gross`; whether that
  `gross` reflects the refund is not stated in the blueprint. Verify on the first real partial
  refund and decide whether to compute from `attendees[].costs`.
* **Promo codes / discounts.** `costs.gross` is after discount; `discount_amount` is not
  recorded anywhere.
* **Multi-currency.** SVBC's events are USD; `currency` is stored but not converted.
* **Historical Eventbrite orders** (before cutover) are not migrated as Donations. If staff
  want pre-2026 ticket revenue on the board, the backfill script can walk older events, one
  event id at a time.

## Testing

* Unit (Vitest, `@cloudflare/vitest-plugin`): delivery validation (api_url host/path, action
  allowlist, user_id check), the secret compare and route (401 fail-closed, 200 ignore, 500 on
  enqueue failure), the Eventbrite client (bearer header, expand, 404 → null, 5xx → throw), the
  order mapper (status map, gross vs base_price, free-order skip, Pacific date, fiscal year,
  item name template), donor matching, the consumer (create with stamps / update without /
  adopt without donor link / skip / 404 / retry backoff), the dead-letter consumer, config
  validation, the D1 ledger, the config split, and the backfill planner.
* Integration (real D1 in workerd): route → ledger → consumer with a fake Eventbrite client and
  a fake Monday client, create then update then refund.
* Live, on the sandbox, after the column exists: register a sandbox webhook on a test event,
  place a free order (expect `skipped`), a paid order (expect the item with every column), refund
  it (expect `Refunded`), then run the backfill script for that event (expect no second item).

## Sequencing

1. Merge this Worker (tests, typecheck, log-safety and the graphql-copies check green).
2. Prerequisites, any order: the `Eventbrite Order ID` text column on Donations (sandbox v3,
   then production); the `Refunded` Status label (already on the pre-cutover list); an Eventbrite
   private token; D1 and queues provisioned; the three secrets set.
3. Deploy to the sandbox, register a sandbox webhook, run the live checks above.
4. After cutover: production deploy, register the production webhook on SVBC's organization
   with the three order actions, then run the backfill for Bike Summit 2026 after Oct 22.

## Sources

* Eventbrite API v3 blueprint, `https://www.eventbrite.com/platform/new/docs/eventbrite-api-v3-public.apib`
  (read 2026-10-06): Group Webhooks (`Create Webhook` attributes and the action list), Group
  Order (Order Fields, Order Costs Fields, `Retrieve Order by ID`, `List Orders by Event ID`),
  `Order (object)` status members, `Currency Cost (object)`, `Pagination (object)`,
  Authentication ("Get a Private Token", `Authorization: Bearer`).
* Eventbrite Webhooks guide, <https://www.eventbrite.com/platform/docs/webhooks> (delivery
  payload `api_url` + `config`).
* `funraise-sync/` — route, ledger, consumer, matching, README "Adopt before create" and "The
  Funraise delivery, as actually sent".
* Private planning repo: issue [GL#56](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-migration/-/issues/56) (the decision), `migration-plan.md` "Eventbrite" and the
  Event Registrations Worker assignment.
