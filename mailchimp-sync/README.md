# mailchimp-sync

**Staff UAT script:** [`docs/uat/mailchimp-sync.md`](../docs/uat/mailchimp-sync.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status:** Built — repurposed from the never-deployed `membership-reminders` (2026-08-26). Not
deployed to production; blocked on the same Donors-board prerequisite as everything else
downstream of `salesforce-import`, plus a Mailchimp audience with the merge fields/Interest
Categories below. **Sandbox provisioned and verified 2026-09-22**: `svbc-mailchimp-sync-sandbox`
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

Three independent flows — see the design doc for full sequence diagrams:

1. **Outbound:** Donor column change on Monday → webhook → D1 idempotency → Cloudflare Queue →
   Mailchimp contact update (merge fields: Member Since/Until, Tier, Status, Address, Total
   Given; tags: active/lapsed/lifetime-member, has-donated). A change to a column the sync doesn't
   read (`donorColumnIds` in `src/monday/client.ts`) is skipped at the webhook, so a bulk write to
   another People column, like the 2026-11-03 Location backfill, sends nothing to Mailchimp. **Update only — never creates a
   contact.** Mailchimp is the consent system of record, so a Donor whose address isn't already
   in the audience (they never opted in) is recorded as `skipped` and left out; the write is a
   `PATCH`, which 404s rather than creating, and never sends a `status`, so an unsubscribed or
   cleaned contact stays that way. People join the audience only through Mailchimp's own
   signup forms or the cutover consent import. **One exception, one-way:** a reviewed Do Not
   Solicit unsubscribes the contact — see [Do Not Solicit](#do-not-solicit) below. **An Email
   change moves the contact:** when staff change a Donor's Email column, the old address's
   contact is renamed to the new one, so its consent and history follow the person — see
   [Address changes made on Monday](#address-changes-made-on-monday).
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
   the full current set to the Donor's connect column.

**Retries.** A failed queue message is retried with exponential backoff — 1, 4, then 16 minutes
across the queue's 3 retries — before landing in its `-dlq` dead-letter queue. When Mailchimp
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
(#37, `src/consumer/deadLetters.ts`). A dead message calls neither Monday nor Mailchimp — it:

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
  tag but leaves the unsubscribe in place; only the person can opt back in, through Mailchimp.
* **Personal Email only.** The Household Email may be shared by other people in the household,
  so it is never unsubscribed on one person's flag (it isn't synced at all yet — see below).
* **People board only.** People (Historical) and Organizations carry the same columns but
  aren't watched by this Worker.
* **Nothing flows back.** An unsubscribe that starts in Mailchimp doesn't check Do Not Solicit.

## Resetting for new board ids

When the People board is deleted and rebuilt (a cutover retry — private runbook, Rollback step 8
— or a sandbox rebuild), D1 still describes the old board's items. Reset it before deploying
against the new boards.

**First:** disable the Monday Donors webhook and the Mailchimp audience webhook, and delete or
archive the old boards (while the old Mailchimp Campaigns board exists, the daily reconcile on
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
| `pending_outbound_syncs` | cleared | Keyed on People item ids from the old board. Dead rows skew the `failed`/`skipped` counts, and `redrive-dead-lettered.mjs` would replay them against items that are gone. |
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
* Exclude the `do-not-solicit` tag from every fundraising send and Customer Journey audience.
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
* Build the welcome-drip and renewal-reminder Customer Journeys, each gated on its corresponding
  Interest, triggered off `MEMBSINCE`/`MEMBUNTIL` respectively. Renewal cadence: 28 and 14 days
  before `MEMBUNTIL` and on the day itself, which is what Salesforce's `Scheduled_Membership_Emails`
  flow sends today (read 2026-10-26; the original `membership-reminders` design's 42/28/14 came
  from workflow rules inactive since 2022). Like that flow, the renewal Journey must skip active
  recurring donors and the members marked Renewal Opt Out in Salesforce (611 at the 2026-10-26
  check), and neither is migrated. Leave those 611 out of the Renewal Reminders interest when you
  seed it. Salesforce never sent welcome email #2 (a flow bug), so decide whether the welcome
  Journey should.
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
  text splits exactly on `", "`. They are open-ended, so before `updateMember` the consumer reads
  the member's current tags (`GET /lists/{id}/members/{hash}/tags?count=1000`) and treats every
  one starting with the prefix as managed: a label removed on Monday is sent `inactive`, and the
  prefix is reserved for this Worker (a staff-made `Near: ...` tag would be cleared too). The
  read happens only when the column is configured, the Donor has an email and the update is
  about to run. `nearby` is `null` in both configs until the column exists (set its id in
  `config/svbc.json` / `config/sandbox.json` to turn this on). Any People column change fires
  the Donors webhook, so editing Nearby flows through the normal outbound path.
  **Limit:** only the People board is watched. People (Historical) items get Nearby labels
  too but are not synced to Mailchimp until this Worker watches that board
  (svbc-monday-workers#83).

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
  before), when the old address isn't one, or when only case or spacing changed. A permanent
  Mailchimp refusal is logged and the update carries on by the new address, as before this
  existed. Fixed 2026-11-02, after the cutover's Gate C check showed an edited address skipping
  (svbc-monday-migration cutover log, Mon 9:31 am). Edits made before this deploy aren't
  replayed: change the address in Mailchimp by hand.
* A "Mailchimp Campaigns" board, created once by staff (like every other board id in this repo —
  this Worker reconciles its *items* daily but does not create the board itself), plus a new
  connect-column on the Donors board pointed at it.
* A webhook subscription (`create_item` + `change_column_value`) on the Donors board, pointed at
  `/webhooks/monday/donors`, with a secret in the URL. If Monday's webhook UI allows scoping to
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
`deploy-sandbox:mailchimp-sync` job in `../.gitlab-ci.yml` — same command, gated on a
`CLOUDFLARE_API_TOKEN` CI variable so it stays inert until that variable is set.

## Deploying: the write switch

Every Mailchimp write (`updateMember`, `unsubscribeMember`), every Monday write (the connect
column, Campaigns-board create/rename/archive) and every D1 bookkeeping write a consumer or the
daily reconcile cron makes is gated by the shared write switch (spec
`../docs/superpowers/specs/2026-10-26-write-switch-design.md`, module `src/flags.ts`, a
byte-identical copy of `member-portal/src/flags.ts`; the dry-run deps are `src/writeSwitch.ts`),
read from the `FLAGS` KV namespace (`wrangler.jsonc`; the ids are placeholders until the
namespaces exist):

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
