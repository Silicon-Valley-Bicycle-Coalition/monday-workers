# eventbrite-sync

**Staff UAT script:** [`docs/uat/eventbrite-sync.md`](../docs/uat/eventbrite-sync.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status:** Built (`feat/eventbrite-orders`, 2026-10-06; design:
[`docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md`](../docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md))
— **not deployed anywhere yet.** Blocked on prerequisites nobody has done: the `Eventbrite Order
ID` column on Donations (see "Prerequisite column"), an Eventbrite private token, D1 and queue
provisioning, the three secrets, and the webhook registration. The `Refunded` Status label it
shares with `funraise-sync` is also still missing from the board.
**Priority:** Post-cutover, **time-boxed by Bike Summit 2026 (Oct 22)** — ticket sales run
through the Oct 9–11 cutover, and the one-off backfill (below) is what puts that revenue on the
Donations board. Decision that it counts as giving: migration repo issue #56 (2026-09-30).
**Owner:** Unassigned.
**Stack:** Hono + TypeScript + D1 + Cloudflare Queues (the shared stack, see `../README.md`).

## The ask

SVBC's events sell tickets on Eventbrite. Today the `eb4sf` package writes each order and
attendee into Salesforce, where paid tickets have never been treated as gifts. On 2026-09-30 the
migration decided they are: **after cutover, every paid Eventbrite order becomes a Donations item
with Status `Received` and Gift Type `Event Ticket`** — the same labels `funraise-sync` writes for
a paid Funraise ticket — linked to the buyer on People by email. Nothing does this today, and
`eb4sf` retires with Salesforce. This Worker is the replacement.

What it is not: an attendee or registration feed. One order is one gift, however many tickets it
holds, and the Event Registrations board is a separate, documented follow-up (see "Out of
scope"). `svbc-calendars`, the other Eventbrite consumer in this repo, reads the public event
feed for the website and never sees orders.

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
  │  failure → retry with backoff (1, 4, 16 min) → dead-letter consumer marks the row and logs
  ▼
Donations board (+ Donor link to People; ids in config/sandbox.json, svbc.json for production)
```

**The delivery is a trigger, never a source.** Eventbrite's webhook carries only a pointer, so the
consumer fetches the order at processing time. That is why out-of-order deliveries don't matter
(whatever Eventbrite says now is what gets written), why a redelivery is enqueued rather than
deduped (one extra fetch, an idempotent write, never a second item), and why the D1 ledger holds
**no name, email or payload** — nothing personal at rest, so unlike `funraise-sync` there is no
retention purge and no cron. See `../README.md`'s Reliability section for why the Queue shape is
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
* **Monday.com GraphQL API** — standard token, same pattern as every other Worker here; the
  sandbox reuses the shared `Sandbox Integration` user, production gets a dedicated integration
  user (root README "Least-privilege Monday tokens"; run
  `node ../scripts/check-monday-token-scope.mjs` before calling it scoped).

## Prerequisite column: `Eventbrite Order ID`

The idempotency key is the Eventbrite order id, stored in a **text** column titled
**`Eventbrite Order ID`** on the Donations board, config `eventbriteSync.orderIdColumn`. **It does
not exist yet** on Donations (sandbox v3) or on the production board (2026-10-06). Someone with
write access adds it, either in the UI (board → `+` → Text → title exactly `Eventbrite Order ID`)
or by adding `{ title: 'Eventbrite Order ID', type: 'text' }` to the `donations` entry's
`columns` in `salesforce-import/src/configure/spec.ts` and running
`npm run cli -- configure --only donations` there (idempotent), then puts the new column's id in
`config/sandbox.json` (and `config/svbc.json` at cutover) and tightens `config/split.test.ts`
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

`salesforce-import` migrates **no Eventbrite order as a Donations item** (the decision postdates
its transform; it carries Eventbrite attendees onto Event Registrations only), so there is
nothing on the board for this Worker to collide with at cutover.

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
backoff — 1, 4, then 16 minutes (`retryDelaySeconds`, copied from funraise-sync). After
`max_retries` (3) the message goes to `eventbrite-sync-writes-dlq` (`…-sandbox-dlq` in the
sandbox), which this Worker also consumes (`src/consumer/processDeadLetters.ts`): the row's
error is prefixed `dead-lettered after retries: ` and the batch logs one `console.error` naming
the order ids. A 404 from Eventbrite is **not** retried: the row is marked `failed` ("not found in
Eventbrite") and acked. To find dead orders:
`select order_id, event_id, error, received_at from orders where error like 'dead-lettered%'`.
Re-drive by re-running `scripts/backfill-orders.mjs` for the affected event once the cause is
fixed; adopt-before-create makes it safe for the orders that did land.

## Backfill: the Oct 22 Summit, and any later gap

```sh
cd eventbrite-sync
EVENTBRITE_PRIVATE_TOKEN=… node scripts/backfill-orders.mjs --event-id <id> --dry-run
EVENTBRITE_PRIVATE_TOKEN=… EVENTBRITE_WEBHOOK_SECRET=… node scripts/backfill-orders.mjs \
  --event-id <id> --worker-url https://svbc-eventbrite-sync.<subdomain>.workers.dev [--changed-since 2026-10-09T00:00:00Z]
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
the column in place (Sequencing, below), run it once with the Summit's event id — the event id is
in the manage-page URL (`…/myevent?eid=<id>`) or from `GET /v3/organizations/{org}/events/`. Do
the same for any other event that sold tickets between cutover and the webhook registration.
An order refunded before the Worker ever saw it has no item to reverse, so it is recorded as `skipped` and nothing is written; one with an item is updated to `Refunded`. The consumer runs one
message at a time, so a few hundred orders take a few minutes; then check the board and
`select status, count(*) from orders where event_id = '<id>' group by status`.

## Out of scope (follow-ups)

* **Event Registrations linkage.** The plan assigns Event Registrations to an Eventbrite-fed
  Worker that upserts attendees by `Eventbrite Attendee ID` (which `salesforce-import` already
  stamps). That is the `attendees` expansion, the `attendee.*` actions and a second board — its
  own design. This Worker keeps `event_id` on the ledger row as the hook; until then a ticket's
  Donations item has no link to its registration.
* **Per-attendee gifts.** One order = one item; the buyer is the donor.
* **Partial refunds.** An order with some attendees refunded stays `placed`; it is written as
  `Received` with whatever `gross` Eventbrite now reports. Whether that `gross` reflects the
  refund is not stated in the blueprint — verify on the first real one, then decide whether to
  compute from `attendees[].costs`.
* **Historical orders** (before cutover) are not migrated as Donations. The backfill script can
  walk older events one id at a time if staff want them.
* **Multi-currency.** `currency` is stored, not converted; SVBC's events are USD.

## Sandbox environment — inbound only, no outbound data

Same split as every migration Worker (`wrangler.jsonc` `env.sandbox`, `config/sandbox.json`
chosen by `ENVIRONMENT`, `src/environment.ts`): `npm run deploy:sandbox` deploys
`svbc-eventbrite-sync-sandbox` with its own D1 (`svbc-eventbrite-sync-sandbox`), queues
(`eventbrite-sync-writes-sandbox` / `-sandbox-dlq`), rate limiter and secrets
(`wrangler secret put … --env sandbox`). This Worker writes only to Monday, so there is no
outbound sink to lock; `config/split.test.ts` fails if the two configs share an id or
`env.sandbox` shares a resource with the top level. Design:
`../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`. Local development against
the sandbox is `npm run dev:sandbox`. **Neither environment is provisioned**: both `database_id`
values in `wrangler.jsonc` are placeholders until `wrangler d1 create` runs.

**Workers Builds:** connect `svbc-eventbrite-sync-sandbox` to this repo with root directory
`/eventbrite-sync` and deploy command `npx wrangler deploy --env sandbox`, as for the other
Workers; `.gitlab-ci.yml`'s `deploy-sandbox:eventbrite-sync` job is the gated fallback.

## Deploy

Nothing has been run yet; this is the order (sandbox first, `--env sandbox` on every command,
then production at cutover without it):

```sh
cd eventbrite-sync && npm install
npx wrangler d1 create svbc-eventbrite-sync-sandbox      # paste the id into wrangler.jsonc env.sandbox
npx wrangler queues create eventbrite-sync-writes-sandbox
npx wrangler queues create eventbrite-sync-writes-sandbox-dlq
npx wrangler d1 migrations apply svbc-eventbrite-sync-sandbox --remote --env sandbox
npx wrangler secret put MONDAY_API_TOKEN --env sandbox
npx wrangler secret put EVENTBRITE_PRIVATE_TOKEN --env sandbox
npx wrangler secret put EVENTBRITE_WEBHOOK_SECRET --env sandbox
npm run deploy:sandbox
```

Then the prerequisite column and its id in `config/sandbox.json`, redeploy, and register a
webhook on a sandbox-safe test event (Eventbrite allows several webhooks per organization).
**Verify** with a free order on that event (expect a `skipped` row, nothing on the board), a paid
order (expect the Donations item with every column in the table above and a Donor link),
a refund (expect `Refunded` — once the label exists), and a backfill run for the event (expect
no second item). Production repeats the list under the production names at cutover (see
`../docs/production-deploy-checklist.md`), then the Summit backfill.

## Open

1. **The `Eventbrite Order ID` column** on Donations (sandbox v3 and production) — see
   "Prerequisite column". Nothing can be written until it exists.
2. **The `Refunded` Status label** — shared with funraise-sync; still missing on sandbox v3.
3. **Eventbrite private token and organization id** — which staff account mints the token, and
   `eventbrite.organizationId` in config (optional but recommended).
4. **Partial-refund behaviour** — verify `costs.gross` on the first real one (Out of scope).
5. **Pre-cutover ticket revenue** — do staff want historical Eventbrite orders on the board?
   The backfill script can walk old events; not scheduled.

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
