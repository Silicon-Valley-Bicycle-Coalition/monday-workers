# eventbrite-sync

**Staff UAT script:** [`docs/uat/eventbrite-sync.md`](../docs/uat/eventbrite-sync.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status:** Built (`feat/eventbrite-orders`, 2026-10-06; design:
[`docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md`](../docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md))
— **deployed: sandbox 2026-10-26, production 2026-11-02** (see "Deploy"). Production's order path
is filled from the live boards (Donations, People, `Eventbrite Order ID` `text_mm8n459q`; c579d0d),
with its own D1 and queues; its attendee feed is configured (2026-11-03) with the class emails sent from the send page (see
"Class emails"), and its webhook is registered (2026-11-03, id 15945672), with the 17 live upcoming events backfilled. The production order webhook was also registered that day (id 15945679): until then none pointed at this Worker, and the only orders in D1 were the 132 from the 2026-11-02 backfill. The 8 orders placed in that gap were all $0, so nothing needed replaying. The sandbox order path still can't write: `orderIdColumn` in
`config/sandbox.json` is `REPLACE_WITH_COLUMN_ID`. This README doesn't record whether the
`Refunded` Status label it shares with `funraise-sync` has been added to either board.
**Attendee feed and class emails:** built on `feat/eventbrite-attendees` (2026-10-26; design:
[`docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md`](../docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md);
see "Attendee feed and class emails" below). Live in production since 2026-11-03; the first real
class emails went out 2026-11-11. What's still open is under "Open".
**Priority:** Post-cutover (2026-10-23). Bike Summit 2026 (Oct 22) now sells out *before*
cutover, so `eb4sf` puts its orders in Salesforce and `salesforce-import` carries them over as
Event Ticket gifts with their order ids; this Worker takes every order after that, and the
backfill (below) covers the gap between the final extract and the webhook registration. Decision that it counts as giving: migration repo issue [GL#56](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-migration/-/issues/56) (2026-09-30).
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
retention purge. (The hourly cron runs the ended-event sweep, the daily missed-order check and the daily send-link sweep; none purges.) See `../README.md`'s Reliability section for why the Queue shape is
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
  early-exit-free byte compare, copied from funraise-sync [GL#25](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/25)). Callers that can set headers
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
* **Registering it** (production done 2026-11-03): Eventbrite → Account Settings → Developer Links → Webhooks
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
order as a Closed Won Opportunity, which the importer maps to Received / Event Ticket ([GL#43](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/43)), and
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
| `monday.boards["donations:live"]` | Donations (sandbox v3) | `18437342657` | the only write target |
| `monday.boards["people-live"]` | People (sandbox v3) | `18437342592` | People (Historical) is not a match target |
| `eventbriteSync.orderIdColumn` | Donations → **Eventbrite Order ID** (text) | **missing — prerequisite** | bare order id; the adopt-before-create key |
| `eventbriteSync.amountColumn` | Donations → Amount (numbers) | `numeric_mm8hn1b2` | `costs.gross.major_value` as a number — see "Amount" |
| `eventbriteSync.statusColumn` | Donations → Status (status) | `color_mm8hshet` | `placed → Received`, `refunded → Refunded` via `statusLabelMap`; **`Refunded` is not yet a label on the board** (funraise-sync's open item) |
| `eventbriteSync.dateColumn` | Donations → Date (date) | `date_mm8hfsvm` | the Pacific calendar day of the order's `created` |
| `eventbriteSync.thankYouSentColumn` | Donations → Thank You Sent (checkbox) | `boolean_mm8j82yw` | first write only; Eventbrite sends the buyer its own confirmation |
| `eventbriteSync.giftTypeColumn` / `giftTypeValue` | Donations → Gift Type (status; text before 2026-11-20) | `color_mm9arcwx` / `Event Ticket` | first write only; the label `donation-rollups`' membership rule excludes |
| `eventbriteSync.fiscalYearColumn` | Donations → Fiscal Year Ending (text) | `text_mm8hpk76` | first write only, derived from the same date as the Date column |
| `eventbriteSync.donorEmailColumn` | People → Personal Email (email) | `email_mm8h4kkb` | lookup by bare address; create writes `{ email, text }` |
| `eventbriteSync.donorFirstNameColumn` / `donorLastNameColumn` | People → First Name / Last Name (text) | `text_mm8sz56r` / `text_mm8s4jbf` | written from the order's `first_name` / `last_name` after creating a person, best effort; a failure leaves them blank and doesn't retry. Never written on a matched person |
| `eventbriteSync.donorLinkColumn` | Donations → Donor (connect) | `board_relation_mm8hhdk7` | `{ item_ids: [n] }` |

## Field mapping

| Eventbrite (Order object, `?expand=event`) | Donations | Rule |
|---|---|---|
| `id` | Eventbrite Order ID | bare string |
| `status` | Status | `statusLabelMap`; `placed` and `refunded` only. `started`, `pending`, `abandoned` and anything else are **not giving**: the row is marked `skipped` with the status named and nothing is written. A later delivery re-evaluates from scratch. |
| `costs.gross.major_value` | Amount | see "Amount" |
| `created` | Date, Fiscal Year Ending | `toISODate` → `America/Los_Angeles` calendar day ([GL#25](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/25) rule); FY = July–June year it ends in, first write only |
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
**Currency ([GL#76](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/76)).** The Amount column is in `currency` (`"USD"`). An order whose cost is in any
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
Eventbrite") and acked. Nor is any other failure no retry can fix ([GL#75](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/75), `src/errors.ts`): an
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
(`GET /organizations/{id}/orders/?status=active&changed_since=…`, then the same with
`status=inactive` for refunded orders; this endpoint rejects `all_not_deleted` and `both` with a
400, unlike the per-event one) and looks each id up in
the `orders` ledger. Orders changed in the last 30 minutes are skipped as possibly still in
flight. Any order Eventbrite has that the ledger doesn't gets one `console.error` naming the ids,
which Workers Issues raises; a clean check logs one info line. A day with no sales is not an alarm.
It replaces Salesforce's *Today's Eventbrite Orders Report* subscription, which emailed on every
day with no `eb4sf` orders (svbc-monday-migration [GL#90](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-migration/-/issues/90), `docs/35` §3.6).

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
**Owner and deadline (issue [GL#44](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/44)).** Run it on or after **2026-10-23**, once Summit sales have
closed, by David (the Worker's owner, decided 2026-10-09). Pre-flight, in order: the
`Eventbrite Order ID` column and `Refunded` label exist on production Donations; `config/svbc.json`
has no `REPLACE_WITH_COLUMN_ID` left, apart from `homeZipColumn` (see "Grant report") and `shiftTimeColumn`; the Worker is deployed and the webhook registered; then
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
issue [GL#62](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-migration/-/issues/62)). Eventbrite is the source of who registered and who checked in; Monday holds Attendance;
a coordinator sends the mail from Gmail through the send page. Design:
[`docs/superpowers/specs/2026-11-03-class-emails-from-monday-design.md`](../docs/superpowers/specs/2026-11-03-class-emails-from-monday-design.md).

**Any event, not only classes (2026-11-09).** Built for Bike Education, the send page now works for
every Eventbrite event: the Events item's **Send event email** link is written whatever the program
(it was Public only, labelled *Send class email*), refusals and Monday updates say "event", and a
volunteer event's emails go to its Volunteers (see "Who gets each email"). Internal names stay as
they were, because the deployed page and its secret use them: the `/class-emails` routes,
`X-Class-Email-Secret`, `CLASS_EMAIL_SECRET`, `attendeeSync.classEmails` and the
`class_email_recipients` table.

**Keeping the link current.** The Worker writes the link only when Eventbrite tells it about an
event, so an event nobody edits after a change (a new label, a redeployed page URL, an event
imported from Salesforce) kept a stale link or none: on 2026-11-19 only 7 of 242 events had the
current one and staff couldn't find the button. Now, on the missed-order check's hour, the
**send-link sweep** (`src/sendLinks/sweep.ts`) reads the whole Events board and rewrites every
Eventbrite event's link that is missing or differs, so a page URL change reaches every event within
a day. It skips items with no Eventbrite id, stops after three failures in a row, and has no cursor:
what it didn't write is still stale tomorrow. `scripts/backfill-send-links.mjs` does the same by
hand (`--dry-run` first; needs a `MONDAY_API_TOKEN` that reaches Events); both use
`src/sendLinks/plan.ts`.

```
Eventbrite (SaaS)
  │  second webhook: attendee.updated, attendee.checked_in, attendee.checked_out,
  │  barcode.checked_in, barcode.un_checked_in,
  │  event.created, event.published, event.updated, event.unpublished   (attendeeSync.actions)
  ▼
Worker   POST /webhooks/eventbrite/attendee   (same shared secret: X-Webhook-Secret or ?secret=)
  │  ledger rows in D1 (migration 0002_attendees.sql: `events` and `attendees`, ids and status
  │  only, no personal data), then the same queue → consumer fetches the attendee or event fresh
  ▼
Events board (one item per Eventbrite event, program from the organizer name)
Event Registrations board (one item per attendee: Attendance, First Name, Class Date/Day/Location, People link)
  ▲
Hourly cron  0 * * * *  → ended-event sweep re-queues events that have ended, for Event Status
Daily (check hour)      → send-link sweep rewrites missing or stale Send event email links on Events
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

**Attendee Phone** comes from the event's order form: the built-in Cell Phone or Work Phone field, or
else the first answered custom question whose wording mentions a phone (English or Spanish), skipping
questions about someone else, such as "Emergency contact phone". An event whose form doesn't ask stays
blank. It's a text column holding what the person typed, because Monday's
phone column refuses a value it can't parse, and that would fail the whole registration write.
Pledges don't get it: they go to their own board. `scripts/backfill-attendees.mjs` fills it for
people who registered before this column, one event at a time.

### Prerequisites

* Config `attendeeSync` ids for the Events and Event Registrations columns (including
  `events.sendLinkColumn` and `classEmails.pageUrl`), and `peopleEmailColumn`. Production has them
  since 2026-11-04, except `homeZipColumn` (see "Grant report") and `volunteers.shiftTimeColumn`, which stay off until set; the sandbox ships `REPLACE_WITH_COLUMN_ID` / `null` until set.
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

**Registrants on the event's card.** A registration also has a **Registrants link**, a second connect
to the same event whose reverse column, **Registrants**, lists the registrations on the event. The
Events board's **Item Card** opens by default and shows them in a Connected boards widget. It's a
separate column because Monday refuses to make the existing Event link two-way
(`cell_limit_exceeded`), most likely because of the 2,557 Pledge to Ride 2026 rows on that board. So:

* The Worker writes it after the registration, in its own call, and only logs if Monday refuses, so it
  can never fail a registration. A miss is retried on the attendee's next update.
* `attendeeSync.registrantsLinkExcludedEventIds` lists events too large for it. Tested up to 303
  registrations on one event; the real limit isn't known.
* Everything else that reads the event uses the Event column, as before.
* `scripts/backfill-registrants-link.mjs` fills it for older registrations. It needs a
  `MONDAY_API_TOKEN` that can reach the board, skips what's linked, and is safe to re-run.

In production the view and columns were created directly on the board on 2026-11-03 rather than
with `configure`, which would also have re-applied the board's five existing views.

### Grant report

Funders ask for name, email, class date, zip, checked in, canceled and no show, per person. Staff
pull that from a **Grant report** view on Event Registrations, filtered by Grant and date and
exported to Excel. Design:
[`docs/superpowers/specs/2026-11-04-eventbrite-grant-report-design.md`](../docs/superpowers/specs/2026-11-04-eventbrite-grant-report-design.md).
This feature reads only the zip answer. The Attendee Phone column and the Pledge to Ride board read
answers of their own (see their sections).

**What the Worker writes.** The consumer writes Home Zip with the rest of the registration when:

* the program is in `attendeeSync.zipPrograms` (`Public` and `Group Rides`). Program follows the
  Eventbrite organizer account, and the main account is `Public`, so a ticketed event there, like the
  Bike Summit, gets a zip if its form asks;
* `attendeeSync.registrations.homeZipColumn` isn't the placeholder, so a deploy can precede the column;
* a `text` question whose wording has the whole word `zip` or `zipcode`, or `código postal`, holds a value that matches
  `^\d{5}(-\d{4})?$` after trimming. The first valid answer wins, and only its first 5 digits are kept.

Anything else counts as no answer and its text is discarded. With no valid answer the column is left
out of the write, so a later bad edit can't erase a good zip. It also means a zip someone deletes in
Eventbrite stays in Monday. The zip goes in neither D1 nor the logs.

**Home County** (built 2026-11-24, off while `homeCountyColumn` is the placeholder). Written with Home Zip, from
`attendeeSync.zipCounty` on top of `pledge.zipCounty`: overrides first (94303 is `SMC or SCC`), then Pledge to Ride's two counties,
then `lists`. A zip on no list blanks it. `lists` is empty until staff approve the output of
`scripts/build-zip-counties.mjs --census <file>` (the Census **2010** ZCTA-to-county relationship file). Both configs must agree.

**Set up in Monday, with no Worker code:**

1. **Home Zip**, a text column on Event Registrations. Put its id in `homeZipColumn`, then run
   `scripts/mark-read-only-columns.mjs` to lock it.
2. **Grant**, a dropdown on Events, with labels VTA and SMCTA to begin with. Staff set it once per class.
3. A mirror of Grant on Event Registrations, through the Event link.
4. The **Grant report** table view with Name, Attendee Email, Event, Class Date, Home Zip, Attendance
   and Grant, every other column hidden. It is filtered to Grant is not empty, grouped by Grant, and
   sorted by Class Date newest first. Staff add a Class Date filter for the reporting period, then
   export. A dashboard is optional. The sandbox copy is view 291176794, created 2026-11-09. Build
   production's to the same settings.

**No Show** isn't automatic: staff or the class email page set it, so a class nobody marks counts no
no-shows. Eventbrite records check-ins, not absences, and a class with no check-ins may just be one
where nobody took attendance.

**Classes already written** get their zips from `scripts/backfill-attendees.mjs`, which re-drives each
attendee. The report runs from November 2026 forward; earlier data is already captured.

### Class totals on the tracker

Built 2026-11-24, not yet turned on (`attendeeSync.tracker` is `null` in both configs). Design:
[`docs/superpowers/specs/2026-11-04-event-counts-design.md`](../docs/superpowers/specs/2026-11-04-event-counts-design.md).

Staff run classes from the Bike Education Lifecycle Tracker (board 18433254640, not a CRM board). Once an hour
`src/tracker/sweep.ts` reads every row, the Events item in its **CRM Event** and that event's registrations, then writes:

* **Registered, Checked in and No-shows** on the row, once the event is Completed and somebody is Attended. A class with
  nobody checked in gets nothing: attendance probably wasn't taken. A cancellation counts only in Registered.
* **Grant** on the Events item, from the row's Funder (`grantByFunder`: VTA → VTA, SMC → SMCTA). From then on Grant isn't
  set by hand: a different value is overwritten while a tracker row with a mapped Funder links to the event.

A row gets nothing unless it isn't Cancelled, links to exactly one Eventbrite event that isn't a volunteer event, and its
Date is one of the event's days.

**Whose numbers.** D1 `tracker_counts` and `event_grants` (migration 0004) hold what the Worker last wrote. A row with any
number it didn't write is a person's, and all three cells are left alone, because the tracker's Canceled or Refunded formula mixes them.
Clearing that cell hands the row back. The Worker clears its own numbers when a row stops qualifying (unlinked, relinked, Cancelled), and
its own Grant when no row backs it. 30 days after its Date a row is frozen; Grant isn't. Archiving a finished row keeps its event's Grant; deleting a *mis-linked* row does too,
so unlink it first, or clear Grant by hand.

**What stops a mistake spreading.** A column missing from any read fails the run. A run that would clear more than five things clears
none and logs `held back N clears`: fix the links or Funder labels, or clear them by hand if they're meant. Each row is
read again just before its write. Never move `startDate` or `grantStartDate` later once live: rows before it stop qualifying and clear.

**When totals wait.** Any of the event's D1 `attendees` rows not `written` holds its totals (a `failed` one needs a person;
see "Failures and the dead-letter queue"). Date mismatches, double links, conflicting Funders and held events are warned about once
a day, at the check hour. Staff see a gap in the tracker's **Totals missing** view.

A mistaken check-in stays counted until staff change Attendance on Event Registrations.

### Registering it

Same dashboard route as the order webhook: Payload URL
`https://<worker-host>/webhooks/eventbrite/attendee?secret=<EVENTBRITE_WEBHOOK_SECRET>`, Event =
*All events*, Actions = the list in `attendeeSync.actions` in config. Sandbox keeps its own.

Eventbrite stores `attendee.checked_in` and `attendee.checked_out` as `barcode.checked_in` and
`barcode.un_checked_in` (production's webhook read back that way on 2026-11-03), and the Worker
ignores an action its config doesn't list, so the config lists both spellings. Production's first
check-ins (2026-11-08 to 11-14, four events) arrived as `barcode.checked_in` and were written; no
`attendee.checked_in` delivery has been seen.

### Event Status after the event ends

`mapEvent` writes **Completed** once the event's end (else its start) has passed, whatever Eventbrite
says: `live` and `started` mean Upcoming only until then. Salesforce's copy of `started` outlived 84
events (2026-11-02 org). Eventbrite itself read `completed` for all 211 past events on the board on
2026-11-03, but when it flips isn't documented, so a fetch near the end could otherwise write
Upcoming back over a corrected row. Canceled and Draft stay as they are.

A canceled event's status doesn't reliably say so, but its sales status does
(`?expand=event_sales_status`, `message_code: event_cancelled`). On 2026-11-03 SVBC's 7 canceled
events read `deleted`, `draft` and `completed`, all with that code, and none of the 226 others had
it; Eventbrite staff describe `live` too (developer forum, 2021). The consumer treats that code as `canceled`, on
the board and in the ledger, so the send page refuses every class email for it. It only learns this
when it fetches the event: on a delivery, or when the sweep below re-queues it after its end.

Whether Eventbrite sends `event.updated` when an event ends is unconfirmed: we found nothing in its
docs that says so, and no ledger has an event that ended with the webhook registered yet (production's
first ends 2026-11-09). So the hourly **ended-event sweep** (`src/endedEvents/sweep.ts`) re-queues each event
in the last 30 days that ended, was last seen `live` or `started`, is `written`, and whose
`written_at` is before its `ends_at`. The ordinary event consumer then fetches it and writes it, so a
class canceled or moved since is written as that, and failures get the usual retries and DLQ. The
consumer's write moves `written_at` past `ends_at`, which is the run-once guard; if a real delivery
does arrive at the end, it does the same and the sweep finds nothing to do.

It only sees this Worker's own ledger, with `ends_at` set: **an item `salesforce-import` loaded has no
row until a delivery for that event arrives**, so a future event imported at cutover that hears
nothing stays Upcoming. Run `scripts/backfill-attendees.mjs` for those events to give them rows (all 15
future events were in the production ledger by 2026-11-04). An
event older than 30 days (a longer `hold`, say) needs the same.

### Class email routes

All four need the header `X-Class-Email-Secret` (compared in constant time against
`CLASS_EMAIL_SECRET`); a missing, wrong or unset secret is a 401 before anything else runs, the
Monday client included. Responses carry names and addresses and are `Cache-Control: no-store`.

| Route | Does |
|---|---|
| `GET /class-emails/:eventId` | `{ event, fields, writesOn, kinds }`: `fields` holds the values the page can fill into a draft (`Class Day`, `Class Date`, `Start Time`, `End Time`, `Arrival Time` (5 minutes before the start), `Spanish Day`, `Spanish Date`, `Spanish Time`, `Spanish Arrival Time`, `Class Location`, and `Event Day`, `Event Date`, `Event Location` with the same values as their Class names), each null if unknown; for `reminder`, `thank-you` and `missed-you`, the refusal (if any), the recipients, how many were sent, how many are checked in (`checkedIn`), and the earlier recipients not yet resolved (`unresolved`, each with `status` `claimed` or `failed`). 404 when the event has no ledger row or Monday item, or the Events item is archived or deleted. Works under any write mode. |
| `POST .../claim` `{ kind }` | Re-plans from live Monday data, records the recipients in the ledger, and returns only those this call newly claimed. A second call returns none. 404 as for GET, including an archived or deleted Events item. 503 unless the write switch is `on`. |
| `POST .../result` `{ kind, sender, subject, results: [{ registrationId, status, error? }] }` | Marks claimed rows `sent` or `failed`; ids not claimed for this event and kind are ignored. This works under any write mode, because the emails have already gone. Only under `on`, one update on the Events item follows: kind, subject, sender, count, a `Failed:` line per failure and an `Unconfirmed:` line per recipient still claimed (an update is posted for those even when this call recorded nothing new). Then one `class-email` message per sent person goes to the write queue ([GL#96](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/96)), so the work is retried and is not cut off after the response: a timeline entry (when `timelineActivityId` is set), then for a missed-you Attendance to No Show if the row is still Registered (read fresh), and for a thank-you the People link when the Attendee link is blank. A step that exhausts its retries is only logged by the dead-letter consumer (it has no ledger row); if the messages cannot be queued at all, the Events item gets an update saying so. |
| `POST .../release` `{ kind, sender, registrationIds }` | Frees `failed` rows at any time, and `claimed` rows once they are at least 10 minutes old (never `sent`), so they can be claimed again. Returns `{ ok: true, released, tooRecent }`. Posts an update naming the sender and counting what was released, or nothing if nothing was. 503 unless `on`. |

* **Who gets each email:** the event's audience with an Attendee Email. For an event whose Events
  item's Program is one of `attendeeSync.volunteerPrograms`, the audience is its Volunteers-board
  items once that board is configured (see "Volunteers board"), and Role = Volunteer on Event
  Registrations before then; for every other event it is Role = Participant on Event
  Registrations.
  Reminder: Registered, refused once the event has started. Thank-you: Attended, refused until the
  event has ended or when no one in the audience with an Attendee Email is Attended (someone outside
  it, such as a volunteer at a class, or a blank-email row doesn't count).
  Missed-you: Registered or No Show, same refusals. Canceled never. Only an Eventbrite status of
  `live`, `started`, `ended` or `completed` may send; anything else, including `draft`, `canceled`,
  `deleted` and no status, is refused for every kind. One email per address per kind, first
  registration wins; a missed-you skips an address that attended on another eligible registration.
* **At most once.** A recipient is recorded (claimed) before the page may send to them, and a
  claimed recipient is never handed out again. A crash leaves them `claimed`, shown as unconfirmed;
  only a person releases them, and not until 10 minutes after the claim (`RELEASE_MIN_CLAIM_AGE_MS`),
  because Apps Script runs stop at about 6 and a younger claim may still be sending.
* **Each sent email goes on the person's timeline.** Monday's own logging doesn't pick up mail sent as
  a Google Group (tested 2026-11-04), so after a send `result` posts a `Logged email` custom activity
  (`classEmails.timelineActivityId`, null to turn it off) on the person's People item when the address
  matches, otherwise on their Event Registrations item. It never creates a person. The entry has the
  subject with its placeholders filled in, the kind, the class and the sender, not the body. It doesn't
  count as contact in `people-reclassification` or reach Activities (Logged). A failed entry isn't
  retried, because an entry can't be looked up to dedupe; an update on the Events item lists it.
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

### Volunteers board

Sign-ups on an event whose Program is in `attendeeSync.volunteerPrograms` (`Volunteering`) are
written to the Volunteers board (`monday.boards.volunteers`), not Event Registrations:
`src/consumer/processVolunteer.ts`, one item per Eventbrite attendee. Columns, under
`attendeeSync.volunteers`: **Event** (a relation to Events, staff-editable; defaults to the
listing's own Events item on create and is never written again), **Eventbrite Listing**,
**Eventbrite Attendee ID**, **Attendee Name**, **Attendee Email**, **Shift** (the
attendee's `ticket_class_name`, e.g. "Shift 2"; `ticketTypeColumn`, optional: the placeholder
writes nothing), **Phone Number** (same rules as Attendee Phone on Event Registrations; `attendeePhoneColumn`,
optional too), **Shift Time** (`shiftTimeColumn`, optional too; see below), plus the existing Job, Date, Status, Historical and Volunteer (People) link.
Status maps Registered to RSVP, Attended to Completed and Canceled (canceled or refunded in
Eventbrite) to Canceled; staff No-Show, Prospect and Confirmed are kept. A canceled row is kept,
never deleted, so a count of people must leave out Canceled and count attendee ids, not emails:
one order can hold two shifts, or several people under the buyer's email ([GL#115](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/115)).
`donation-rollups` counts only Completed. Class emails
for these events read the Volunteers board and write No-Show and the People link back there.
The board's "Recent events" view (last 90 days, newest first, ungrouped: Monday orders
relation groups its own way, ignoring the sort) is made by
`scripts/setup-volunteers-board.mjs --board <id> --events-board <id> --people-boards <id>,<id> [--apply]`,
which also creates the missing columns and prints their ids for the config; `scripts/backfill-volunteers.mjs`
moves earlier Role = Volunteer registrations over (`--apply`, `--remap-out`, `--archive`,
`--env sandbox`, `--limit`, `--pause-ms`; dry run by default). `donation-rollups` counts the
board as history. The Event column is a two-way connection (turned on in the column settings
UI; the API can't): the Events board's **Volunteers** column is its other side, kept by Monday, and
that board's **Volunteer events** view (Volunteers not empty, Date newest first) is where staff
click an event to see who signed up. Production and sandbox v4 have both since 2026-11-17.
An event shows on the Volunteers board only once it has a sign-up, so production's Events board also
has an **Upcoming volunteer events** view (Program = Volunteering and Event Status = Upcoming, soonest
first; made by hand 2026-11-24), which lists those still with none.

**Upcoming by event** (same script) is the contact sheet staff email from before an event: Date or
Event Date today or later, Canceled hidden, one section per event with each person's shift, email, phone and the
event's shift lead. Its heading, **Event and Date**, is a Monday formula over the linked event's name
and date (`2026-11-28 · Cardinals vs Mustangs…`), so a renamed event or a re-pointed Event changes
the heading with nothing to sync; a row with no Event goes under "No event linked". It starts with the date
because Monday sorts formula and text groups only A to Z (2026-11-24). **Shift Lead** is a one-way
link on Events to either People board, because the lead usually isn't a sign-up; Volunteers shows it
and **Shift Lead Email** (the lead's Personal Email) through mirrors. **Send event email** mirrors the Events
link through **Eventbrite Listing**, not Event: the send page emails the volunteers of the listing, while a
re-pointed Event is the attendee event, whose page emails its participants. The script skips that mirror where Events has
no such link (the sandbox). Production has it since 2026-11-24 (`lookup_mm9dn1bn`), after Name in Upcoming by event and Recent events. Either date keeps a row because Date is the listing's: it
doesn't follow the event staff re-pointed the row to. Production has the columns and the view since
2026-11-24; `scripts/backfill-attendees.mjs` fills Phone Number on sign-ups from before it. Shift and Phone Number were Ticket Type and Attendee Phone
until staff renamed them on 2026-11-24 (config keys keep the old words); the setup script matches by title, so a
rename in Monday needs one there too. Design:
[`docs/superpowers/specs/2026-11-24-upcoming-volunteers-by-event-design.md`](../docs/superpowers/specs/2026-11-24-upcoming-volunteers-by-event-design.md).

**Shift Time** (sandbox since 2026-11-24; not set up in production, where `shiftTimeColumn` is the placeholder) is when the row's own listing runs, in Pacific time ("8:00 AM–12:00 PM"; `src/mapping/shiftTime.ts`),
whatever Event staff point the row at. Bike Parking lists each shift of an event as its own listing with the
same name and date, which the by-event views show as one section, so this is what tells the shifts apart
([#5](https://github.com/Silicon-Valley-Bicycle-Coalition/monday-workers/issues/5)). It is text, so `12:00 PM` sorts before
`8:00 AM`. A time changed in Eventbrite reaches a row on that attendee's next delivery; `scripts/backfill-attendees.mjs`
fills older rows. The setup script doesn't edit an existing view: add the column by hand. Design:
[`docs/superpowers/specs/2026-11-24-volunteer-shift-time-design.md`](../docs/superpowers/specs/2026-11-24-volunteer-shift-time-design.md).

**Completed by event** is production's first tab, the same layout for past events: Completed with an Event,
newest first. It was Completed hours until 2026-11-24, changed by hand on that board only; the setup script
doesn't make it, and `salesforce-import`'s configure spec still names the old view.

Cutover order, rollback and open gaps:
[`docs/runbooks/volunteers-board-cutover.md`](../docs/runbooks/volunteers-board-cutover.md).

**Config is the switch** (`volunteerBoardMode`, `src/config.ts`). The five new column ids
(`eventColumn`, `listingColumn`, `attendeeIdColumn`, `attendeeNameColumn`, `attendeeEmailColumn`)
decide which path runs. While all five are `REPLACE_WITH_COLUMN_ID` (production until the
runbook's step 2), the Worker behaves exactly as before the Volunteers board feed: volunteer
sign-ups are Event Registrations rows with Role = Volunteer, and their class emails read and write
Event Registrations. So a deploy from `main` before the cutover changes nothing. Once all five are
real and `monday.boards.volunteers` is set, the next deploy switches to the Volunteers board. A
half-filled set (some real, some placeholder, or real columns with a null board) fails config
validation loudly, in `npm test` and at load; it never falls back to writing registrations.

### Backfill

`scripts/backfill-attendees.mjs` replays an event's attendees to the deployed Worker, as the order
backfill does: flags `--event-id`, `--worker-url`, `--env`, `--pause-ms`, `--dry-run`. Use it for a
class that predates the webhook. Nothing is emailed automatically: a backfill only fills the boards,
and mail goes out when a coordinator uses the send page, which hands out only people no one has been
sent to for that kind.

## Pledge to Ride

Pledge to Ride is a free Eventbrite event for Bike to Wherever Days, with about 3,000 pledges a year.
Design: [`docs/superpowers/specs/2026-11-05-pledge-to-ride-board-design.md`](../docs/superpowers/specs/2026-11-05-pledge-to-ride-board-design.md).
**Status:** live in both environments. Production's board is 18439165954 (created 2026-11-09, private,
backed up); `pledge.events` holds 2026 (1977741403778) and 2025 (1119156359799), both backfilled
2026-11-20 (IT Requests item 13527993339). 2027 (2004835226130, a draft due to publish 2027-01-15) is configured
ahead of publishing; its draft has no employer question yet (step 4 below), and its "I see myself as" and
"Please describe" text questions go to Other Answers. The board matches Eventbrite: 2026 has 2,906 Pledged (352
`Buyer only`) and 5 Canceled; 2025 has 3,272 Pledged (340 `Buyer only`) and 15 Canceled. The dashboard is
**Pledge to Ride** (40597968, `/overviews/40597968`), a workspace dashboard whose charts split by Year; its
first chart has the exact Pledged totals, the others include the few Canceled rows, since Monday's API
ignores per-widget filters. The notes a text widget would hold are in the board's description. 2025's rider-type and flyer labels are mapped onto 2026's
wording so the years compare; its Days Pledged buckets (`1 day`, `2-7 days`, `> 7 days`) don't map onto
2026's and stay as asked. Its age, ethnicity and gender questions are in `ignoreQuestions`; "I usually
bike", "I like to ride" and "first time at BTWD" go to Other Answers. 2025 has no consent question. The sandbox board is 18439574443, rehearsed 2026-11-09 with three
real 2026 attendees (complete, placeholder, canceled). The 2027 pledge is due to publish 2027-01-15.

An attendee of an event in `pledge.events` goes to the private **Pledge to Ride** board **instead of**
Event Registrations, with its answers. Everything before that (webhook, ledger, queue, write switch) is
the same. The 2,557 Event Registrations rows linked to the 2026 event
stay where they are; they leave out the placeholders described next, so 2,906 is the figure to quote.

**Placeholders.** Eventbrite returns the literal text `Info Requested` for the name and email of some
attendees, with no answers (352 of 2026's 2,906). Their order has a real buyer, so the consumer fetches
it, writes that name and address, and sets Details to `Buyer only`, County to `Unknown` and consent
blank. They count as pledges, as they always have in the MTC report. On every other event the text is
treated as blank.

**County.** From the zip answer and `pledge.zipCounty`: on neither list is `Outside`, blank or malformed
is `Unknown`. Past reports counted `Unknown` as Outside. 94303 straddles both counties and counts as San Mateo.

**Labels.** Writes to this board create a missing label, so a new year's choice appears by itself. Only
an answer of Eventbrite's `multiple_choice` type or one with a label in config can do that. Typed text
goes to Other Answers.

**Nothing from a pledge reaches the logs:** a debug skip line under the write switch leaves its values
out, since the key-based redaction can't recognize free text under a column id.

### A new year's pledge

**For staff, in short:** create next year's Pledge to Ride on Eventbrite as a **draft**, then ask whoever
runs these Workers to configure and deploy it **before you publish**. Publishing first sends the early
pledges, with their answers and phones, to Event Registrations, which all staff can read.

1. Staff create the event as a **draft** on Eventbrite, with its questions.
2. `node scripts/pledge-event-config.mjs --event-id <id> --year <n>` prints its `pledge.events` block and
   what to review. Paste it into `config/svbc.json`, and **deploy before the event is published**.
3. Update the dashboard's Year filter.
4. Add the employer question to the draft: "Where do you work? (Many employers match donations and
   volunteer time.)" Step 2's script maps it to `employer` (the answer still lands in Other Answers; see
   "Employer answers"). Until a build with `employer` deploys, mark it `ignoreQuestions` instead.
5. After publishing, make one test pledge, see the item appear, cancel it, and see it read `Canceled`.
   Whether a cancellation sends `attendee.updated` hasn't been observed. If it doesn't, re-run the backfill
   before reading report figures.

**If step 2 gets missed,** the pledges go to Event Registrations, and `processEvent` logs an error for
any event whose name contains `pledge.nameMatch` and isn't configured. To recover, in order: add the
config and deploy; clear that event's ledger ids, since a stored id points at Event Registrations
(`update attendees set monday_item_id = null where event_id = '<id>'`); replay with
`scripts/backfill-attendees.mjs`; delete the stray rows by hand.

### Daily count check

On the missed-order check's hour, `src/pledgeCounts/check.ts` compares Eventbrite's attendee total with the
`attendees` ledger for each configured event, up to 30 days after it ends, and logs an error on a difference
(canceled attendees are in both). A small difference may be a pledge still in flight. Otherwise, check the
webhook, then replay. It finds an event's end date from its `events` row, which `backfill-attendees.mjs`
creates, so a newly configured past event raises this daily until it's been replayed.

### Setting it up

`scripts/setup-pledge-board.mjs` creates the board, private, and prints its config (dry run without
`--apply`; `--subscribe` the integration user and `monday-backup`'s, or neither can see it). Add the board to
`requiredBoardIds` in `monday-backup/config/backup.json`, and run `scripts/mark-read-only-columns.mjs`.
Monday puts a default "Task 1" item on a new board; delete it. Status columns are written as
`{ label }`: a bare `"2026"` is read as a label index and the whole write refused (found in the sandbox).

**Don't create a test event to rehearse.** There's one Eventbrite organization and production's webhook
covers all of it, so a test event writes to production boards. Replay a slice of a real past event to the
sandbox with `backfill-attendees.mjs --env sandbox` instead, and delete the sandbox board's data afterward.

**Backfill pace:** each attendee costs one Eventbrite read, plus one for a placeholder, and Eventbrite
publishes a limit of 2,000 calls an hour that the Worker's other traffic shares. Confirm it, and use
`--pause-ms 2000` or slower. Check the ledger first: the same `monday_item_id` problem as the recovery above
applies to any configured event that already has rows.

## Employer answers

An attendee who answers an employer question ("Where do you work?") has the answer handed to
`impact-attribution`, which proposes a **Draft** Affiliation for staff to confirm in **Drafts to
confirm**. This Worker only collects: it never writes to Affiliations. Design:
[`docs/superpowers/specs/2026-11-17-eventbrite-employer-answers-design.md`](../docs/superpowers/specs/2026-11-17-eventbrite-employer-answers-design.md)
(issue [GL#127](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/127)); the proposing side is in `../impact-attribution/README.md`.

**Which answers.** A pledge event with a question mapped to `employer` in `pledge.events` uses that
question (the config script maps wording like "Where do you work?" or "employer"). Otherwise, for any
event, the first answered `text` question worded like `EMPLOYER_QUESTION` in `src/mapping/employer.ts`
(employer, where do you work, company you work, a question worded just "Company" as on the Bike to the Future forms, and Spanish equivalents), skipping a pledge event's
`ignoreQuestions` (staff list a question there to mean "don't read it"); no per-event config. "Company
name for invoice" does not match. A pledge's employer answer still goes to **Other Answers** as before; no new column.

**Who.** Only the attendee's own email counts (not a placeholder `Info Requested`). It's looked up on
People's email column with `findItemByColumnValue`, never `matchPerson`, so a miss creates nothing:
no People match, nothing recorded. The lookup is one extra People read per answered attendee. Canceled
and refunded attendees aren't recorded; a no-show is.

**Hand-over.** `src/consumer/employerAnswer.ts` calls `recordEmployerAnswer` on the `EMPLOYER_ANSWERS`
service binding (entrypoint `EmployerAnswers`) after the board write and before the ledger row is
marked `written`. A `{ recorded: false, reason }` result is logged (ids and reason only) and the
message carries on. A transient failure throws, so the message retries, adopts its existing board
item and repeats the call. A refusal never dead-letters a pledge or registration, but a persistent
`impact-attribution` failure (migration not applied, entrypoint not deployed, config that throws) does:
the message retries for about four days and then dead-letters, after its board item already exists, so
no board data is lost, only the answer. The answer and the context are each trimmed to 200 characters, `answeredAt` is the attendee's created date, and
`context` is the event name (`Pledge to Ride <year>` for a pledge). The answer text, the context and the email
are never logged.

**Switches.**

* `employerAnswers.enabled` in `config/*.json` is **`true` in both** `svbc.json` and `sandbox.json`
  (2026-11-17, after the pre-enable checklist passed in each). Set it to `false` to switch the hand-over off.
* The binding is optional: a missing binding behaves exactly like `enabled: false`. Production binds
  `svbc-impact-attribution` and sandbox binds `svbc-impact-attribution-sandbox`; `config/split.test.ts`
  checks each. `vitest.config.ts` stands in for the binding, as it does for `MONDAY_AUTH`.
* Under the write switch, `off` and `hold` follow the consumer's existing disposition: only `on`
  records. Under `off` the dry-run sink (`dryRunEmployerAnswers` in `src/writeSwitch.ts`) logs ids
  only (source, attendee id, People item id), sends nothing, and the People lookup, being a read, still happens.

**Pre-enable checklist.** Before setting `eventbrite-sync`'s `employerAnswers.enabled` to `true` in
an environment, confirm in that same environment:

- [ ] migration `0003_employer_answers.sql` is applied to `impact-attribution`'s D1;
- [ ] `impact-attribution` is deployed with the `EmployerAnswers` entrypoint (a build from [GL#127](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/127) or later);
- [ ] `impact-attribution`'s `config/*.json` has an `employerAnswers` block (and loads: a config that
  fails validation makes every call throw).

A missing migration, entrypoint or loadable config makes every call throw: each answered attendee's
message retries for about four days and then dead-letters, after its board item already exists. A
missing `employerAnswers` block is refused as `disabled`, so nothing is recorded.

**Operator steps.** In order, sandbox first:

1. `impact-attribution`: apply migration `0003_employer_answers.sql`
   (`npx wrangler d1 migrations apply svbc-impact-attribution-sandbox --remote --env sandbox`; production
   at its rollout) and deploy it (`npm run deploy:sandbox`) **before** deploying this Worker's sandbox, so the
   binding resolves.
2. Run the pre-enable checklist above for sandbox, then set `employerAnswers.enabled` to `true` in `config/sandbox.json`, deploy `eventbrite-sync` sandbox,
   and replay one past event: `node scripts/backfill-attendees.mjs --env sandbox --event-id <id> --worker-url …`.
3. Production: see the three rollout steps in `../impact-attribution/README.md` ("Rollout of employer answers").

A backfill records answers given before the switch was on, or by an attendee who joined People later;
a normal webhook delivery doesn't revisit those. For backfill pacing, each answered attendee adds one
People read to the costs in "Backfill pace" under Pledge to Ride, so keep the `--pause-ms` advice there.

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
Workers; `.github/workflows/workers.yml`'s `deploy-sandbox` job is the gated fallback.

## Deploy

Both have been run: the sandbox on 2026-10-26 (D1 `svbc-eventbrite-sync-sandbox`), production on 2026-11-02 (D1 `svbc-eventbrite-sync`, queues `eventbrite-sync-writes` and `-dlq`), each with migrations 0001–0002 (production has 0003, the class email ledger, too). Production's attendee feed config was filled on 2026-11-03, and both webhooks were registered that day (see the top of this README). This is the order (sandbox first, `--env sandbox` on every command,
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
(`wrangler.jsonc` binds both namespace ids, `FLAGS` and `sandbox-FLAGS`):

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
- **The hourly ended-event sweep** (`sweepEndedEvents`). `on` re-queues each event through the
  consumer. `off` changes nothing: each would-be send is a `Write queue` skip line and the ledger is
  untouched, so an ended event is logged again every hour until it ages out of the 30-day window,
  and any still inside it are re-queued on the first `on` run. Only a correction to an event that
  has already ended, so unlike a poller's cursor nothing is skipped for good. `hold` or an unreadable
  switch skips the run with one `eventbrite-sync scheduled: write mode is …` line, and the first `on` run walks what it missed.
- **The daily send-link sweep** (`sweepSendLinks`). `on` writes; `off` reads the board and logs how
  many links are stale, writing none; `hold` or an unreadable switch skips it with the other jobs.
  It recomputes from the board each day, so nothing is skipped for good.
- **The hourly tracker sweep** (`sweepTracker`). `on` writes; `off` reads and logs how many Grants and rows
  it would write or clear, and changes neither Monday nor D1; `hold` or an unreadable switch skips it. It recomputes
  from the boards each hour, but a row frozen (30 days old) by the time writes come back on stays as it was.
- **The daily missed-order check.** Reads Eventbrite and the orders ledger and only logs, so it
  runs unchanged under `on` and `off`; under `hold` or an unreadable switch it is skipped with one
  `eventbrite-sync scheduled: write mode is …` line. Its 26-hour lookback does not reach back over a long hold, so after a
  multi-day `hold` compare the orders ledger against Eventbrite by hand (or run
  `scripts/backfill-orders.mjs --dry-run` per event) for the held days.
- No path re-enqueues "stuck" ledger rows automatically, so a row ingested under `off` is never
  resurrected later; re-driving stays the backfill scripts' job. The ended-event sweep is no
  exception: it takes only `written` rows, and a row an `off` delivery left `queued` isn't one.

## Open

0. **Production event emails.** Configured 2026-11-04: the `🔒 Send event email` column on Events
   (`link_mm8sk30a`), and the send page deployed as the Apps Script project "SVBC Event Emails" (named "SVBC Class Emails" until 2026-11-24). Its
   `CLASS_EMAIL_SECRET` is on this Worker and in the page's Script Properties. Owner: Kendra Toy.
   First real sends (checked 2026-11-17): Kendra's reminder on 2026-11-11 (6 people) and, on 2026-11-14,
   a thank-you (7) and a second class's reminder (9), with timeline entries on the recipients' items; check-ins have
   arrived since 2026-11-08. Still open: a first missed-you, and a timed run of `result` on a 26-person
   roster (the CPU limit in `wrangler.jsonc`). The 2026-11-09 generic change is deployed (the 2026-11-14
   updates read "Event email"). On 2026-11-19 `scripts/backfill-send-links.mjs` wrote the link on 235
   events, and the daily send-link sweep keeps it current from then on. On 2026-11-24, because staff
   still couldn't find it (the link was set but not shown on the Event Card, and off-screen in the
   table views), the column was renamed `🔒 Send event email`, added to the Event Card after Name, and
   moved next to Date in the Upcoming, All events and Volunteer events views. Monday doesn't add a new
   column to an existing card: edit the card's Event widget and check it. The page's matching wording
   is live (version 4, 2026-11-19).
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
* Private planning repo: issue [GL#56](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-migration/-/issues/56) (2026-09-30 decision), `migration-plan.md` "Eventbrite"
