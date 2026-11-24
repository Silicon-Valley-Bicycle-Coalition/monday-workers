# mailchimp-sync

**Staff UAT script:** [`docs/uat/mailchimp-sync.md`](../docs/uat/mailchimp-sync.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status:** Built — repurposed from the never-deployed `membership-reminders` (2026-08-26).
**Production deployed and writing** (at least since 2026-11-14; outbound only — see the
Prerequisites' "Production starts outbound-only"). The [consent column sync](#consent-columns)
is on in production since 2026-11-17 (David's go-ahead; that day's plan: 141 changes, 37 of them
opt-outs). **Sandbox provisioned
and verified 2026-09-22**: `svbc-mailchimp-sync-sandbox`
is deployed, with its own D1/queues/secrets, a live "SVBC Sandbox" Mailchimp audience
(`dfe12eec72`, `us9`), and both Monday/Mailchimp webhooks registered. Verification also caught
and fixed two bugs invisible to the unit suite — both `HttpMondayClient` and `HttpMailchimpClient`
called an unbound native `fetch` as `this.fetchFn(...)`, throwing "Illegal invocation" on every
real request; and `findItemIdByEmail`'s GraphQL declared `$email: [String!]` where Monday's schema
wants `[String]!`. See git history for both fixes.
**Priority:** Post-migration, **time-sensitive** — SVBC's existing Mailchimp newsletter
segmentation (by city, by donation history) is fed from Salesforce today and breaks at
retirement, same urgency as the renewal reminders this Worker's predecessor was built for.
**Owner:** David (decided 2026-10-09).
**Stack:** Hono + TypeScript + D1 + Cloudflare Queues (two pairs) + Cloudflare Cron Trigger.
**Design doc:** [`docs/superpowers/specs/2026-08-26-mailchimp-sync-design.md`](../docs/superpowers/specs/2026-08-26-mailchimp-sync-design.md)

## The ask

Keep Monday.com (the post-migration source of truth for donor data) and Mailchimp in sync, in both
directions, so that:

* The 3-stage new-member welcome drip and the 3-stage renewal reminders (formerly planned as
  Worker-side sends — see the design doc's Decision History) run as Mailchimp Customer Journeys,
  staff-owned, triggered off Member Since / Member Until merge fields this Worker maintains.
* The existing newsletter segments (by city/address, by donation history) keep working after
  Salesforce retires.
* Staff can see, per donor, which Mailchimp campaigns/journeys they're currently part of, via a
  connect-column on the Donor item pointing at a "Mailchimp Campaigns" board, whose items are kept
  current by this Worker's daily reconciliation run (the board itself is staff-created once, like
  every other board id in this repo).

## Data flow

Four independent flows — see the design doc for full sequence diagrams:

1. **Outbound:** Donor column change on Monday → webhook → D1 idempotency → Cloudflare Queue →
   Mailchimp contact update (merge fields: Member Since/Until, Tier, Status, Address, Total
   Given; tags: active/lapsed/lifetime-member, has-donated, recurring-donor). A change to a column the sync doesn't
   read (`donorColumnIds` in `src/monday/client.ts`) is skipped at the webhook, so a bulk write to
   another People column, like the 2026-11-03 Location backfill, sends nothing to Mailchimp. **Update only — never creates a
   contact.** Mailchimp is the consent system of record, so a Donor whose address isn't already
   in the audience (they never opted in) is recorded as `skipped` and left out; the write is a
   `PATCH`, which 404s rather than creating, and never sends a `status`, so an unsubscribed or
   cleaned contact stays that way. People join the audience only through Mailchimp's own
   signup forms, the cutover consent import, or a member's own opt-in on the member portal
   (always pending, so Mailchimp's confirm email decides — see
   [Member portal preferences](#member-portal-preferences)). **Exceptions:** a reviewed Do Not
   Solicit unsubscribes the contact — see [Do Not Solicit](#do-not-solicit) below — and so does a
   member's own opt-out on the portal. **An Email
   change moves the contact:** when staff change a Donor's Email column, the old address's
   contact is renamed to the new one, so its consent and history follow the person — see
   [Address changes made on Monday](#address-changes-made-on-monday).
   **Coalesced per Donor ([GL#97](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/97)):** every outbound message is a full current-state sync, so the
   consumer acks one without work when the Donor's last completed sync began after the message
   was enqueued (`pending_outbound_syncs.last_sync_started_at`, migration `0006`); a message
   carrying an Email change is never skipped.
2. **Campaign catalog reconciliation:** daily cron diffs the interests in the Interest Categories
   listed in `mailchimp.interestCategoryIds` against a D1-tracked set of Monday items on the
   Campaigns board — creates, renames, or archives as needed. Other categories are ignored, and
   so are their interests on the inbound side: SVBC's production audience holds five older,
   hidden categories (57 interests, mostly Constant Contact lists from 2008–2014) that would
   otherwise each become a Campaigns item. A configured id missing from the audience fails the
   run instead of reading as "no interests", which would archive every item. No webhook exists for "Interest Category changed" in Mailchimp, so this is polling, not
   a reliability fallback.
3. **Inbound:** Mailchimp subscribe/unsubscribe/profile event → webhook → D1 idempotency →
   Cloudflare Queue → resolve the contact's current interests to Campaigns-board item ids → write
   the full current set to the Donor's connect column. Catalog work is per queue batch, not per
   message ([GL#97](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/97)): a member with no Donor item is skipped before any of it, one D1 query resolves
   the batch's interests, and an interest the catalog doesn't know triggers one reconcile for the
   whole batch, run after every member in it was read.

4. **Consent columns (hourly):** a cron at :05 sets the Personal, Household and Work Email Consent
   columns to each address's current Mailchimp status — see [Consent columns](#consent-columns).
   Mailchimp → Monday only, by polling, so it needs no audience webhook.

5. **Journey send log (hourly, :20)** and **Mailchimp Profile link (hourly, with consent):** every
   Customer Journey email sent becomes a timeline entry on the recipient's People item, and each
   People item links to its Mailchimp contact — see [Journey send log](#journey-send-log).

6. **Employer answers (hourly, with consent):** the Employer field on a member's Mailchimp profile is
   handed to `impact-attribution` as a proposed employer for staff to confirm — see
   [Employer answers from Mailchimp profiles](#employer-answers-from-mailchimp-profiles).

**Retries.** A failed queue message is retried with exponential backoff — 1 minute doubling to an
hour (`retryDelaySeconds` in `src/flags.ts`), up to the queue's 100 retries (about four days) —
before landing in its `-dlq` dead-letter queue. When Mailchimp
(429, `Retry-After`) or Monday (`retry_in_seconds`, `Retry-After`) says how long to wait, the
retry waits at least that long; Monday's `DAILY_LIMIT_EXCEEDED` with no hint waits until
midnight UTC. Every delay is capped at Queues' 12-hour maximum. A permanent Mailchimp rejection
(malformed address, other 4xx) is acked instead, on both the outbound and inbound side, since it
would fail identically every time — except a 401/403, which means the `MAILCHIMP_API_KEY` secret
is bad or rotated: those always retry and dead-letter (logged as `MAILCHIMP CREDENTIALS
REJECTED`), so the backlog can be replayed once the key is fixed — see
[Dead letters](#dead-letters).

## Dead letters

Each main queue dead-letters into its own `-dlq` (four in all: `mailchimp-sync-outbound-dlq`,
`mailchimp-sync-inbound-dlq`, and the `-sandbox-dlq` twins), and this Worker consumes all four
([GL#37](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/37), `src/consumer/deadLetters.ts`). A dead message calls neither Monday nor Mailchimp — it:

* stamps its pending row's `error` with `dead-lettered after retries: ` in front of the last
  error the consumer recorded (never doubled, so a replay that dead-letters again stays
  readable), leaving `status` at `failed`;
* leaves the row alone if it has been `written` at or after the message was sent, is `skipped`
  (only a completed delivery sets that), or was replaced by a newer webhook delivery since
  (which has its own queue message) — attaching a DLQ consumer to an old backlog must never
  downgrade rows fixed in the meantime (donation-rollups' first-deploy incident);
* always acks. Only a D1 failure retries the dead message (60 s, at most `max_retries: 2`, no
  further DLQ).

Each batch that marked anything logs **one** `console.error` naming the Monday Donor item ids
(outbound) or Mailchimp member ids (inbound — the subscriber hash, MD5 of the lowercased
address, the same id Mailchimp's API and UI use; no email address is logged). When the recorded
error is a rejected API key, the line leads with `MAILCHIMP CREDENTIALS REJECTED`: fix the
`MAILCHIMP_API_KEY` secret before replaying, or the replay dead-letters again.

**Alert (optional).** Set `SLACK_WEBHOOK_URL` (a Slack incoming-webhook URL — the same secret
name and payload `monday-backup` uses) to also post that line to Slack, once per batch:

```sh
npx wrangler secret put SLACK_WEBHOOK_URL                 # production channel
npx wrangler secret put SLACK_WEBHOOK_URL --env sandbox   # a sandbox channel, e.g. #crm-sandbox
```

Unset, the Worker logs only (Workers Logs). A failing Slack post is logged and never affects
the acks.

**Replay.** Once the cause is fixed, `scripts/redrive-dead-lettered.mjs` re-enqueues the marked
rows through the Worker's normal webhook routes — each becomes a minimal Monday
(`/webhooks/monday/donors`, the Donor item id) or Mailchimp (`/webhooks/mailchimp/audience`, the
address) delivery, the route resets the row to `received` and enqueues it, and the consumer
re-reads current state and writes as it would for a real delivery. It is a **dry run unless
`--apply`** is passed, and reads D1 with `wrangler d1 execute --remote`:

```sh
# plan: every dead-lettered row, both directions (production D1)
node scripts/redrive-dead-lettered.mjs
# narrow: sandbox, outbound only, a date window, or specific ids
node scripts/redrive-dead-lettered.mjs --env sandbox --direction outbound --since 2026-09-20 --until 2026-09-25
node scripts/redrive-dead-lettered.mjs --direction inbound --item <mailchimp-member-id>,<mailchimp-member-id>
# send (secrets from `wrangler secret put` for the same env; only the directions being sent are needed)
MONDAY_WEBHOOK_SECRET=... MAILCHIMP_WEBHOOK_SECRET=... \
  node scripts/redrive-dead-lettered.mjs [--env sandbox] --apply --worker-url https://<worker-host>
```

`--item` takes Monday Donor item ids for outbound and Mailchimp member ids (the ids the DLQ log
line prints) for inbound. Output never prints an email address or the request URL — both routes
only accept the secret as `?secret=`, so it rides in the URL exactly as on a real delivery.
`--pause-ms` (default 2000) spaces deliveries for the one-at-a-time consumers. Re-run the dry
run ~30 minutes later (the retry backoff spans ~21) to confirm nothing dead-lettered again.

To find dead rows directly:
`select donor_item_id, error, received_at from pending_outbound_syncs where error like 'dead-lettered%'`
(and `pending_inbound_syncs` for the inbound side — its key is the email address, so keep that
output out of tickets and chat).

**Deploying the DLQ consumers (ops — not yet done).** Queue retention is not a `wrangler.jsonc`
setting; donation-rollups raised its DLQ to 14 days with `wrangler queues update` (its README,
"Queue retention, corrected 2026-09-18"), and so does this Worker. **Timing matters at the deploy.**
Merging does not deploy the sandbox Worker (no Workers Builds connection or CI token as of
2026-09-28 — root README, "Deploys"); it ships when someone runs `npm run deploy:sandbox` from
`main`, so do these steps before that deploy (and, if a connection is ever added, before merging). A deploy that declares a consumer for a missing queue fails, and the new
consumer drains whatever a DLQ already holds within a minute of attaching.

*Before the sandbox deploy* — sandbox (`--env sandbox`, `-sandbox` / `-sandbox-dlq` queue names):

1. Make sure both sandbox DLQs exist — `npx wrangler queues info mailchimp-sync-outbound-sandbox-dlq`
   (and `-inbound-sandbox-dlq`); create a missing one with `npx wrangler queues create <dlq>`.
2. Raise both to the 14-day maximum, so a paused or broken consumer never silently loses dead
   letters, and check the sandbox main queues are at least the 4-day default (donation-rollups'
   were created at 1 day):

   ```sh
   npx wrangler queues update mailchimp-sync-outbound-sandbox-dlq --message-retention-period-secs 1209600
   npx wrangler queues update mailchimp-sync-inbound-sandbox-dlq --message-retention-period-secs 1209600
   npx wrangler queues info mailchimp-sync-outbound-sandbox   # and mailchimp-sync-inbound-sandbox
   ```

3. Check each sandbox DLQ for a backlog (`wrangler queues info`): it is delivered on deploy, and
   anything older than its retention is dropped at that moment (donation-rollups lost ~2,700
   that way). Expect one log line / alert per batch of 10; letters for rows fixed since are
   left alone.
4. Optionally `wrangler secret put SLACK_WEBHOOK_URL --env sandbox`, so the first batch alerts.

*Before the first production deploy* (`npm run deploy`): the same three checks for
`mailchimp-sync-outbound-dlq` / `mailchimp-sync-inbound-dlq` and the production main queues,
plus the optional production `SLACK_WEBHOOK_URL`:

```sh
npx wrangler queues update mailchimp-sync-outbound-dlq --message-retention-period-secs 1209600
npx wrangler queues update mailchimp-sync-inbound-dlq --message-retention-period-secs 1209600
npx wrangler queues info mailchimp-sync-outbound   # and mailchimp-sync-inbound
```

The DLQ consumer needs no D1 migration of its own.

*One-time verification, in sandbox after the merge.* The staleness check compares the dead
letter's `message.timestamp` with the row's `received_at` / `written_at`, assuming a DLQ delivery
keeps the **original send time** rather than the time it was moved to the DLQ (funraise-sync and
donation-rollups assume the same; nobody has confirmed it). Force one dead letter — e.g. set a
bogus `MAILCHIMP_API_KEY --env sandbox`, touch a sandbox Donor, wait out the ~21-minute backoff,
then restore the key — with a temporary `console.log` of `message.timestamp.toISOString()`
in the DLQ consumer, and compare it with that row's `received_at` in
`svbc-mailchimp-sync-sandbox`. Within a second or two of `received_at`: the assumption holds.
~21 minutes later (the DLQ move): it doesn't — rows re-driven between the original send and the
DLQ move would not be recognized as replaced, so tighten the check (and tell the two sibling
Workers) before relying on it. Replay the forced letter afterwards with the script above.

Once any backlog's cause is fixed, replay it with `scripts/redrive-dead-lettered.mjs`.

## Do Not Solicit

Two steps, so a mis-clicked checkbox can't silently lose a subscriber:

1. **Do Not Solicit checked → `do-not-solicit` tag, right away.** Added on the next outbound
   sync regardless of the reason; fundraising sends and Customer Journeys exclude that tag, while
   newsletters still go out. Unchecking the box removes the tag (it's a managed tag).
2. **Do Not Solicit checked *and* DNS Reason Status = `dnsConfirmedValue` ("Confirmed") →
   unsubscribed.** "Confirmed" is set by the compliance owner after reviewing the reason — the
   board's automations only ever set Missing/OK. The Worker then sets the Personal Email's
   Mailchimp status to `unsubscribed` (`unsubscribeMember`: looks the member up first; an
   already-unsubscribed or cleaned address needs no write) and records it in the D1
   `dns_unsubscribes` table — email, Monday item, result, timestamp. That row is the audit trail,
   and it stops later column changes on the same person from calling Mailchimp again. The
   unsubscribe runs before the merge-field and tag update, so a permanent error in that update
   can't skip it. An address not in the audience isn't logged, so if the person joins later
   their next column change still unsubscribes them.

Deliberate limits:
* **Never resubscribes.** Unchecking the box, or moving the status off Confirmed, removes the
  tag but leaves the unsubscribe in place; only the person can opt back in, through Mailchimp
  (or the member portal, which asks Mailchimp to email them a confirm link).
* **Personal Email only.** The Household Email may be shared by other people in the household,
  so it is never unsubscribed on one person's flag (it isn't synced at all yet — see below).
* **People and People (Historical) only.** Organizations carry the same columns but aren't
  watched: they stay a call list, not an email audience. A reviewed Do Not Solicit on Historical
  unsubscribes the address even if a People item holds it too.
* **Nothing flows back.** An unsubscribe that starts in Mailchimp doesn't check Do Not Solicit.

## Member portal preferences

The member portal's Profile tab lets a member turn email off or back on. Its writer
(member-portal-writer) calls this Worker's **`PreferenceSync`** entrypoint over a service binding
(`MAILCHIMP_PREFS`), `setEmailPreference(email, optedOut, requestId)`, so the Mailchimp key stays
here. The member portal README's "Communication preferences" has the whole flow.

* **Opt-out → `unsubscribeMember`**, the same call Do Not Solicit uses: an already-unsubscribed,
  cleaned or unknown address needs no write.
* **Opt back in → `requestResubscribe`**: a `PUT` setting the address to `pending` (and
  `status_if_new: pending`), so Mailchimp emails a confirm link and only the member's click
  subscribes them. Nothing is written for an address that's already subscribed or pending, or
  cleaned. The one place this Worker can add a contact, and only ever as pending.
* **Personal Email only**, chosen by the writer; the Household Email may be shared.
* **Write switch:** `on` writes; `off` dry-runs (a skip line, `portal-preference:<request id>`);
  `hold`/`unknown` throws, and the writer's queue retries.
* **Nothing is written to Monday here.** The hourly consent run carries the new status to the
  Personal Email Consent column, which the portal reads. A pending address stays Unsubscribed
  there (or Not in Mailchimp) until it's confirmed.

Deploy this Worker before member-portal-writer, which can't bind an entrypoint that isn't
deployed yet. Code: `src/preferences/emailPreference.ts`, the class at the end of `src/index.ts`.

## People (Historical)

The outbound flow also runs for People (Historical) ([GL#83](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/83)), configured as `monday.historical`: its
board id and its own column ids, since Monday gives each board different ones. Both boards post to
the same `/webhooks/monday/donors` route. The inbound flow stays on People: an audience event for
an address only Historical holds records as `skipped`, and Historical has no Campaigns connect
column.

* **Moving between the boards** (`people-reclassification`). The move keeps the Monday item id,
  and a contact is keyed by address, so it stays the same contact and the same
  `pending_outbound_syncs` row, and a `PATCH` can't create a duplicate. The consumer reads the
  item's board from Monday when it runs, not from the webhook, so a message queued before a move
  reads the right columns. Tags survive because the move carries the columns they come from.
* **An address on both boards.** One address is one contact, and People owns it. A Historical
  item whose address is also on People records as `skipped` and doesn't touch the contact's
  fields or tags, so a lapsed record can't overwrite a live one; its Nearby labels don't reach
  Mailchimp either. It doesn't move the contact off an address People still holds. The check costs
  a Monday read or two per Historical event.
* **Nothing backfills.** A Historical person syncs on their next change to a column the sync
  reads, a new Nearby label included. Until then their contact keeps what it has, and a Do Not
  Solicit already Confirmed on Historical doesn't unsubscribe anyone.

**To turn it on** (not done as of this change). Deploy, then register a second Monday webhook,
`create_item` + `change_column_value`, on the Historical board, with the same URL and secret as
the People one: sandbox board `18437342607`, production `18437909784`. SVBC Integration and
Sandbox Integration already subscribe to those private boards (checked 2026-11-03). Then have
`nearby-search` drop its "won't get the email yet" note (`src/page.ts`).

**Sandbox limits.** This Worker's sandbox uses the `(sandbox v3)` boards, while
`people-reclassification`'s sandbox uses v4, so a real move can't be rehearsed end to end here.
The v3 Historical board has no State column (`state: null`, so the ZIP gives the state) and its
DNS Reason Status has no Confirmed label; add one to test the unsubscribe there.

## Consent columns

Monday has one consent column per address column, each a status of Subscribed / Unsubscribed /
Cleaned / Not in Mailchimp:

| Board | Address | Consent |
|---|---|---|
| People, People (Historical) | Personal Email | Personal Email Consent |
| People, People (Historical) | Household Email | Household Email Consent |
| Affiliations | Work Email | Work Email Consent |

`salesforce-import` filled them once at cutover. Since 2026-11-16 an hourly cron (`5 * * * *`,
`src/consent/`) keeps them at Mailchimp's current status, so the Sponsor Outreach send (which
skips Work Email Consent = Unsubscribed or Cleaned) and staff reading any consent column see the
real state. Design: `../docs/superpowers/specs/2026-11-16-mailchimp-consent-columns-design.md`.

**Each run** reads every member of the audience (two passes: Mailchimp leaves archived members
out of its list unless asked), reads the address and consent columns on the boards in
`consent.boards`, and writes only the values that differ, 25 items per mutation. Nothing is
written to Mailchimp. Stateless: a failed run, board or item is redone the next hour.

| Mailchimp status for the address | Consent written |
|---|---|
| subscribed | Subscribed |
| unsubscribed | Unsubscribed |
| cleaned | Cleaned |
| archived | Cleaned if it already says Cleaned, otherwise Unsubscribed |
| pending, transactional | the existing value if it's Unsubscribed or Cleaned, otherwise Not in Mailchimp |
| not in the audience | the existing value if it's Unsubscribed or Cleaned, otherwise Not in Mailchimp |
| (the item has no address) | left as it is |

Archived and absent addresses read as opt-outs because archiving hides a contact's earlier status
(25,439 archived in production, most of them cutover Unsubscribed) and absence is never evidence
of consent; nor is pending (an unconfirmed re-signup) or transactional. An opt-out recorded on
Monday is lifted only by Mailchimp saying subscribed.

**Safety rails.**
* **Short read.** A pass that reads fewer members than Mailchimp reports, or whose total changes
  between pages (a member archived or deleted mid-read shifts the pages), writes nothing that
  run and alerts.
* **The cap, by direction.** Changes to Unsubscribed or Cleaned are always written: they can
  only stop mail. Changes toward a sendable value (Subscribed, Not in Mailchimp) are capped at
  `consent.maxChangesPerRun` (500). Over it, the run writes only the opt-outs, holds every
  sendable change, logs an error with the counts by transition and alerts. Raise the cap in
  config deliberately if a large change is real.
* **Alerts** go to `SLACK_WEBHOOK_URL` when set (the dead-letter alert's secret), counts only,
  on a tripped cap, a short or failed Mailchimp read (a 5xx, a rotated key), a board that
  couldn't be read, or any failed item write — every hour it keeps happening, since the sponsor
  send trusts these columns.
* **Monday outage.** A 429/5xx/timeout/spent budget (the outage breaker's `isMondayOutage`) stops
  the run's writes; the rest count as failed and the next hour redoes them. Items carrying an
  opt-out are written first, so a run cut short has already written the changes that stop mail.
* **Write budget.** Writes stop 12 minutes after the run starts (`CONSENT_WRITE_BUDGET_MS`):
  Cloudflare cancels a cron invocation at 15 minutes of wall time, before its log line or alert.
  Monday paces the writes at about 2 items a second, so a run writes roughly 1,500 items; the
  rest count as failed (`timedOut: true`), alert, and the next hour carries on. Steady state is a
  handful of changes an hour.
* A board whose read fails (a mistyped column id in config, say) is logged and skipped; the
  others still run.
* **Repeat cron deliveries.** Cloudflare occasionally delivers the same scheduled event twice, the
  second about 15½ minutes after the scheduled time (4 of 134 hourly events, 2026-11-18 to 11-23;
  never the short `20 * * * *` or daily runs). Every cron in this Worker first claims its
  `(cron, scheduledTime)` in D1 (`cron_runs`, migration `0009`, `src/db/cronRuns.ts`); a repeat
  finds the claim, logs a `cron-duplicate-skipped` line and returns. If the claim can't be recorded
  (D1 error, migration not applied) the run goes ahead, since every job here tolerates running
  twice. Claims older than a week are pruned as new ones are made.

**Switches.** `consent.enabled` in `config/*.json`: `true` in both the sandbox and production;
when it's `false`, each hourly run logs one line and does nothing else. Under the write switch: `on` writes,
`off` reads and plans and logs a `"writeSwitch":"skipped"` line per write chunk, `hold` / `unknown`
skip the run (nothing to catch up — the next `on` run writes whatever still differs).

**Logs.** One `{"event":"consent-run"}` line per run: items per board, `transitions` by board,
column and change, `held`, `written`, `failed`, `failedBoards`, `timedOut`. Item ids, column ids and counts,
never an address.

**Rehearse with the plan script** — read-only, runs whether or not `consent.enabled` is set:

```sh
MAILCHIMP_API_KEY=... MONDAY_API_TOKEN=... node scripts/consent-plan.mjs --env production
```

It prints the audience by status, items per board, every planned transition and whether the cap
would trip. Against production on 2026-11-16 (61,056 members, 24,441 items, 4.4 minutes) it
planned 138 changes: 37 to Unsubscribed or Cleaned (30 of them were Subscribed), 60 Not in
Mailchimp → Subscribed (signups since cutover), 40 blanks filled, 1 Work Email Consent filled. No
Unsubscribed or Cleaned became sendable, and the cap (500) wasn't close.

**Writes to People fire its webhooks.** This Worker's own Donors webhook skips them (consent
columns aren't in `donorColumnIds`). The consent columns are 🔒 in `MARKED_COLUMNS`
(`../scripts/mark-read-only-columns.mjs`): a staff edit is overwritten within the hour.

**CPU.** `limits.cpu_ms` is 1000 (was 100) for the ~61,000 Mailchimp members and ~25,000 Monday
items each run parses. The cap is per Worker, so the webhook routes share it. Measured in the
sandbox 2026-11-17 00:05 UTC: 73 ms CPU, 94 s wall (22,453 items read; the run is nearly all
network wait).

**Sandbox, 2026-11-17.** The first deployed run read all three boards (`failedBoards: []`, so the
Sandbox Integration's Sync token reaches them) and planned 6,232 changes to Not in Mailchimp —
the sandbox audience holds 2 members, so nearly every sandbox Subscribed is stale. The cap tripped
as designed: everything held, nothing written, the alert logged. The cap was then raised to
10,000 in `config/sandbox.json` for the catch-up. The 01:05 run wrote 1,835 values and was then cancelled by Cloudflare at 15 minutes'
wall time (`outcome: canceled`, 198 ms CPU) with no log line or alert — which is why writes now
stop at the 12-minute budget. With it, the 02:05 run ended on its own at 12.1 minutes
(`outcome: done`, `timedOut: true`, 1,250 written, 3,017 left for the next hours, 108 ms CPU).
The 03:05 and 04:05 runs also stopped at the budget (1,350 and 1,275 written); the 05:05 run
wrote the last 393 and finished on its own, and every run from 06:05 planned nothing. The cap
went back to 500 the same day.

**Turning it on in production** (after David's go-ahead):
1. `node scripts/consent-plan.mjs --env production` and check the transitions with David.
2. Set `consent.enabled: true` in `config/svbc.json`, merge, `npm run deploy`.
3. Read the first `consent-run` line after the next :05 (`failed: 0`, nothing held); rerun the
   plan script — it should plan nothing.
4. `node ../scripts/mark-read-only-columns.mjs` against production with `--apply`.

## Stewardship emails (Monday Sequences)

Decided 2026-11-19 (Clarrissa): the two welcome emails and three renewal reminders are sent by
**monday CRM Sequences**, not Mailchimp Customer Journeys. This Worker decides who gets which email;
Monday sends it from `membership@bikesiliconvalley.org` (a connected mailbox Martha manages) and logs it on the person's timeline. Setup and
go-live: [`docs/runbooks/stewardship-sequences.md`](../docs/runbooks/stewardship-sequences.md).

**How (`src/stewardship`, on the daily `0 15 * * *` cron, after the renewal-due tag).** Reads
People and plans one label per person on the 🔒 **Stewardship Email** status column:

| Label | When | Who |
|---|---|---|
| `Welcome: day after` | 1 day after Member Since | Member Type New, label blank |
| `Welcome: 3 weeks` | 21 days after Member Since | label is `Welcome: day after` |
| `Renewal: 3 weeks before` | 21 days before the reminder date | Active, not Lifetime, no active recurring gift |
| `Renewal: 1 week before` | 7 days before | same |
| `Renewal: day of` | on the reminder date | same |

The reminder date is Member Until less `plan.renewalMonthsEarly` months (1). Member Until is 13
months after the last gift or volunteer shift, and Salesforce counted 12; Felicia asked on 2026-11-23
to keep Salesforce's timing. Someone still carrying a migrated 12-month Member Until is reminded a
month early. The emails themselves print Member Until.

Nobody with Do Not Solicit or without a Personal Email. Before setting a send label it reads the
person's Mailchimp member (`GET /lists/{id}/members/{hash}`): only `subscribed`, and for renewals not
tagged `renewal-opt-out` and with the Renewal Reminders interest ticked (`stewardship.renewalInterest`;
on 2026-11-19 every subscribed active member had it ticked except the 137 Salesforce opt-outs). A
person not in the audience is never sent to. A Monday automation per label ("When Stewardship Email
changes to X, enroll item in Sequence X") does the enrolling; each Sequence is one automatic email.

The label is the state. A stage is set once (re-runs are no-ops), a missed day is caught up within
`plan.catchUpDays` (2), day-of is never sent after the date, and a renewal label is cleared once
the reminder date moves past 21 days (a renewal), so next year's reminders start fresh. Someone who renews
between reminders gets no further one: each email is decided on its own day. Follows the write
switch (`hold` skips the day, `off` logs what it would set). Logs carry item ids and labels only.
`stewardship: null` turns it off; production stays `null` until the Sequences and automations exist,
since a label set with no automation listening would use up that person's email.

## Journey send log

Superseded for the stewardship emails by the Monday Sequences above, which log their own sends; it
stays built and off (`journeyLog: null` in production) for any Journey staff may still run.

Spec: [`docs/superpowers/specs/2026-11-18-mailchimp-journey-send-log-design.md`](../docs/superpowers/specs/2026-11-18-mailchimp-journey-send-log-design.md)
(verified end to end in the sandbox on 2026-11-18).

**What staff see.** On a People item, under **Emails & Activities**, one "Mailchimp email" entry per
Customer Journey email the person was sent: the subject, the Journey and step ("New member welcome
series · email 1 of 2"), and a link to the email as sent, dated when Mailchimp sent it. A bounce
reads "Not delivered: <subject>". Two 🔒 columns: **Last Journey Email** (date of the latest
delivered one) and **Mailchimp Profile** (opens the contact in Mailchimp, where newsletter sends,
opens and clicks live; newsletters are not logged in Monday).

**How (`src/journeyLog`, cron `20 * * * *`).** Lists the audience's Journeys and their send-email
steps (`/customer-journeys/journeys/{id}/steps`; each is an `automation-email` campaign). For each
email whose `emails_sent` moved since its last read, reads `/reports/{id}/sent-to` and inserts the
new recipients into D1 `journey_sends` (migration `0007`, keyed by campaign and subscriber hash,
never the address) before moving that email's read mark. Then each `pending` row: match exactly one
People item on `journeyLog.emailColumns`, read the send time from the member's `/activity`, advance
Last Journey Email, create the timeline entry, mark `logged`. At-least-once: a failure leaves the
row pending for the next hour (after 5 failures it's `failed`); a crash between the entry and the D1
write repeats that one entry. No item or several: `unmatched` / `ambiguous`, no entry, never a new
person. Follows the write switch: `hold` skips, `off` records new sends as `dropped` (never logged).
Alerts on a failed Journeys read or failed entries; counts-only logs.

**Mailchimp Profile (`src/profileLinks`, on the consent cron).** The consent sync's member read also
collects each member's `web_id`; the link is `https://<dc>.admin.mailchimp.com/lists/members/view?id=<web_id>`
for the address in `profileLinks.emailColumn`. Only differing links are written (capped per run), a
link is cleared when the address leaves the audience, and nothing is planned on a failed read.

**Email Preferences (`profileLinks.preferences`, same run).** A second 🔒 link: the person's page on
Mailchimp's hosted preferences form, `<pageUrl>&e=<unique_email_id>`, where they can unsubscribe or
untick Renewal Reminders. The Monday stewardship Sequences link to it
(`docs/runbooks/stewardship-sequences.md`), because Monday's own unsubscribe list never reaches
Mailchimp; a change made on the page comes back to Monday's consent columns through the audience
webhook like any other. Only non-archived members get one (an archived member has no page). `pageUrl`
is the audience's form with no person in it, `https://<org>.<dc>.list-manage.com/profile?u=<account>&id=<audienceId>`
(the `u` and host are in the audience's `subscribe_url_long`); config validation refuses another
audience's form. Checked 2026-11-20: a real `e` opens the page, a wrong one is a 404. Anyone holding
the link can change that person's Mailchimp profile, as with the one in every Mailchimp email.

**Turning it on** (both `null` in both configs until the Monday pieces exist):

1. The **Mailchimp email** custom activity exists (created 2026-11-19; custom activities are per
   account, so both environments use `8a429b81-1416-4211-b8fc-d23e0ce87752`). Add **Last Journey
   Email** (Date) and **Mailchimp Profile** (Link) to People and People (Historical)
   (`people-reclassification/scripts/match-people-columns.mjs` copies them across); run
   `node scripts/mark-read-only-columns.mjs` (both are in `MARKED_COLUMNS`). The sandbox has both
   (`date_mm98v7ej`, `link_mm98rz6c`) and its config is filled. For the preferences link, also add
   **Email Preferences** (Link); the sandbox's is `link_mm99ntk0`.
2. Apply migration `0007` (`npx wrangler d1 migrations apply <db> --remote [--env sandbox]`).
3. Fill the config, e.g. production:
   ```json
   "journeyLog": { "boardId": 18437909781, "emailColumns": ["email_mm8nx6qg", "email_mm8n2wzk"],
     "timelineActivityId": "8a429b81-1416-4211-b8fc-d23e0ce87752", "journeyIds": null,
     "lastJourneyEmailColumn": "<date column id>", "maxEntriesPerRun": 200 },
   "profileLinks": { "boardId": 18437909781, "emailColumn": "email_mm8nx6qg",
     "linkColumn": "<link column id>", "maxWritesPerRun": 500,
     "preferences": { "column": "<Email Preferences column id>",
       "pageUrl": "https://bikesiliconvalley.us9.list-manage.com/profile?u=f5051c378a338d4fba23caa04&id=eab542a5df" } }
   ```
4. Deploy **before** Felicia turns the Journeys on, so the first run has no history to log. A Journey
   that already sent would have its earlier sends logged with their real send times on the first run.
5. Sandbox: Journey 112 "TEST journey send log (sandbox)" (paused) in the sandbox audience sends one
   email on **Tag added: journey-test** (a contact enters it once). Sandbox crons are off; run them
   by hand with `npx wrangler dev --remote --env sandbox --test-scheduled`, then
   `curl 'http://localhost:8787/__scheduled?cron=20+*+*+*+*'` (or `5+*+*+*+*`). Verified this way
   on 2026-11-19 — see the spec's Verification.

## Employer answers from Mailchimp profiles

[#7](https://github.com/Silicon-Valley-Bicycle-Coalition/monday-workers/issues/7): an optional
**Employer** field on the member's Mailchimp profile (the update-profile form the preference-center
link opens). What a member types there goes to `impact-attribution`'s `EmployerAnswers` RPC as
`source: 'mailchimp'`, which proposes a **Draft** affiliation for staff to confirm (it never becomes
an affiliation on its own). Answers given to the member portal's Employer field still become an
affiliation directly; this one is weaker, since nothing prompts a member to update it.

**How (`src/employerAnswers`, on the consent cron, after the profile links).** The consent sync's
member read also collects the `employerAnswers.mergeField` value of every subscribed or unsubscribed
member, so no audience webhook is needed (production has none). Pending signups are left out: they
are unconfirmed, and anyone can start one for any address with any answer. Each non-blank answer is keyed
`<member hash>:<hash of the normalized answer>`; D1 `employer_answers_sent` (migration `0008`) holds
one row per key handed over, so an unchanged answer is sent once and a changed one is sent again.
Per run, up to `maxAnswersPerRun` unsent answers: match exactly one People item on
`employerAnswers.emailColumns`, then call the RPC with the answer, today's date and context
`Mailchimp profile`. impact-attribution's result is recorded and final, except `disabled` (its
`employerAnswers` config is unset) and `invalid` (an impact-attribution build older than
`source: 'mailchimp'`; logged as `employer-answer-invalid`), which stop the run and leave every
answer for a later one. No People item, or
several: recorded `unmatched` / `ambiguous` and looked up again a day later. A failed RPC or a
Monday outage leaves the rest for the next hour; a failed member read plans nothing. Follows the
write switch: `hold` skips, `off` dry-runs (one `Employer answers` skip line per answer, ids only;
nothing sent or recorded). Logs carry hashed ids and counts only, never an address or an answer.

**Turning it on** (on in both environments since 2026-11-20: an `EMPLOYER` field in each audience,
migration `0008` applied, impact-attribution deployed with `source: 'mailchimp'`. The production
audience also holds an older hidden `MMERGE3` "company name" field from past imports; it is
deliberately not read, since members didn't state it):

1. In the Mailchimp audience, add a text merge field **Employer** (tag `EMPLOYER`), not required, and
   show it on the update-profile form (Signup forms → Form builder → Update profile form). Optionally
   add a line saying why SVBC asks (matching gifts).
2. `impact-attribution` deployed with `source: 'mailchimp'` and its `employerAnswers` config set
   (see its README); otherwise every call returns `disabled` and nothing is recorded here.
3. Apply migration `0008` (`npx wrangler d1 migrations apply <db> --remote [--env sandbox]`).
4. Fill the config, e.g. production:
   ```json
   "employerAnswers": { "mergeField": "EMPLOYER", "boardId": 18437909781,
     "emailColumns": ["email_mm8nx6qg", "email_mm8n2wzk"], "maxAnswersPerRun": 100 }
   ```
   Deploy, then check the next `employer-answers-run` log line. Sandbox crons are off; run the
   consent cron by hand as in the Journey send log's step 5 (`5+*+*+*+*`).

## Resetting for new board ids

When the People board is deleted and rebuilt (a cutover retry — private runbook, Rollback step 8
— or a sandbox rebuild), D1 still describes the old board's items. Reset it before deploying
against the new boards.

**First:** disable the Monday Donors webhooks (People and People (Historical)) and the Mailchimp
audience webhook, and delete or archive the old boards (while the old Mailchimp Campaigns board exists, the daily reconcile on
the old config creates fresh items on it and records them in `campaign_items` again).

```sh
# 1. Export, to somewhere outside the repo — it holds email addresses. The database is
#    unavailable while the export runs (seconds).
npx wrangler d1 export svbc-mailchimp-sync --remote --output <dir>/svbc-mailchimp-sync.sql

# 2. Reset. -y answers any wrangler confirmation prompt; unanswered without a TTY, one cancels
#    silently with exit 0.
npx wrangler d1 execute svbc-mailchimp-sync --remote -y --command \
  "DELETE FROM pending_outbound_syncs; DELETE FROM pending_inbound_syncs;"

# 2b. Only if the Mailchimp Campaigns board was rebuilt too (config's campaignsBoardId changes):
npx wrangler d1 execute svbc-mailchimp-sync --remote -y --command "DELETE FROM campaign_items;"

# 3. Check: 0 for each cleared table; dns_unsubscribes unchanged.
npx wrangler d1 execute svbc-mailchimp-sync --remote --command \
  "SELECT 'pending_outbound_syncs' AS t, COUNT(*) AS n FROM pending_outbound_syncs UNION ALL SELECT 'pending_inbound_syncs', COUNT(*) FROM pending_inbound_syncs UNION ALL SELECT 'campaign_items', COUNT(*) FROM campaign_items UNION ALL SELECT 'dns_unsubscribes', COUNT(*) FROM dns_unsubscribes"
```

Sandbox: `svbc-mailchimp-sync-sandbox`, with `--env sandbox` on every command.

| Table | Reset | Why |
|---|---|---|
| `pending_outbound_syncs` | cleared | Keyed on item ids from the old People boards. Dead rows skew the `failed`/`skipped` counts, and `redrive-dead-lettered.mjs` would replay them against items that are gone. |
| `pending_inbound_syncs` | cleared | Keyed on email, no item ids, but every `written` row records a connect-column write to the old board. The export keeps the list of addresses. |
| `campaign_items` | cleared **only if the Mailchimp Campaigns board was rebuilt** | Interest → Campaigns item. On a new board the old ids would be written into Donors' connect columns and the reconcile would never recreate the items; cleared, the next reconcile (the daily cron, or the first inbound event) creates one item per interest. If the board survived, keep the rows: clearing them makes the reconcile create a second item for every interest. |
| `dns_unsubscribes` | **kept** | The audit trail of unsubscribes that really happened in Mailchimp, which a board rebuild doesn't undo. Its guard is keyed on the email address, so it still stops a second Mailchimp call for the same person on the new board. `donor_item_id` in existing rows names the item on the old board; leave it (rows are never updated) and keep the export with the reset date, so pre-reset ids can be told apart. |

As on a first deploy, the Mailchimp Campaigns connect column on the new People board fills only
as audience webhooks arrive; nothing backfills it.

Tested 2026-09-30 on a copy of the sandbox database (the export from step 1 loaded into a
local D1): 6,122 outbound rows, 1 inbound row and 3 campaign items cleared, the 1
`dns_unsubscribes` row kept. Not run on the deployed sandbox D1, whose boards hadn't changed.

## Prerequisites before this can run against real data

**Mailchimp side (staff task):**
* Create six merge fields in the target audience: `MEMBSINCE`, `MEMBUNTIL`, `MTIER`,
  `MSTATUS`, `ADDRESS` (type: Address), `TOTALGIVE`. Mailchimp merge tags are capped at 10
  characters and silently truncate anything longer rather than erroring — `MEMBERSINCE`/
  `MEMBERUNTIL` (11 chars each) become `MEMBERSINC`/`MEMBERUNTI` if typed as-is, which then
  won't match `config/*.json`'s `mailchimp.mergeFields` and silently drops those two fields
  from every sync. Discovered provisioning the sandbox audience 2026-09-22; use the 9-char
  tags above instead. **Production: created 2026-10-30** through the API, with the sandbox
  audience's types (dates `MM/DD/YYYY`, `TOTALGIVE` a number, all non-public).
* **`LASTGIFT`** (type: Text, non-public) holds the donor's most recent gift as email copy, e.g.
  `$1,250` (whole dollars drop the cents), for the welcome email's "Thank you for your generous
  gift of `*|LASTGIFT|*`". It comes from People's **Last Gift Amount** column
  (`monday.columns.lastGiftAmount`, kept live by `donation-rollups` on every Donations change)
  through `mailchimp.mergeFields.lastGiftAmount`. Both are optional; either one `null` or absent
  leaves the merge field alone, and a blank column clears it. **Create the merge field in the
  audience before deploying a config that names it.** A contact gets it on their next sync, which a
  new gift triggers, so new members have it before the welcome Journey's first email; existing
  contacts fill in as they give again. It is not a receipt: receipts stay in Funraise or a personal
  email.
* Exclude the `do-not-solicit` tag from every fundraising send and Customer Journey audience.
* Exclude the `recurring-donor` tag from the renewal-reminder Customer Journey: it comes from People's
  **Has Active Recurring Gift** checkbox (`monday.columns.hasActiveRecurringGift`, kept nightly by
  `donation-rollups`), so someone whose recurring gift lapses starts getting reminders again. The column
  is optional in config; `null` or absent leaves the tag unsynced. It is a managed tag, so unchecking
  removes it. The tag appears on a contact's next sync after the change, so existing recurring
  donors were tagged once with `scripts/recurring-donor-backfill.mjs`, which applies the same rule
  to the whole People board (dry run by default; production run 2026-11-17: 391 tagged, 5 already
  were, none removed).
* Create one Interest Category (e.g. "Communications") with one Interest per campaign type:
  Newsletter, Welcome Drip, Renewal Reminders, and any others donors should be able to toggle
  independently, and put its id in `mailchimp.interestCategoryIds`. **Production (decided
  2026-10-30):** Welcome Drip (`be943454d9`) and Renewal Reminders (`986d6c84bf`) were added to
  the existing "Which SVBC emails would you like to subscribe to?" category (`760af5e2a0`, the
  id in `config/svbc.json`); its Monthly e-Bulletin interest already covers Newsletter. Only
  the listed categories are synced.
* **Production starts outbound-only** (decided 2026-10-30): `campaignsBoardId` stays `null` and
  the Mailchimp audience webhook isn't registered, so Monday → Mailchimp (merge fields, tags,
  Do Not Solicit unsubscribes) runs and Mailchimp → Monday (the Campaigns connect column, the
  inbound side's only job) doesn't. The nightly reconcile skips itself with one log line while
  no Campaigns board is configured. To turn inbound on later: build the Campaigns board and the
  People `mailchimpCampaigns` connect column, fill both ids, deploy, then register the audience
  webhook.
* **Journey interests are set by the outbound sync** (`mailchimp.journeyInterests`; `null` in the
  sandbox turns it off). Comparing a contact's tags before and after each sync
  (`journeyInterests()` in `src/consumer/mapDonor.ts`): Welcome Drip goes on when a contact first
  becomes a member (it held none of active/lapsed/lifetime-member and now gets active or lifetime),
  so only new members get the welcome series; Renewal Reminders goes on whenever it gains
  active-member, new or returning, unless tagged `renewal-opt-out`. On only, never off. It costs
  one tag read, and only for contacts the sync tags active or lifetime.
* `scripts/seed-journey-interests.mjs` covered members who existed before that: `--renewal`
  turned Renewal Reminders on for the 663 active members (2026-11-17), and `--undo-welcome
  --joined-before 2026-11-18` turned Welcome Drip back off for the 800 existing members seeded with
  it the same day. Both are dry runs by default. Trigger the welcome Journey on `MEMBSINCE` and the
  renewal Journey on `MEMBUNTIL`, never on "joins a group".
* **The `renewal-due` tag** (`mailchimp.renewalDue`, `src/renewalDue/`): the daily cron
  (`0 15 * * *`) tags every member tagged `active-member` whose Member Until is today or within
  `daysBefore` (28) days, in Pacific time, and untags everyone else who has it: renewed (the date
  moved out), lapsed or past. Mailchimp's own date trigger can't do this: it repeats every year on
  the field's month and day, and segments can't test a future date, so a Recurring-date Journey
  would remind members whose term runs past a year (148 of 801 on 2026-11-17) a year early, and
  lapsed members on every old anniversary. Start the renewal Journey on **Tag added:
  renewal-due**, and check the tag is still there before the 2-week and day-of emails, so a member
  who renews mid-way stops getting them. A member first seen inside the window (a late import) is
  tagged that day and gets the 4-week email late. Follows the write switch; counts-only logs.
* Build the welcome-drip and renewal-reminder Customer Journeys, each gated on its corresponding
  Interest, triggered off `MEMBSINCE`/`MEMBUNTIL` respectively. Renewal cadence: 28 and 14 days
  before `MEMBUNTIL` and on the day itself, which is what Salesforce's `Scheduled_Membership_Emails`
  flow sends today (read 2026-10-26; the original `membership-reminders` design's 42/28/14 came
  from workflow rules inactive since 2022). Like that flow, the renewal Journey must skip active
  recurring donors and the members marked Renewal Opt Out in Salesforce (611 at the 2026-10-26
  check), and neither is migrated. `scripts/renewal-opt-out.mjs` reads them from Salesforce (every
  email field on the Contact: 811 addresses, 758 in the production audience at the 2026-11-17 dry
  run), tags each member `renewal-opt-out` and, with `--interest 986d6c84bf`, turns Renewal
  Reminders off. Exclude that tag in the renewal Journey's audience as well as gating on the
  interest, so a later bulk re-seed of the interest can't put them back. Dry run by default.
  Salesforce never sent welcome email #2 (a flow bug), so decide whether the welcome
  Journey should.
* `scripts/port-salesforce-templates.mjs` copies the six templates the Salesforce flow sent
  (renewal 4 weeks / 2 weeks / day of, welcome #1–#3) into Mailchimp as custom-coded templates
  named "Membership renewal reminder: …" and "New member welcome #…". It maps the merge fields
  (`*|FNAME|*` with a "friend" fallback, `*|MEMBUNTIL|*`), repairs the merge field the 2-week
  template's pasted HTML had split (it sent "Dear :" from July 2026), drops welcome #1's gift
  amount and date (it predates `LASTGIFT`, above; new copy can use `*|LASTGIFT|*`), strips the utm_* tags from links Salesforce
  tagged as its own (utm_source=salesforce; turn on the Journeys' Google Analytics link tracking
  instead), and wraps each in the design system's
  EmailLayout (a slim letterhead-style black band with the hosted wordmark at 125px, 560px card) with the unsubscribe and
  address footer. It drops the near-black text colours, fonts and spacer paragraphs the Salesforce
  copy pinned, so the body takes the layout's ink and stays legible in dark mode.
  It prints each Salesforce subject line to set on the Journey email. A dry run writes the HTML to
  `salesforce-templates/` (gitignored); `--apply` creates the templates, or overwrites ones with
  the same name, so edit copy in Mailchimp only after the last `--apply`.
* Set up an audience webhook (Subscribes/Unsubscribes/Profile updates/Cleaned) pointed at this
  Worker's `/webhooks/mailchimp/audience`, with a secret in the URL, and leave Mailchimp's
  webhook "API" event source **unchecked** — otherwise this Worker's own writes back to Mailchimp
  (from the outbound side) can themselves trigger inbound webhook events, risking a feedback loop
  with the Donors-board webhook below.
* Tags are never written through the member body (Mailchimp's member `PUT`/`PATCH` schema has
  no writable `tags` field). Every `updateMember` follows its `PATCH` with a `syncTags` call to
  `POST /lists/{id}/members/{hash}/tags` — explicit `active`/`inactive` per tag, touching only
  the tags this Worker manages (`managedTags`), so staff- or other-tool-applied tags are never
  disturbed.
* **Nearby tags.** When `monday.columns.nearby` is set, each label in the People "Nearby"
  dropdown (written by `nearby-search`) becomes a tag `mailchimp.nearbyTagPrefix` + label
  (`"Near: Stevens Creek bikeway"`). Labels are 1-60 characters with no commas, so the column's
  text splits exactly on `", "`. They are open-ended, so between the merge-field `PATCH` and the
  tag sync `updateMember` reads the member's current tags (`GET /lists/{id}/members/{hash}/tags?count=1000`)
  and treats every one starting with the prefix as managed: a label removed on Monday is sent
  `inactive`, and the prefix is reserved for this Worker (a staff-made `Near: ...` tag would be
  cleared too). The read happens only when the column is configured, the Donor has an email and
  the `PATCH` found the member ([GL#97](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/97)), so a Donor who isn't in the audience costs no extra call. `nearby` is `null` in both configs until the column exists (set its id in
  `config/svbc.json` / `config/sandbox.json` to turn this on). Any People column change fires
  the Donors webhook, so editing Nearby flows through the normal outbound path.
  Set `monday.historical.columns.nearby` at the same time (`config/split.test.ts` fails on one
  without the other), so a person's labels sync from whichever board they're on.

**Monday side:**
* Donors board columns: Membership Status, Membership Tier, Member Since, Member Until, Address
  (addr1/city/zip, plus an optional State), Email — written by `salesforce-import`. With
  `monday.columns.state` set to `null` (production People has no State column) the ADDRESS
  merge field takes the state from the ZIP's first three digits (`src/consumer/zipState.ts`);
  a ZIP that isn't a 5-digit US one leaves ADDRESS out, as any incomplete address does.
* The Total Given / Last Gift rollup columns `donation-rollups` maintains.
* Do Not Solicit (checkbox) and DNS Reason Status (status) — both built by `salesforce-import`'s
  `configure` step — with a **Confirmed** label added to DNS Reason Status next to OK / Missing.
  Its text must match `dnsConfirmedValue` in `config/*.json`.
* **Subscription state is per email address, not per Donor** — and this Worker keys both
  directions on the Donors board's single `email` column: outbound updates that one address,
  and inbound resolves a Mailchimp contact back to a Donor by matching that column only. A
  Donor's **Secondary Email** (its own column since `salesforce-import`, with its own
  **Secondary Email Consent** status there) is neither pushed to Mailchimp nor matched on the
  way back, so an inbound webhook for a secondary address records as `skipped`. Covering the
  second column — a second email column id in config, `findItemIdByEmail` across both, and
  either a second connect column or a union of both addresses' interests — is a follow-up,
  not built.
* **Address changes made in Mailchimp** (`upemail` webhooks) are accepted and keyed on the new
  address, but this Worker doesn't rewrite the Donor's Email column — so until staff update it
  on Monday, the event records as `skipped` and later outbound updates for that Donor also skip
  (the old address is no longer in the audience).
* <a id="address-changes-made-on-monday"></a>**Address changes made on Monday** move the
  Mailchimp contact. The Donors webhook's `change_column_value` event carries the column's
  `previousValue`; for the configured Email column only, the route queues that old address with
  the Donor id, and the consumer renames the contact (`PATCH` with only `email_address`) before
  its usual update. Its status — subscribed, unsubscribed, cleaned — and tags and history carry
  over unchanged, so consent follows the person and nothing is ever created. No rename when the
  new address is already a contact (two contacts are never merged; the new one is updated as
  before), when the old address isn't one, when only case or spacing changed, or when another
  People or Historical item still holds the old address. That last check is a forgery guard: the
  old address comes from the webhook payload, so a leaked webhook secret could otherwise move any
  member. It protects anyone with a CRM record, not a Mailchimp-only contact. A refused move logs
  a warning and the update carries on by the new address, so a shared address needs moving by hand
  in Mailchimp. A permanent
  Mailchimp refusal is logged and the update carries on by the new address, as before this
  existed. Fixed 2026-11-02, after the cutover's Gate C check showed an edited address skipping
  (svbc-monday-migration cutover log, Mon 9:31 am). Edits made before this deploy aren't
  replayed: change the address in Mailchimp by hand.
* A "Mailchimp Campaigns" board, created once by staff (like every other board id in this repo —
  this Worker reconciles its *items* daily but does not create the board itself), plus a new
  connect-column on the Donors board pointed at it.
* A webhook subscription (`create_item` + `change_column_value`) on the Donors board and on
  People (Historical), pointed at `/webhooks/monday/donors`, with a secret in the URL. If Monday's webhook UI allows scoping to
  specific columns, exclude the `mailchimpCampaigns` connect-column from the watched columns —
  defense in depth against the inbound consumer's own write to that column re-triggering this
  webhook (the Worker also guards against this in code; see the design doc's feedback-loop note).
* Fill in every `REPLACE_WITH_*` placeholder in `config/svbc.json` once the above exist.

## Sandbox environment — inbound only, no outbound data

`npm run deploy:sandbox` deploys `svbc-mailchimp-sync-sandbox` (`wrangler.jsonc` `env.sandbox`)
against the CRM Sandbox People board and a **sandbox Mailchimp audience**, from
`config/sandbox.json` (chosen at request time by the `ENVIRONMENT` var — `src/environment.ts`).
Its own D1, queues (`mailchimp-sync-outbound-sandbox`, `mailchimp-sync-inbound-sandbox`, each
with a `-dlq`), and secrets. Local development against the sandbox uses `npm run dev:sandbox`; `npm run dev` targets the production config and, once production secrets exist in `.dev.vars`, would write to production sinks. The rule for this Worker: the sandbox may update contacts and
reconcile interests only in the sandbox audience — `config/split.test.ts` fails if the two
configs ever share `mailchimp.audienceId`, and the Mailchimp API key cannot enforce it (keys
are account-scoped), so that test is the guard. Sandbox-specific facts: the sandbox People board gained a `State`
text column on 2026-09-18 (the migrated boards had none). Production never got one, and its
`state` stayed `REPLACE_WITH_COLUMN_ID`: Monday silently ignores an unknown column id, so no
production contact got an ADDRESS until 2026-11-02, when `state: null` and the ZIP lookup
replaced it (config validation now rejects the placeholder for `state`); the sandbox "Mailchimp Campaigns (sandbox)"
board and the People board's "Mailchimp Campaigns" connect column were created 2026-09-18 by the
step 3 plan's Task 2.
Staff prerequisites before the first sandbox deploy (the step 3 plan's Task 15): the sandbox
audience with the six merge fields and the Interest Category, and its webhook pointed at the
sandbox Worker. `npm run deploy:sandbox` fails until `env.sandbox.d1_databases[0].database_id`
is replaced with the id `wrangler d1 create` prints. Design:
`../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.

**Workers Builds:** connect a second Worker, `svbc-mailchimp-sync-sandbox`, to this repo with
root directory `/mailchimp-sync`, production branch `main`, and deploy command
`npx wrangler deploy --env sandbox`. The sandbox then tracks `main` alongside production. If the
dashboard refuses two connections on one root directory, fall back to the
`deploy-sandbox` job in `../.github/workflows/workers.yml` — same command, gated on a
`CLOUDFLARE_API_TOKEN` `sandbox` environment secret so it stays inert until that secret is set.

## Deploying: the write switch

Every Mailchimp write (`updateMember`, `unsubscribeMember`), every Monday write (the connect
column, Campaigns-board create/rename/archive) and every D1 bookkeeping write a consumer or the
daily reconcile cron makes is gated by the shared write switch (spec
`../docs/superpowers/specs/2026-10-26-write-switch-design.md`, module `src/flags.ts`, a
byte-identical copy of `member-portal/src/flags.ts`; the dry-run deps are `src/writeSwitch.ts`),
read from the `FLAGS` KV namespace (`wrangler.jsonc` binds both namespace ids,
`FLAGS` and `sandbox-FLAGS`):

- `mailchimp-sync:writes` — `on` writes normally; `hold` writes nothing, keeps messages on the
  queues (retrying at 1 minute doubling to an hour) and skips the reconcile cron; `off` runs the
  consumers and the cron against recording proxies, logging one `"writeSwitch":"skipped"` line
  per would-be write and acking. **A missing key means `off`**; a KV read error behaves like
  hold. Inbound skip lines name the member by `<member HASH>`, never the address.
- `mailchimp-sync:log` — `debug` adds redacted payloads to those lines.

Both webhooks keep ingesting in every mode: under `off` the message is stamped dropped (so it is
never written even if the switch is `on` by the time it is consumed) and its pending row is
recorded `dropped`, as is any row a dry run consumes. Nothing re-enqueues pending rows
automatically (the only replay path is the manual `scripts/redrive-dead-lettered.mjs`, which
selects dead-lettered `failed` rows), so a `dropped` row is never revived. A message queued before
this build has no stamp and is written under `on`. The dead-letter consumers and their Slack alert
run in every mode. Both main queues now retry 100 times (1 minute doubling to an hour, raised to a
Retry-After; about four days) before dead-lettering. Set the switch with the operator CLI at the
repo root, never by hand — `writes hold`/`on` also pauses and resumes the queues:

```sh
node scripts/flags.mjs mailchimp-sync writes on --env sandbox     # or --env production
node scripts/flags.mjs status --env sandbox
```

**Set `writes on` before deploying** a build that carries the switch, or the deployed Worker
dry-runs everything.

## Local development

- `npm install` — install dependencies
- `npm test` — run the Vitest suite (D1-backed via `@cloudflare/vitest-plugin`, no live API calls)
- `npm run typecheck` — type-check with no emit
- `npm run dev` — run the Worker locally with `wrangler dev`
- `npm run deploy` — deploy with `wrangler deploy`
- `wrangler secret put MAILCHIMP_API_KEY` / `MONDAY_WEBHOOK_SECRET` /
  `MAILCHIMP_WEBHOOK_SECRET` — set secrets (never commit them). Neither webhook route works
  without its secret: both fail closed, 401ing every delivery (including the Monday challenge
  handshake) until the secret is set, rather than accepting unauthenticated requests.
  `SLACK_WEBHOOK_URL` is optional — dead-letter alerts, see [Dead letters](#dead-letters).
  Every secret is set again with `--env sandbox` for the sandbox deployment.
- **Monday.com GraphQL API** — from the `monday-auth` broker, not a stored token. Both deployments
  bind `MONDAY_AUTH` (`wrangler.jsonc` `services`) to its `SyncToken` entrypoint — the *SVBC Staff
  Sync* OAuth app — production (`svbc-mailchimp-sync`) to `svbc-monday-auth`, sandbox (`--env
  sandbox`) to `svbc-monday-auth-sandbox`; `src/monday/graphql.ts` `tokenProviderFor` asks it per
  request and re-asks once on a 401. A `MONDAY_API_TOKEN` secret is only the fallback while the
  cutover is under way (delete it once the binding works); with neither, building the Monday client
  throws a config error naming both. Operator scripts (`scripts/*.mjs`) keep reading
  `MONDAY_API_TOKEN` from the operator's shell. Local `wrangler dev` has no broker to call, so put a
  `MONDAY_API_TOKEN` in `.dev.vars` for it. Design:
  `docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md`.
- `wrangler d1 create svbc-mailchimp-sync` — provision D1, then fill the real `database_id` into
  `wrangler.jsonc`

## Related follow-on, not in this Worker

A donor-facing "communication preferences" UI in `donor-portal`, letting a donor toggle their own
Mailchimp Interests directly (writing to Mailchimp, not to Monday — this Worker's inbound side
picks up the resulting change on its own). See the design doc's closing section; the natural home
for that work is the existing `feat/donor-portal-comm-prefs` branch/worktree.
