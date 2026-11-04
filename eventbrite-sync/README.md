# eventbrite-sync

**Staff UAT script:** [`docs/uat/eventbrite-sync.md`](../docs/uat/eventbrite-sync.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status:** Built (`feat/eventbrite-orders`, 2026-10-06; design:
[`docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md`](../docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md))
— **deployed: sandbox 2026-10-26, production 2026-11-02** (see "Deploy"). Production's order path
is filled from the live boards (Donations, People, `Eventbrite Order ID` `text_mm8n459q`; c579d0d),
with its own D1 and queues; its attendee feed is configured (2026-11-03) with the class emails sent from the send page (see
"Class emails"), and its webhook isn't registered yet, so only the order webhook is live there. The sandbox order path still can't write: `orderIdColumn` in
`config/sandbox.json` is `REPLACE_WITH_COLUMN_ID`. This README doesn't record whether the
`Refunded` Status label it shares with `funraise-sync` has been added to either board.
**Attendee feed and class emails:** built on `feat/eventbrite-attendees` (2026-10-26; design:
[`docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md`](../docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md);
see "Attendee feed and class emails" below). Rehearsed in the sandbox only; production still needs
the items in "Open".
**Priority:** Post-cutover (2026-10-23). Bike Summit 2026 (Oct 22) now sells out *before*
cutover, so `eb4sf` puts its orders in Salesforce and `salesforce-import` carries them over as
Event Ticket gifts with their order ids; this Worker takes every order after that, and the
backfill (below) covers the gap between the final extract and the webhook registration. Decision that it counts as giving: migration repo issue #56 (2026-09-30).
**Owner:** David (decided 2026-10-09).
**Stack:** Hono + TypeScript + D1 + Cloudflare Queues (the shared stack, see `../README.md`).

## The ask

SVBC's events sell tickets on Eventbrite. Today the `eb4sf` package writes each order and
attendee into Salesforce, where paid tickets have never been treated as gifts. On 2026-09-30 the
migration decided they are: **after cutover, every paid Eventbrite order becomes a Donations item
with Status `Received` and Gift Type `Event Ticket`** — the same labels `funraise-sync` writes for
a paid Funraise ticket — linked to the buyer on People by email. Nothing does this today, and
`eb4sf` retires with Salesforce. This Worker is the replacement.

The orders feed is one half. One order is one gift, however many tickets it holds; the buyer is
the donor. The other half (2026-10-26) is an **attendee feed**: a second webhook keeps the Events
and Event Registrations boards in step with Eventbrite, and a send page (Google Apps Script) asks
the Worker who may be emailed for a class and records who was (see "Attendee feed and class
emails"). The Worker itself never sends email.
`svbc-calendars`, the other Eventbrite consumer in this repo, reads the public event feed for the
website and never sees orders or attendees.

## Data flow

```
Eventbrite (SaaS)
  │  one organization-wide webhook: order.placed, order.updated, order.refunded
  │  { "api_url": "https://www.eventbriteapi.com/v3/orders/<id>/",
  │    "config": { "action": "order.placed", "user_id": "<org>", "webhook_id": "…", "endpoint_url": "…" } }
  ▼
Cloudflare Worker (webhook handler)   POST /webhooks/eventbrite/order?secret=…
  │  1. verify the shared secret (constant time); unsubscribed action → 200, ignored
  │  2. take the order id out of api_url — host and path must match, nothing else is read
  │  3. upsert D1 `orders` keyed on the order id; enqueue { orderId, action }; 500 if that fails
  ▼
Cloudflare Queue → consumer (one at a time)
  │  1. GET /v3/orders/{id}/?expand=event with the Worker's own private token
  │  2. map: status → label (placed → Received, refunded → Refunded, else skip), amount = gross,
  │     Date = Pacific day of `created`, item name "{buyer} - {event}", fiscal year
  │  3. donor: cached on the row, else People lookup by email, else create
  │  4. write: ledger item → update; else adopt by Eventbrite Order ID → update; else create
  │     with the first-write stamps (Thank You Sent, Gift Type, Fiscal Year Ending)
  │  failure → retry with backoff (1 min doubling to 1 h, 100 tries) → dead-letter consumer marks the row and logs
  ▼
Donations board (+ Donor link to People; ids in config/sandbox.json, svbc.json for production)
```

**The delivery is a trigger, never a source.** Eventbrite's webhook carries only a pointer, so the
consumer fetches the order at processing time. That is why out-of-order deliveries don't matter
(whatever Eventbrite says now is what gets written), why a redelivery is enqueued rather than
deduped (one extra fetch, an idempotent write, never a second item), and why the D1 ledger holds
**no name, email or payload** — nothing personal at rest, so unlike `funraise-sync` there is no
retention purge. (The hourly cron only runs the daily missed-order check.) See `../README.md`'s Reliability section for why the Queue shape is
standard across every webhook-driven Worker here.

## APIs & auth

* **Eventbrite API v3** — [reference](https://www.eventbrite.com/platform/api) (rendered from the
  [API blueprint](https://www.eventbrite.com/platform/new/docs/eventbrite-api-v3-public.apib),
  which is the readable source) · [Webhooks guide](https://www.eventbrite.com/platform/docs/webhooks).
  Base `https://www.eventbriteapi.com/v3`, `Authorization: Bearer <private token>`. This Worker
  makes exactly one call per message, `GET /orders/{order_id}/?expand=event`; the backfill
  script adds `GET /events/{event_id}/orders/`. Nothing here writes to Eventbrite.
* **`EVENTBRITE_PRIVATE_TOKEN`** — `wrangler secret put EVENTBRITE_PRIVATE_TOKEN` (and
  `--env sandbox`). Mint it from SVBC's organizer account: Account Settings → Developer Links →
  API Keys → Create API Key → *Private token* (blueprint, "Get a Private Token"). Eventbrite has
  **no read-only or per-resource scope**: the token acts as the user that minted it and can read
  every order on the account, so treat it like the Monday token (least privilege by *who* mints
  it — a staff login that only administers events, not a personal account with other
  organizations attached). Unset → every message fails and dead-letters naming the secret.
* **Webhook auth.** Eventbrite documents **no signature, no HMAC header and no verification
  handshake** for webhook deliveries (the blueprint's Webhook object is `id`, `resource_uri`,
  `created`, `actions`, `user_id`, `event_id`; third-party guides that show an
  `x-eventbrite-signature` header cite no Eventbrite source and are not relied on). So, as with
  Funraise:

  1. `wrangler secret put EVENTBRITE_WEBHOOK_SECRET` (`openssl rand -hex 32`).
  2. Register the webhook URL **with the secret embedded**:
     `https://<worker-host>/webhooks/eventbrite/order?secret=<value>`.

  The route **fails closed**: any POST whose secret doesn't match — including every POST while
  the secret is unset — is 401. Comparison is constant-time (SHA-256 both sides, then an
  early-exit-free byte compare, copied from funraise-sync #25). Callers that can set headers
  (`scripts/backfill-orders.mjs`, a hand replay) send `X-Webhook-Secret` instead, which is
  checked first. Eventbrite itself can't: its webhook form takes a URL and the actions. The
  tradeoff and mitigations are the ones in funraise-sync's README (the secret lands wherever the
  full request URL is logged; keep observability access tight, never log `c.req.url`, rotate by
  re-registering).

  On top of the secret, **the payload is never trusted for data**: the only thing read from it is
  the order id, after `api_url` is checked against `eventbrite.apiUrl` + `/orders/<digits>/`
  (host, path, no query, no credentials). Everything written to Monday comes from the Worker's
  own authenticated fetch, so a forged delivery can at most make the Worker re-read a real order.
  When `eventbrite.organizationId` is set in config, a delivery whose `config.user_id` names
  another organization is acknowledged and ignored — a sanity filter, not an auth control.
* **Registering it** (not done yet): Eventbrite → Account Settings → Developer Links → Webhooks
  → Add Webhook: Payload URL = the full URL above, Event = *All events* (no `event_id` filter:
  every paid order anywhere is giving), Actions = `order.placed`, `order.updated`,
  `order.refunded`. Or via the API, `POST /v3/organizations/{organization_id}/webhooks/` with
  `{ "endpoint_url": "…", "actions": "order.placed,order.updated,order.refunded" }`. Eventbrite
  allows many webhooks per organization, so the sandbox keeps its own beside production's. The
  dashboard's **Test** button and its per-webhook delivery log are the way to see deliveries
  from Eventbrite's side; a Test delivery that points at a non-existent order is marked `failed`
  ("not found in Eventbrite") and acked, never retried. The blueprint says a non-2xx answer is
  retried but gives no schedule — read it off the delivery log.
* **Monday.com GraphQL API** — from the `monday-auth` broker, not a stored token. Both deployments
  bind `MONDAY_AUTH` (`wrangler.jsonc` `services`) to its `SyncToken` entrypoint — the *SVBC Staff
  Sync* OAuth app — production (`svbc-eventbrite-sync`) to `svbc-monday-auth`, sandbox (`--env
  sandbox`) to `svbc-monday-auth-sandbox`; `src/monday/graphql.ts` `tokenProviderFor` asks it per
  request and re-asks once on a 401. A `MONDAY_API_TOKEN` secret is only the fallback while the
  cutover is under way (delete it once the binding works); with neither, building the Monday client
  throws a config error naming both. Operator scripts (`scripts/*.mjs`) keep reading
  `MONDAY_API_TOKEN` from the operator's shell. Local `wrangler dev` has no broker to call, so put a
  `MONDAY_API_TOKEN` in `.dev.vars` for it. Design:
  `docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md`.

## Prerequisite column: `Eventbrite Order ID`

The idempotency key is the Eventbrite order id, stored in a **text** column titled
**`Eventbrite Order ID`** on the Donations board, config `eventbriteSync.orderIdColumn`.
`salesforce-import` declares it on every migrated gift (2026-10-19), so its `load` creates the
column on the next sandbox load and on the production cutover load — no hand-made column. After
each load, read the column id from `salesforce-import/data/load/boards.json` (or the board), put it in
`config/sandbox.json` (and `config/svbc.json` at cutover) and tighten `config/split.test.ts`
(move `orderIdColumn` into its `COLUMN_KEYS`). Text, not link: nothing in Eventbrite's organizer
UI deep-links an order by id, and a bare-text exact match is the simplest lookup.

Until then both configs ship `REPLACE_WITH_COLUMN_ID`. **The route still accepts and stores
deliveries** (so nothing is lost while the column is pending), and **the consumer refuses to
write** — each message fails with a message naming the key, retries, and dead-letters. Once the
column exists and the config is deployed, re-drive with `scripts/backfill-orders.mjs` for each
affected event. Nothing is ever created without its key, so nothing can be duplicated later.

### Adopt before create

Before creating, the consumer looks the order id up in that column (`items_page_by_column_values`,
the same lookup `funraise-sync` does on `Funraise ID`) and updates a hit instead. That covers this
Worker's own orphans (a create whose D1 update was lost), a backfill re-run, and a gift staff
entered by hand with the id filled in. An adopted item gets only the order-owned columns
(Amount, Status, Date, the id) — never the first-write stamps and never the Donor link, exactly
as funraise-sync treats migrated gifts. Same known gap: archived items aren't visible to the
lookup.

`salesforce-import` **does** migrate Eventbrite orders as Donations items: `eb4sf` files each paid
order as a Closed Won Opportunity, which the importer maps to Received / Event Ticket (#43), and
it stamps `Eventbrite Order ID` from the `eb4sf__Eventbrite_Order__c` record linked to that
Opportunity (the order record's `Name` is Eventbrite's order id). So a webhook or backfill for an
order placed before the final extract adopts the migrated item instead of creating a second one.
Adopting overwrites Amount, Status and Date with what Eventbrite reports now (a refund since the
extract shows as `Refunded`) and leaves the importer's Donor link alone. Coverage, checked live on
2026-10-19: every 2026 Eventbrite-created Closed Won has a linked order; 206 from 2024–2025 have
none and migrate with a blank id, so **never backfill an event that sold tickets before 2026** —
those orders would be created a second time.

## Monday targets (sandbox v3 ids, from funraise-sync's config, read live 2026-09-30)

`config/sandbox.json` points at the same Donations (sandbox v3) and People (sandbox v3) columns
`funraise-sync` writes, on purpose: a Funraise ticket and an Eventbrite ticket should be
indistinguishable on the board. Re-verify against production ids at cutover.

| Config key | Board / column | Id | Notes |
|---|---|---|---|
| `monday.boards["donations:live"]` | Donations (sandbox v3) | `18431577310` | the only write target |
| `monday.boards["people-live"]` | People (sandbox v3) | `18431577220` | People (Historical) is not a match target |
| `eventbriteSync.orderIdColumn` | Donations → **Eventbrite Order ID** (text) | **missing — prerequisite** | bare order id; the adopt-before-create key |
| `eventbriteSync.amountColumn` | Donations → Amount (numbers) | `numeric_mm79nz8b` | `costs.gross.major_value` as a number — see "Amount" |
| `eventbriteSync.statusColumn` | Donations → Status (status) | `color_mm79q3b3` | `placed → Received`, `refunded → Refunded` via `statusLabelMap`; **`Refunded` is not yet a label on the board** (funraise-sync's open item) |
| `eventbriteSync.dateColumn` | Donations → Date (date) | `date_mm7938jk` | the Pacific calendar day of the order's `created` |
| `eventbriteSync.thankYouSentColumn` | Donations → Thank You Sent (checkbox) | `boolean_mm7ddybs` | first write only; Eventbrite sends the buyer its own confirmation |
| `eventbriteSync.giftTypeColumn` / `giftTypeValue` | Donations → Gift Type (text) | `text_mm79fzs3` / `Event Ticket` | first write only; the label `donation-rollups`' membership rule excludes |
| `eventbriteSync.fiscalYearColumn` | Donations → Fiscal Year Ending (text) | `text_mm7973ah` | first write only, derived from the same date as the Date column |
| `eventbriteSync.donorEmailColumn` | People → Personal Email (email) | `email_mm79m5qa` | lookup by bare address; create writes `{ email, text }` |
| `eventbriteSync.donorLinkColumn` | Donations → Donor (connect) | `board_relation_mm795r2d` | `{ item_ids: [n] }` |

## Field mapping

| Eventbrite (Order object, `?expand=event`) | Donations | Rule |
|---|---|---|
| `id` | Eventbrite Order ID | bare string |
| `status` | Status | `statusLabelMap`; `placed` and `refunded` only. `started`, `pending`, `abandoned` and anything else are **not giving**: the row is marked `skipped` with the status named and nothing is written. A later delivery re-evaluates from scratch. |
| `costs.gross.major_value` | Amount | see "Amount" |
| `created` | Date, Fiscal Year Ending | `toISODate` → `America/Los_Angeles` calendar day (#25 rule); FY = July–June year it ends in, first write only |
| `name` (fallback `first_name` + `last_name`) + `event.name.text` | item name | `itemNameTemplate`, default `{buyer} - {event}` → `Jane Rider - Bike Summit 2026`; the board has no notes column, so the event lives in the name |
| `email`, `name` | Donor → People | match by email, create if new — see "Donor matching" |
| — | Thank You Sent, Gift Type | stamps, first write only |

**Amount.** `costs.gross` — "the total amount the buyer was charged" — fees and tax included.
Eventbrite's service fee and the payment-processing fee are **not** deducted: the gift is recorded
gross, as Funraise gifts are (processing fees are a books-side cost for QuickBooks, not a
reduction of the gift). SVBC collects no sales tax on tickets, so `tax` is normally 0; if it
were not, it is inside `gross` too. `costs.gross` is already net of any promo-code discount. A
fork that wants organizer revenue net of Eventbrite's fees sets `amountSource: "base_price"`.
**Free orders** (`gross` 0, or no `costs`) with no Donations item yet are skipped — a free
registration is not a gift. An order that already has an item is always updated even at 0, so a
refund can never be masked by the skip. A **refunded** order with no item yet is skipped too: nothing was ever recorded as received, so there is nothing to reverse. If staff delete or archive an order's item, a later update is recorded `failed` ("deleted or archived") and acked, not retried or recreated.
**Currency (#76).** The Amount column is in `currency` (`"USD"`). An order whose cost is in any
other currency is never written as if it were dollars: once past the skips above, it is recorded
`failed` ("order currency … is not USD") and acked, not retried, with nothing written to Monday —
enter it on the Donations board by hand at the converted amount.

## Donor matching

`funraise-sync`'s `matchDonor` minus the Funraise-profile step: Eventbrite has no stable buyer id
worth a People column, so the order's `email` is the whole key. One `items_page_by_column_values`
on People's Personal Email column with the bare address (verified live for funraise-sync
2026-09-17 on that column); a hit links it, a miss creates a People item named from the order's
`name` with `{ email, text }` in the email column, so a buyer this Worker creates looks like a
migrated person. The match is cached on the ledger row, so a retry or a later `order.updated`
doesn't re-run it. An order with no email is written **without** a Donor link and a warning (order
id only); a later update with an email picks the link up. A Monday failure during the match
throws — retry, then DLQ — a gift without a donor is worse than a late one.

## Failures and the dead-letter queue

A failed consumer run marks the `orders` row `failed` with the error and retries the message with
backoff — 1 minute, doubling to a cap of 1 hour (`retryDelaySeconds` in `src/flags.ts`). After
`max_retries` (100, about four days) the message goes to `eventbrite-sync-writes-dlq` (`…-sandbox-dlq` in the
sandbox), which this Worker also consumes (`src/consumer/processDeadLetters.ts`): the row's
error is prefixed `dead-lettered after retries: ` and the batch logs one `console.error` naming
the order ids. A 404 from Eventbrite is **not** retried: the row is marked `failed` ("not found in
Eventbrite") and acked. Nor is any other failure no retry can fix (#75, `src/errors.ts`): an
Eventbrite or Monday 4xx about the request itself, or a Monday 200 whose error code rejects the
request (a column value it won't take, a column, board or item id that doesn't exist). The row
(order, event or attendee) is marked `failed` with the error prefixed `not retried: ` and the
message is acked. An attendee whose event failed either way is marked `failed` too ("event … failed
without retry" or "not found in Eventbrite"), rather than re-requesting the event on every retry
for four days. A rejected token (401/403), Monday's `UserUnauthorizedException` (also its
answer for a deleted board), rate limits and 5xx still retry, since fixing the secret or the
config heals the whole backlog. To find those: `… where error like 'not retried%'`. To find
dead orders:
`select order_id, event_id, error, received_at from orders where error like 'dead-lettered%'`.
Re-drive by re-running `scripts/backfill-orders.mjs` for the affected event once the cause is
fixed; adopt-before-create makes it safe for the orders that did land.

## Missed-order check (daily)

Failed writes are loud, but a webhook that was deleted, disabled or repointed fails nothing: orders
just stop arriving. So at 15:00 UTC (07:00 or 08:00 Pacific), on one of the hourly cron runs,
`src/missedOrders/check.ts` lists the organization's orders changed in the last 26 hours
(`GET /organizations/{id}/orders/?status=all_not_deleted&changed_since=…`) and looks each id up in
the `orders` ledger. Orders changed in the last 30 minutes are skipped as possibly still in
flight. Any order Eventbrite has that the ledger doesn't gets one `console.error` naming the ids,
which Workers Issues raises; a clean check logs one info line. A day with no sales is not an alarm.
It replaces Salesforce's *Today's Eventbrite Orders Report* subscription, which emailed on every
day with no `eb4sf` orders (svbc-monday-migration #90, `docs/35` §3.6).

It reads with `EVENTBRITE_PRIVATE_TOKEN`; unset, it logs an error and skips. With
`eventbrite.organizationId` null it uses the token's only organization (`GET /users/me/organizations/`)
and fails if the token has more than one. To act on an alarm: check the webhook in Eventbrite
(Account Settings → Developer Links → Webhooks), then re-drive the affected events with
`scripts/backfill-orders.mjs` below.

## Backfill: the Oct 22 Summit, and any later gap

```sh
cd eventbrite-sync
EVENTBRITE_PRIVATE_TOKEN=… node scripts/backfill-orders.mjs --event-id <id> --dry-run
EVENTBRITE_PRIVATE_TOKEN=… EVENTBRITE_WEBHOOK_SECRET=… node scripts/backfill-orders.mjs \
  --event-id <id> --worker-url https://svbc-eventbrite-sync.<subdomain>.workers.dev [--changed-since 2026-10-23T00:00:00Z]
# sandbox: --env sandbox --worker-url https://svbc-eventbrite-sync-sandbox.<subdomain>.workers.dev
# (the script refuses an --env that doesn't match the Worker URL)
```

The script lists the event's orders (`GET /v3/events/{event_id}/orders/?status=all_not_deleted`,
following `pagination.continuation`), keeps the `placed` and `refunded` ones, and POSTs each to
the deployed Worker as the delivery Eventbrite would have sent — a pointer built from the
configured API base and the order id, `order.placed` or `order.refunded` as the action, the
secret in `X-Webhook-Secret`. Every order then takes the normal route → ledger → consumer path
(fetched fresh from Eventbrite, matched, adopted or created), so the backfill exercises exactly
the code the live webhook will, and a re-run is a no-op. It never touches D1 or Monday itself.
Nothing personal is printed: ids and statuses only.

**Procedure for Bike Summit 2026:** after cutover and once this Worker is in production with
the column id in config (see "Deploy"), run it once with the Summit's event id — the event id is
in the manage-page URL (`…/myevent?eid=<id>`) or from `GET /v3/organizations/{org}/events/`. Do
the same for any other event that sold tickets between the final Salesforce extract and the
webhook registration. Orders the cutover load already carried over are adopted, not duplicated
(see "Adopt before create"), so the dry-run's order count includes them; the real run only
creates what landed after the extract.
**Owner and deadline (issue #44).** Run it on or after **2026-10-23**, once Summit sales have
closed, by David (the Worker's owner, decided 2026-10-09). Pre-flight, in order: the
`Eventbrite Order ID` column and `Refunded` label exist on production Donations; `config/svbc.json`
has no `REPLACE_WITH_COLUMN_ID` left; the Worker is deployed and the webhook registered; then
`--dry-run`, compare its order count with the Eventbrite attendee/orders report, then the real
run. If the Worker cannot be in production by then, `--dry-run` still needs only the read-only
token and lists the paid orders (ids and statuses, no PII) — use it as the checklist for a
manual entry on Donations (Gift Type `Event Ticket`, the order id in `Eventbrite Order ID` so a
later backfill adopts the item instead of duplicating it).
An order refunded before the Worker ever saw it has no item to reverse, so it is recorded as `skipped` and nothing is written; one with an item is updated to `Refunded`. The consumer runs one
message at a time, so a few hundred orders take a few minutes; then check the board and
`select status, count(*) from orders where event_id = '<id>' group by status`.

## Attendee feed and class emails

Replaces the Salesforce `eb4sf` Campaigns Bike Education sent class emails from (migration repo
issue #62). Eventbrite is the source of who registered and who checked in; Monday holds Attendance;
a coordinator sends the mail from Gmail through the send page. Design:
[`docs/superpowers/specs/2026-11-03-class-emails-from-monday-design.md`](../docs/superpowers/specs/2026-11-03-class-emails-from-monday-design.md).

```
Eventbrite (SaaS)
  │  second webhook: attendee.updated, attendee.checked_in, attendee.checked_out,
  │  event.created, event.published, event.updated, event.unpublished   (attendeeSync.actions)
  ▼
Worker   POST /webhooks/eventbrite/attendee   (same shared secret: X-Webhook-Secret or ?secret=)
  │  ledger rows in D1 (migration 0002_attendees.sql: `events` and `attendees`, ids and status
  │  only, no personal data), then the same queue → consumer fetches the attendee or event fresh
  ▼
Events board (one item per Eventbrite event, program from the organizer name)
Event Registrations board (one item per attendee: Attendance, First Name, Class Date/Day/Location, People link)
  ▲
Send page (Apps Script, runs as the coordinator)   X-Class-Email-Secret
  │  GET  /class-emails/:eventId          who may get each email, refusals, earlier sends
  │  POST /class-emails/:eventId/claim    records the recipients, returns the ones newly claimed
  │  (the page sends from Gmail, one recipient at a time)
  │  POST /class-emails/:eventId/result   marks the ledger, posts an update, No Show / People link
  │  POST /class-emails/:eventId/release  frees failed recipients, and unconfirmed ones after 10 minutes
  ▼
D1 `class_email_recipients` (migration 0003: event, kind, registration id, status; no names or addresses)
```

As with orders, the delivery is only a pointer; what is written comes from the Worker's own fetch.
The **program** is resolved from the organizer name suffix (same rule as `salesforce-import`);
`attendeeSync.programByOrganizer` is an optional override by organizer id. Attendance is never
downgraded (a check-in is not undone by a later `attendee.updated`), and the People link is set
only once the attendee is Attended and never overwrites a link staff set. Item names follow
Eventbrite: rename a class or attendee there, since a rename in Monday is overwritten by the next
delivery.

### Prerequisites

* Config `attendeeSync` ids for the Events and Event Registrations columns (including
  `events.sendLinkColumn` and `classEmails.pageUrl`), and `peopleEmailColumn`. Production ships
  `REPLACE_WITH_COLUMN_ID` / `null` until set.
* `Attendee Email` must be an **Email** column on Event Registrations. `salesforce-import` only
  creates missing columns, so a production board already loaded with a text column needs it
  converted.
* `wrangler secret put CLASS_EMAIL_SECRET` (`openssl rand -hex 32`), and the same value in the
  send page's Script Properties. Sandbox and production each have their own.
* Register the second webhook (below).

The Monday-side Sequences checklist, [`docs/class-emails-setup.md`](docs/class-emails-setup.md), is
superseded and not part of this flow.

### Class roster

The **Class roster** view on Event Registrations is how staff see who is registered right now:
Attendance = Registered and Class Date today or later, grouped by Event, soonest first.
`salesforce-import`'s `configure` creates it and the four columns this feed writes per attendee
(First Name, Class Date, Class Day, Class Location). Only this feed fills Class Date, so the view
stays empty until the attendee webhook is registered, and a class that was already on sale needs
`scripts/backfill-attendees.mjs` before its existing registrants appear. Check-ins and cancellations
drop people off the view; a class leaves it the day after it runs.

In production the view and columns were created directly on the board on 2026-11-03 rather than
with `configure`, which would also have re-applied the board's five existing views.

### Registering it

Same dashboard route as the order webhook: Payload URL
`https://<worker-host>/webhooks/eventbrite/attendee?secret=<EVENTBRITE_WEBHOOK_SECRET>`, Event =
*All events*, Actions = the list in `attendeeSync.actions` in config. Sandbox keeps its own.

### Class email routes

All four need the header `X-Class-Email-Secret` (compared in constant time against
`CLASS_EMAIL_SECRET`); a missing, wrong or unset secret is a 401 before anything else runs, the
Monday client included. Responses carry names and addresses and are `Cache-Control: no-store`.

| Route | Does |
|---|---|
| `GET /class-emails/:eventId` | `{ event, writesOn, kinds }`: for `reminder`, `thank-you` and `missed-you`, the refusal (if any), the recipients, how many were sent, how many are checked in (`checkedIn`), and the earlier recipients not yet resolved (`unresolved`, each with `status` `claimed` or `failed`). 404 when the event has no ledger row or Monday item, or the Events item is archived or deleted. Works under any write mode. |
| `POST .../claim` `{ kind }` | Re-plans from live Monday data, records the recipients in the ledger, and returns only those this call newly claimed. A second call returns none. 404 as for GET, including an archived or deleted Events item. 503 unless the write switch is `on`. |
| `POST .../result` `{ kind, sender, subject, results: [{ registrationId, status, error? }] }` | Marks claimed rows `sent` or `failed`; ids not claimed for this event and kind are ignored. This works under any write mode, because the emails have already gone. Only under `on`, one update on the Events item follows: kind, subject, sender, count, a `Failed:` line per failure and an `Unconfirmed:` line per recipient still claimed (an update is posted for those even when this call recorded nothing new). Then, under `waitUntil`, a missed-you sets Attendance to No Show on confirmed rows still Registered (read fresh), and a thank-you links People when the Attendee link is blank. |
| `POST .../release` `{ kind, sender, registrationIds }` | Frees `failed` rows at any time, and `claimed` rows once they are at least 10 minutes old (never `sent`), so they can be claimed again. Returns `{ ok: true, released, tooRecent }`. Posts an update naming the sender and counting what was released, or nothing if nothing was. 503 unless `on`. |

* **Who gets each email:** Role = Participant with an Attendee Email. Reminder: Registered, refused
  once the class has started. Thank-you: Attended, refused until the class has ended or when no
  Participant with an Attendee Email is Attended (a volunteer or a blank-email row doesn't count).
  Missed-you: Registered or No Show, same refusals. Canceled never. Only an Eventbrite status of
  `live`, `started`, `ended` or `completed` may send; anything else, including `draft`, `canceled`,
  `deleted` and no status, is refused for every kind. One email per address per kind, first
  registration wins; a missed-you skips an address that attended on another eligible registration.
* **At most once.** A recipient is recorded (claimed) before the page may send to them, and a
  claimed recipient is never handed out again. A crash leaves them `claimed`, shown as unconfirmed;
  only a person releases them, and not until 10 minutes after the claim (`RELEASE_MIN_CLAIM_AGE_MS`),
  because Apps Script runs stop at about 6 and a younger claim may still be sending.
* **The ledger is written first** in `result`, so a Monday failure (the update, No Show, People
  match) is logged by id and error class and cannot lose what was sent.
* **A switch flipped mid-send.** `result` records the ledger under any mode so people already
  emailed don't show as unconfirmed, but off `on` it skips the update, No Show and People link, and
  nothing replays them.
* **Nothing personal is logged.** Addresses, names, the subject and the page's `error` strings
  (which may echo an address) never reach `console.*`. The update on the staff board does carry
  the real sender, the subject, failed and unconfirmed addresses (the replaced one in the sandbox),
  and the page's error text passes through, one line cut to 200 characters.
* **Sandbox lock.** When `attendeeSync.classEmails.sandboxRecipient` is set, every recipient any
  route returns, and every address in an update, is that one address. Planning still runs on the
  real addresses, so the one-address rule behaves as in production.
* Bodies are validated by hand: an unknown `kind`, a non-array `results`, a non-string or
  non-address `sender`, or more than 500 `results` or `registrationIds` is a 400.
* Cost of a result is one Monday read and at most one write per sent registration (plus a People
  lookup for each unlinked thank-you), so a 26-person thank-you is about 80 subrequests and little CPU;
  `wrangler.jsonc`'s 100 ms limit should hold, but a timed run in the sandbox is still to do.

**Accepted risk: partial check-in.** If staff check in only some of the people who came, the rest
get a missed-you. The page shows the list first and the coordinator chooses when check-in is
finished; only "nobody checked in" is refused.

### Backfill

`scripts/backfill-attendees.mjs` replays an event's attendees to the deployed Worker, as the order
backfill does: flags `--event-id`, `--worker-url`, `--env`, `--pause-ms`, `--dry-run`. Use it for a
class that predates the webhook. Nothing is emailed automatically: a backfill only fills the boards,
and mail goes out when a coordinator uses the send page, which hands out only people no one has been
sent to for that kind.

## Resetting for new board ids

When the boards this Worker writes are deleted and rebuilt (a cutover retry — private runbook,
Rollback step 8 — or a sandbox rebuild), every `monday_item_id` in D1 is dead: an update to a
known order, event or attendee goes to an item that no longer exists. Reset D1 before the
Eventbrite webhook points at the Worker on the new boards. Nothing needs keeping: all three
kinds adopt before create on the new boards (orders by **Eventbrite Order ID**, events by
**Eventbrite ID**, registrations by the attendee id column), so a re-drive updates what the new
load already carries and creates only what it doesn't.

**First:** set the switch to `hold` (`node scripts/flags.mjs eventbrite-sync writes hold --env
production`) and disable the Eventbrite webhooks, so nothing is written back.

```sh
# 1. Export, to somewhere outside the repo (it holds order amounts and item ids).
npx wrangler d1 export svbc-eventbrite-sync --remote --output <dir>/svbc-eventbrite-sync.sql

# 2. Clear all three tables. -y answers any wrangler confirmation prompt; unanswered without a
#    TTY, one cancels silently with exit 0.
npx wrangler d1 execute svbc-eventbrite-sync --remote -y --command \
  "DELETE FROM attendees; DELETE FROM events; DELETE FROM orders;"

# 3. Check: every count is 0.
npx wrangler d1 execute svbc-eventbrite-sync --remote --command \
  "SELECT 'orders' AS t, COUNT(*) AS n FROM orders UNION ALL SELECT 'events', COUNT(*) FROM events UNION ALL SELECT 'attendees', COUNT(*) FROM attendees"
```

Sandbox: `svbc-eventbrite-sync-sandbox`, with `--env sandbox` on every command.

| Table | Reset | Why |
|---|---|---|
| `orders` | cleared | `monday_item_id` and `matched_donor_item_id` are Donations and People items on the old boards. |
| `events` | cleared | `monday_item_id` is an Events item on the old board. |
| `attendees` | cleared | `monday_item_id` and `matched_person_item_id` are Event Registrations and People items on the old boards. |

`d1_migrations` is untouched. A message still on the queue for an old item finds no row and is
handled as a new delivery once the switch is back `on`.

**Then:** deploy with the new ids, `writes on`, re-register the webhooks, and re-drive the gap
with `scripts/backfill-orders.mjs` and `scripts/backfill-attendees.mjs` per event (see
"Backfill" above): `--dry-run` first, then the real run.

Tested 2026-10-30 on a local D1 with both migrations applied (the statements run and the
check reads 0). Not yet run against a deployed D1.

## Out of scope (follow-ups)

* **Order ↔ registration link.** A ticket's Donations item still has no link to its Event
  Registrations item; the attendee feed keys on `Eventbrite Attendee ID`, orders on the order id.
* **Per-attendee gifts.** One order = one item; the buyer is the donor.
* **Partial refunds.** An order with some attendees refunded stays `placed`; it is written as
  `Received` with whatever `gross` Eventbrite now reports. Whether that `gross` reflects the
  refund is not stated in the blueprint — verify on the first real one, then decide whether to
  compute from `attendees[].costs`.
* **Historical orders** come over from Salesforce, not from here: `salesforce-import` migrates
  every eb4sf ticket gift (with its order id where Salesforce linked one, i.e. all of 2026). Don't
  point the backfill at older events — see "Adopt before create".
* **Multi-currency.** Not converted: a non-`currency` order is recorded `failed` for a human (see
  "Amount"), with its currency on the ledger row. SVBC's events are USD.

## Sandbox environment — inbound only, no outbound data

Same split as every migration Worker (`wrangler.jsonc` `env.sandbox`, `config/sandbox.json`
chosen by `ENVIRONMENT`, `src/environment.ts`): `npm run deploy:sandbox` deploys
`svbc-eventbrite-sync-sandbox` with its own D1 (`svbc-eventbrite-sync-sandbox`), queues
(`eventbrite-sync-writes-sandbox` / `-sandbox-dlq`), rate limiter and secrets
(`wrangler secret put … --env sandbox`). This Worker writes only to Monday, so there is no
outbound sink to lock; `config/split.test.ts` fails if the two configs share an id or
`env.sandbox` shares a resource with the top level. Design:
`../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`. Local development against
the sandbox is `npm run dev:sandbox`. The sandbox D1 now exists (created
2026-10-26; migrations 0001–0002 applied, `svbc-eventbrite-sync-sandbox` deployed). Production's
D1 `svbc-eventbrite-sync` was created 2026-11-02 and its id wired into `wrangler.jsonc` (c579d0d).

**Workers Builds:** connect `svbc-eventbrite-sync-sandbox` to this repo with root directory
`/eventbrite-sync` and deploy command `npx wrangler deploy --env sandbox`, as for the other
Workers; `.gitlab-ci.yml`'s `deploy-sandbox:eventbrite-sync` job is the gated fallback.

## Deploy

Both have been run: the sandbox on 2026-10-26 (D1 `svbc-eventbrite-sync-sandbox`), production on 2026-11-02 (D1 `svbc-eventbrite-sync`, queues `eventbrite-sync-writes` and `-dlq`), each with migrations 0001–0002. Production's attendee feed config was filled on 2026-11-03; only the order webhook is registered there so far. This is the order (sandbox first, `--env sandbox` on every command,
then production at cutover without it):

```sh
cd eventbrite-sync && npm install
npx wrangler d1 create svbc-eventbrite-sync-sandbox      # paste the id into wrangler.jsonc env.sandbox
npx wrangler queues create eventbrite-sync-writes-sandbox
npx wrangler queues create eventbrite-sync-writes-sandbox-dlq
npx wrangler d1 migrations apply svbc-eventbrite-sync-sandbox --remote --env sandbox
npx wrangler secret put EVENTBRITE_PRIVATE_TOKEN --env sandbox
npx wrangler secret put EVENTBRITE_WEBHOOK_SECRET --env sandbox
npm run deploy:sandbox
```

Then the prerequisite column's id (created by the sandbox load) in `config/sandbox.json`, redeploy, and register a
webhook on a sandbox-safe test event (Eventbrite allows several webhooks per organization).
**Verify** with a free order on that event (expect a `skipped` row, nothing on the board), a paid
order (expect the Donations item with every column in the table above and a Donor link),
a refund (expect `Refunded` — once the label exists), and a backfill run for the event (expect
no second item). Production repeats the list under the production names at cutover (see
`../docs/production-deploy-checklist.md`), then the Summit backfill.

### The write switch

Every Monday write and ledger update is gated by the shared write switch (spec
`../docs/superpowers/specs/2026-10-26-write-switch-design.md`, module `src/flags.ts`, a
byte-identical copy of `member-portal/src/flags.ts`), read from the `FLAGS` KV namespace
(`wrangler.jsonc`; the ids are placeholders until the namespaces exist):

- `eventbrite-sync:writes` — `on` writes normally; `hold` writes nothing and keeps messages queued
  (they retry); `off` writes nothing and logs one `"writeSwitch":"skipped"` line per would-be
  write. **A missing key means `off`**, and a KV read error means hold.
- `eventbrite-sync:log` — `debug` adds redacted payloads to those lines.

Set it with the operator CLI at the repo root, never by hand (`writes hold`/`on` also pauses and
resumes `eventbrite-sync-writes`):

```sh
node scripts/flags.mjs eventbrite-sync writes on --env sandbox     # or --env production
node scripts/flags.mjs status --env sandbox
```

**Set `writes on` before deploying** a build that carries the switch, or the deployed Worker
dry-runs everything. The webhook still records every delivery under any mode; one ingested while
`off` is stamped and is never written, even if the switch is `on` by the time it is consumed. The
dead-letter consumer is D1 bookkeeping and runs in every mode.

Orders, events and attendees share the one write queue and the same gate. What each mode does
beyond the table above:

- **Queue messages (order, event, attendee).** Under `off` (or a `dropped` stamp) the consumer runs
  the same fetch → map → match path against recording deps: each Donations, People, Events and
  Event Registrations write is a skip line, no ledger row changes, and the consumer's own sends
  (an event's attendee fan-out, one `sendBatch` per 100, an attendee's request for its event) are logged as `Write queue`
  skips, not sent. A message the consumer does send live carries its parent's stamp. A dry-run
  attendee whose event has a ledger row but no Events item yet (a dry run never records one) links
  the placeholder `dry-run-event` rather than retrying until its event is written.
- **The class email routes.** `claim`, `result` and `release` are refused with a 503 unless the mode
  is `on`, so under `off`, `hold` or an unreadable switch the send page can neither be handed
  recipients nor record a send, and no Monday write runs through a dry-run client there. `GET`
  still answers and reports `writesOn: false`, which the page shows as a notice.
- **The daily missed-order check.** Reads Eventbrite and the orders ledger and only logs, so it
  runs unchanged under `on` and `off`; under `hold` or an unreadable switch it is skipped with one
  `eventbrite-sync scheduled: write mode is …` line. Its 26-hour lookback does not reach back over a long hold, so after a
  multi-day `hold` compare the orders ledger against Eventbrite by hand (or run
  `scripts/backfill-orders.mjs --dry-run` per event) for the held days.
- No path re-enqueues "stuck" ledger rows automatically, so a row ingested under `off` is never
  resurrected later; re-driving stays the backfill scripts' job.

## Open

0. **Production class emails (attendee feed).** Production column ids; the `Attendee Email`
   Email-column conversion; `CLASS_EMAIL_SECRET` on both Workers and in the send page's Script
   Properties; the send page deployed and its URL in `classEmails.pageUrl`; register the attendee
   webhook; name an owner. A timed run of `result` on a 26-person roster in the sandbox (the CPU
   limit in `wrangler.jsonc`).
1. **The `Eventbrite Order ID` column id** in `config/sandbox.json` — the column arrives with the
   next sandbox load; see "Prerequisite column". Production has it (`text_mm8n459q`, 2026-11-02).
2. **The `Refunded` Status label** — shared with funraise-sync; still missing on sandbox v3.
3. **Eventbrite private token and organization id** — which staff account mints the token, and
   `eventbrite.organizationId` in config (optional but recommended; without it the missed-order
   check asks Eventbrite which organization the token belongs to).
4. **Partial-refund behaviour** — verify `costs.gross` on the first real one (Out of scope).

## Development

```sh
npm install
npm test            # vitest, including scripts/backfill-orders-lib.test.mjs
npm run typecheck   # wrangler types, then tsc --noEmit — the only supported typecheck
```

Type-check with `npm run typecheck`, never a bare `tsc --noEmit` (binding types come from the
generated, gitignored `worker-configuration.d.ts`). `src/monday/graphql.ts` is a byte-identical
copy of `monday-backup/src/monday/graphql.ts` checked by the `monday-graphql-copies` CI job —
edit the canonical file, not the copy. `node ../scripts/check-log-safety.mjs eventbrite-sync/src`
must stay clean: log order ids and item ids, never a buyer's email.

## Sources

* Eventbrite API v3 blueprint — Group Webhooks (Create Webhook, action list), Group Order (Order
  Fields, Order Costs Fields, Retrieve Order by ID, List Orders by Event ID), Currency Cost,
  Pagination, Authentication: <https://www.eventbrite.com/platform/new/docs/eventbrite-api-v3-public.apib>
* Eventbrite Webhooks guide: <https://www.eventbrite.com/platform/docs/webhooks>
* `../funraise-sync/README.md` — the shape this Worker copies (adopt before create, first-write
  stamps, the Pacific date rule, the dead-letter consumer, the URL-secret tradeoff)
* Private planning repo: issue #56 (2026-09-30 decision), `migration-plan.md` "Eventbrite"
