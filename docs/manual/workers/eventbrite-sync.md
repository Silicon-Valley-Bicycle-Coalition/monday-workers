# eventbrite-sync

[Appendix A](../reference/eventbrite-sync.md) lists this Worker's routes, crons, queues, storage and bindings.

Deployed as `svbc-eventbrite-sync` (production) and `svbc-eventbrite-sync-sandbox` (sandbox). It
has no custom hostname: Eventbrite and the send page call it on its `*.workers.dev` URL. It gets
Monday access from the `monday-auth` broker's `SyncToken` entrypoint (the Staff sync OAuth app),
and hands employer answers to `impact-attribution` over the `EMPLOYER_ANSWERS` service binding.

## What it does

It keeps Monday in step with Eventbrite. Every paid ticket order becomes a Donations item (Gift
Type `Event Ticket`) linked to the buyer in People. Every event and attendee is kept on the Events,
Event Registrations, Volunteers and Pledge to Ride boards. It also backs the "Send event email"
page that coordinators use to email class reminders and thank-yous. If it stops, ticket revenue
and registrations stop reaching Monday and the send page stops working. The Worker itself never
sends email.

## Trigger and data flow

| Trigger | What it does |
|---|---|
| `POST /webhooks/eventbrite/order?secret=…` | Eventbrite webhook: `order.placed`, `order.updated`, `order.refunded` |
| `POST /webhooks/eventbrite/attendee?secret=…` | Eventbrite webhook: attendee, barcode and event actions listed in `attendeeSync.actions` |
| `GET /class-emails/:eventId`, `POST …/claim`, `…/result`, `…/release` | The send page (a Google Apps Script), header `X-Class-Email-Secret` |
| `GET /health` | Liveness check |
| Queue `eventbrite-sync-writes` | Orders, events, attendees and class-email follow-ups; one message at a time |
| Queue `eventbrite-sync-writes-dlq` | Consumed by this Worker; marks rows and logs |
| Cron `0 * * * *` (production only) | Hourly ended-event sweep; at 15:00 UTC also the missed-order check and the pledge count check |

Webhook routes accept the secret as `?secret=` or as an `X-Webhook-Secret` header (used by the
backfill scripts).

**Orders:**

1. The webhook route checks the secret and reads only the order id from `api_url`, after checking
   its host and path. The payload is never trusted for data.
2. It upserts D1 `orders` (ids and status only, no personal data) and enqueues the order.
3. The consumer fetches `GET /v3/orders/{id}/?expand=event` with its own token.
4. It maps `placed` → `Received` and `refunded` → `Refunded`. Any other status, a free order with
   no item yet, or a refunded order with no item yet is `skipped`. A non-USD order is `failed` for
   a human to enter.
5. It matches the buyer on People by email, or creates a Person. No email means no Donor link.
6. It writes: the item on the ledger row, else an item found by **Eventbrite Order ID** (adopt
   before create), else a new item with the first-write stamps (Thank You Sent, Gift Type, Fiscal
   Year Ending).

**Attendees and events:** same shape, with D1 `events` and `attendees`. Each delivery is a pointer;
the consumer fetches fresh data and writes the Events item and one Event Registrations item per
attendee. Attendees of a volunteer-program event go to the Volunteers board instead. Attendees of
an event listed in `pledge.events` go to the private Pledge to Ride board instead. Attendance is
never downgraded. Eventbrite item names win: a rename in Monday is overwritten.

**Class emails:** the send page asks who may get a `reminder`, `thank-you` or `missed-you`,
claims recipients (recorded in D1 `class_email_recipients` before the page sends), sends from
Gmail, then posts results. `result` queues per-recipient follow-ups: a timeline entry, No Show for
a missed-you, the People link for a thank-you. A claimed recipient is never handed out twice;
`release` frees failed ones, and claimed ones after 10 minutes.

**Cron jobs:**

- **Ended-event sweep:** re-queues events from the last 30 days that ended while last seen `live`
  or `started`, so their Event Status becomes Completed (or canceled).
- **Missed-order check:** lists orders Eventbrite changed in the last 26 hours and logs a
  `console.error` (raised by Workers Issues) for any the ledger doesn't have. This catches a
  deleted or disabled webhook.
- **Pledge count check:** compares Eventbrite's attendee totals with the ledger for configured
  pledge events.

## Monday boards and columns

Ids live in `config/svbc.json` (production) and `config/sandbox.json`.

| Board | Columns (bare titles) | Access |
|---|---|---|
| Donations | Eventbrite Order ID, Amount, Status, Date, Thank You Sent, Gift Type, Fiscal Year Ending, Donor | Write |
| People | Personal Email (match), First Name, Last Name (new people only) | Read; create |
| Events | Eventbrite ID, Date, End, Venue, Address, City, Program, Event Status, Source, URL, Send event email link (`attendeeSync.events`) | Write |
| Event Registrations | Eventbrite Attendee ID, Attendee Name, Attendee Email, Attendee Phone, First Name, Attendance, Source, Role, Event, Attendee (People link), Class Date, Class Day, Class Location, Home Zip, Registrants link (`attendeeSync.registrations`) | Write |
| Volunteers | Event, Eventbrite Listing, Eventbrite Attendee ID, Attendee Name, Attendee Email, Ticket Type, Job, Date, Status, Historical, Volunteer | Write |
| Pledge to Ride | The columns in `pledge.columns`: attendee id, year, status, date, email, Details, zip, County, consent, Other Answers and the pledge's own answers | Write (creates missing labels) |

Labels and types that must be right:

- Donations Status `Received` and `Refunded` (shared with `funraise-sync`; both exist in
  production and sandbox as of 2026-11-19). A refund write fails without `Refunded`.
- **Attendee Email** must be an Email column, not text.
- Volunteers Status: RSVP, Completed, Canceled (staff-set No-Show, Prospect and Confirmed are kept).

Config placeholders that switch features off: `homeZipColumn` (`REPLACE_WITH_COLUMN_ID` in
production, so Home Zip isn't written there), and in the sandbox `orderIdColumn` and
`events.sendLinkColumn`. While `orderIdColumn` is a placeholder the route stores deliveries but
the consumer refuses to write, and messages dead-letter. The Volunteers path turns on only when all
five of its new column ids are real; a half-filled set fails config validation.

The production Pledge to Ride board exists, but `pledge.events` is empty. Each new year's event
must be added to config and deployed **before** it is published on Eventbrite (see Operator
scripts).

## Secrets

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `EVENTBRITE_PRIVATE_TOKEN` | Every Eventbrite read (orders, events, attendees, cron checks). No read-only scope exists; it acts as the user who minted it | Eventbrite: Account Settings → Developer Links → API Keys → Private token. Mint from a login that only administers SVBC events | Create a new key, `wrangler secret put EVENTBRITE_PRIVATE_TOKEN` (`--env sandbox`), revoke the old key |
| `EVENTBRITE_WEBHOOK_SECRET` | `?secret=` on both Eventbrite webhook URLs | Generated by the operator (`openssl rand -hex 32`) | `wrangler secret put`, then edit both webhooks in Eventbrite (Developer Links → Webhooks) |
| `CLASS_EMAIL_SECRET` | `X-Class-Email-Secret` from the send page | Generated by the operator | `wrangler secret put CLASS_EMAIL_SECRET`, and set the same value in the Apps Script project's Script Properties |
| `MONDAY_API_TOKEN` (optional) | Fallback Monday token from the OAuth cutover; the binding is preferred | Monday (SVBC Integration user) | Delete once the binding is confirmed. Don't add new uses |

Which login minted the production token is recorded in the private appendix. Without
`eventbrite.organizationId` in config (it is `null` in both), the missed-order check asks
Eventbrite for the token's organization and fails if there is more than one.

Sandbox and production each have their own secrets. See
[accounts and access](../03-accounts-and-access.md).

## Write switch

Key `eventbrite-sync:writes`. `writes hold` and `on` through `scripts/flags.mjs` also pause and
resume the queue.

| Mode | Behavior |
|---|---|
| `on` | Normal. |
| `hold` / `unknown` | Webhooks still record deliveries. Queue messages retry. The cron run is skipped with one `write mode is …` line. Class email `claim` and `release` return 503. |
| `off` | Webhooks record deliveries, stamped `dropped`; they are never written later, even after `on`. The consumer dry-runs every write and queue send. The sweep dry-runs; the read-only checks still run. Class email `claim` and `release` return 503. |

`GET /class-emails/:eventId` works in every mode and reports `writesOn`. `result` always records
the D1 ledger (the emails already went), but posts the Events update and follow-ups only under
`on`.

After a long `hold`, the missed-order check's 26-hour window won't cover the gap. Run
`backfill-orders.mjs --dry-run` per event for the held days. Nothing re-drives rows ingested under
`off`; use the backfill scripts. See [Operations](../07-operations.md).

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Daily `console.error` naming order ids not in the ledger | Webhook deleted, disabled or repointed in Eventbrite | Check Eventbrite → Developer Links → Webhooks, then `backfill-orders.mjs` per event |
| Every message fails naming `EVENTBRITE_PRIVATE_TOKEN` | Token unset, revoked, or rejected (401/403) | Set a working token; the backlog heals on retry |
| Webhook answers 401 | Secret mismatch or unset | Fix the webhook URL or the secret |
| Rows `failed` with `not retried: …` | A 4xx no retry can fix: bad column value, missing column, board or item | Fix config or board, then backfill the event. Query `… where error like 'not retried%'` |
| Rows `dead-lettered after retries: …` | Four days of retryable failures (Monday outage, rate limit, `UserUnauthorizedException`, which is also Monday's answer for a deleted board) | Fix the cause, then `backfill-orders.mjs` / `backfill-attendees.mjs` |
| Order `failed`, "deleted or archived" | Staff deleted the order's Donations item | Not recreated by design; enter by hand if needed |
| Order `failed`, "not USD" | Non-USD order | Enter by hand at the converted amount |
| Refund write rejected | `Refunded` label missing on Donations | Add the label, then backfill the event |
| Pledges land on Event Registrations | New Pledge to Ride event published before config deploy; `processEvent` logs an error | Add the config and deploy; `update attendees set monday_item_id = null where event_id = '<id>'`; replay with `backfill-attendees.mjs`; delete stray rows |
| Pledge count check error daily | Pledges missing from ledger, or a newly configured past event not replayed | Check the webhook; replay the event |
| Event stays Upcoming after it ended | Imported event with no ledger row, or older than the 30-day sweep window | `backfill-attendees.mjs` for that event |
| Send page refuses an event | Event canceled, not started or ended for the kind, or no one checked in for a thank-you | Expected. Partial check-in sends missed-you to the rest; staff decide when check-in is done |
| Send page shows "Unconfirmed" recipients | Apps Script run stopped mid-send | Release after 10 minutes, then re-send |
| Class email `claim` returns 503 | Write switch not `on` | Set writes `on` |
| Employer answer messages dead-letter | `impact-attribution` migration `0003`, entrypoint or config missing | Fix `impact-attribution`; board items already exist. Or set `employerAnswers.enabled` to `false` |
| Two webhook spellings for check-in | Eventbrite stores `attendee.checked_in` as `barcode.checked_in` | Both are in `attendeeSync.actions`; keep them |

Useful D1 queries:

```sh
npx wrangler d1 execute svbc-eventbrite-sync --remote --command \
  "select order_id, event_id, error, received_at from orders where error like 'dead-lettered%'"
npx wrangler d1 execute svbc-eventbrite-sync --remote --command \
  "select status, count(*) from orders where event_id = '<id>' group by status"
```

## Operator scripts

All run from `eventbrite-sync/`. Backfills POST to the deployed Worker and never touch D1 or Monday
directly; they're safe to re-run. Use `--dry-run` first. For sandbox add `--env sandbox` with the
sandbox `--worker-url` (the script refuses a mismatch).

| Script | When | Command |
|---|---|---|
| `backfill-orders.mjs` | Re-drive orders after a dead-letter, a webhook gap or a fix. **Never for an event that sold tickets before 2026** (those migrated without order ids and would duplicate) | `EVENTBRITE_PRIVATE_TOKEN=… EVENTBRITE_WEBHOOK_SECRET=… node scripts/backfill-orders.mjs --event-id <id> --worker-url https://svbc-eventbrite-sync.<subdomain>.workers.dev [--changed-since <iso>]` |
| `backfill-attendees.mjs` | Seed an event that predates the webhook; re-drive attendees; fill new columns such as Attendee Phone or Home Zip | `EVENTBRITE_PRIVATE_TOKEN=… EVENTBRITE_WEBHOOK_SECRET=… node scripts/backfill-attendees.mjs --event-id <id> --worker-url <url> [--pause-ms 2000]` |
| `backfill-send-links.mjs` | Write the Send event email link on events the Worker won't process again | `MONDAY_API_TOKEN=… node scripts/backfill-send-links.mjs --dry-run` |
| `backfill-registrants-link.mjs` | Fill the Registrants link on older registrations | `MONDAY_API_TOKEN=… node scripts/backfill-registrants-link.mjs --dry-run` |
| `backfill-volunteers.mjs` | Move Role = Volunteer registrations to the Volunteers board (dry run by default) | `MONDAY_API_TOKEN=… node scripts/backfill-volunteers.mjs [--apply] [--env sandbox]` |
| `setup-volunteers-board.mjs` | Create missing Volunteers columns and the "Recent events" view; prints config ids | `MONDAY_API_TOKEN=… node scripts/setup-volunteers-board.mjs --board <id> --events-board <id> [--apply]` |
| `setup-pledge-board.mjs` | Create the private Pledge to Ride board; prints config. Subscribe the integration user and `monday-backup`'s user | `MONDAY_API_TOKEN=… node scripts/setup-pledge-board.mjs --workspace <id> [--subscribe <userId>] [--apply]` |
| `pledge-event-config.mjs` | Each year, on the **draft** Pledge to Ride event; paste the output into config and deploy before publishing | `EVENTBRITE_PRIVATE_TOKEN=… node scripts/pledge-event-config.mjs --event-id <id> --year <n>` |
| `compare-attendee-pairs.mjs` | Read-only check whether two attendee rows for one person are real in Eventbrite | `EVENTBRITE_PRIVATE_TOKEN=… node scripts/compare-attendee-pairs.mjs --event <id> --attendees <id>,<id>` |

Eventbrite publishes a limit of 2,000 calls an hour, shared with live traffic, so pace large
backfills. Don't create a test event to rehearse: production's webhook covers the whole
organization. Replay a past event to the sandbox instead.

After board rebuilds, reset D1 (switch on `hold` and webhooks disabled first):
`DELETE FROM attendees; DELETE FROM events; DELETE FROM orders;`, export first. Then redeploy,
re-register webhooks and backfill. See the README's "Resetting for new board ids".

## Changing it

Key files:

- `src/webhook/route.ts`, `validate.ts`, `validateAttendee.ts`: webhook routes and payload checks.
- `src/consumer/`: one processor per message type (`processBatch`, `processEvent`,
  `processAttendee`, `processVolunteer`, `processPledge`, `processClassEmail`,
  `processDeadLetters`, `employerAnswer`).
- `src/mapping/`: field mapping (order, event, attendee, volunteer, pledge, home zip, employer).
- `src/classEmails/`: send page routes and recipient planning.
- `src/endedEvents/sweep.ts`, `src/missedOrders/check.ts`, `src/pledgeCounts/check.ts`: cron jobs.
- `src/errors.ts`: which failures are not retried.
- `src/config.ts`: config validation, including the Volunteers mode switch.

Gotchas:

- `src/flags.ts`, `src/monday/graphql.ts` and `src/monday/outage.ts` are byte-identical copies;
  edit the canonical files (see [Development](../05-development.md)).
- Internal names still say "class email" (`/class-emails`, `CLASS_EMAIL_SECRET`,
  `class_email_recipients`) because the deployed page uses them. Don't rename them.
- Never log an email, name, zip or free-text answer. `node ../scripts/check-log-safety.mjs
  eventbrite-sync/src` must stay clean.
- Status columns on the pledge board must be written as `{ label }`; a bare `"2026"` is read as an
  index and the write is refused.

Test and deploy from `eventbrite-sync/`:

```sh
npm test
npm run typecheck
npm run deploy
npm run deploy:sandbox
npx wrangler d1 migrations apply svbc-eventbrite-sync --remote
npx wrangler d1 migrations apply svbc-eventbrite-sync-sandbox --remote --env sandbox
```

When turning on employer answers in an environment, deploy `impact-attribution` (with its
migration `0003`) first, so the binding resolves. See [CI and deploy](../06-ci-and-deploy.md).

## Further reading

- [eventbrite-sync/README.md](../../../eventbrite-sync/README.md): full field mapping, class email
  route contracts, Pledge to Ride, employer answers, reset procedure.
- [Staff UAT script](../../../docs/uat/eventbrite-sync.md)
- [Volunteers board cutover runbook](../../../docs/runbooks/volunteers-board-cutover.md)
- Design specs: [orders](../../../docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md),
  [attendees and class emails](../../../docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md),
  [class emails from Monday](../../../docs/superpowers/specs/2026-11-03-class-emails-from-monday-design.md),
  [grant report](../../../docs/superpowers/specs/2026-11-04-eventbrite-grant-report-design.md),
  [Pledge to Ride board](../../../docs/superpowers/specs/2026-11-05-pledge-to-ride-board-design.md),
  [Volunteers board](../../../docs/superpowers/specs/2026-11-11-volunteers-board-eventbrite-design.md),
  [employer answers](../../../docs/superpowers/specs/2026-11-17-eventbrite-employer-answers-design.md),
  [write switch](../../../docs/superpowers/specs/2026-10-26-write-switch-design.md)
- [impact-attribution/README.md](../../../impact-attribution/README.md): the receiving side of
  employer answers.
- Core chapters: [Architecture](../02-architecture.md), [Operations](../07-operations.md),
  [Troubleshooting](../08-troubleshooting.md)
