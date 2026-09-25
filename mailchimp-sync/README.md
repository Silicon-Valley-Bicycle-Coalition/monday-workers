# mailchimp-sync

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
**Owner:** Unassigned.
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
   Given; tags: active/lapsed/lifetime-member, has-donated). **Update only — never creates a
   contact.** Mailchimp is the consent system of record, so a Donor whose address isn't already
   in the audience (they never opted in) is recorded as `skipped` and left out; the write is a
   `PATCH`, which 404s rather than creating, and never sends a `status`, so an unsubscribed or
   cleaned contact stays that way. People join the audience only through Mailchimp's own
   signup forms or the cutover consent import. **One exception, one-way:** a reviewed Do Not
   Solicit unsubscribes the contact — see [Do Not Solicit](#do-not-solicit) below.
2. **Campaign catalog reconciliation:** daily cron diffs Mailchimp's Interest Categories against a
   D1-tracked set of Monday items on the Campaigns board — creates, renames, or archives as
   needed. No webhook exists for "Interest Category changed" in Mailchimp, so this is polling, not
   a reliability fallback.
3. **Inbound:** Mailchimp subscribe/unsubscribe/profile event → webhook → D1 idempotency →
   Cloudflare Queue → resolve the contact's current interests to Campaigns-board item ids → write
   the full current set to the Donor's connect column.

**Retries.** A failed queue message is retried with exponential backoff — 1, 4, then 16 minutes
across the queue's 3 retries — before landing in its `-dlq` dead-letter queue. When Mailchimp
(429, `Retry-After`) or Monday (`retry_in_seconds`, `Retry-After`) says how long to wait, the
retry waits at least that long; Monday's `DAILY_LIMIT_EXCEEDED` with no hint waits until
midnight UTC. Every delay is capped at Queues' 12-hour maximum. A permanent Mailchimp rejection
(malformed address, other 4xx) on the outbound side is acked instead, since it would fail
identically every time.

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
   and it stops later column changes on the same person from calling Mailchimp again.

Deliberate limits:
* **Never resubscribes.** Unchecking the box, or moving the status off Confirmed, removes the
  tag but leaves the unsubscribe in place; only the person can opt back in, through Mailchimp.
* **Personal Email only.** The Household Email may be shared by other people in the household,
  so it is never unsubscribed on one person's flag (it isn't synced at all yet — see below).
* **People board only.** People (Historical) and Organizations carry the same columns but
  aren't watched by this Worker.
* **Nothing flows back.** An unsubscribe that starts in Mailchimp doesn't check Do Not Solicit.

## Prerequisites before this can run against real data

**Mailchimp side (staff task):**
* Create six merge fields in the target audience: `MEMBSINCE`, `MEMBUNTIL`, `MTIER`,
  `MSTATUS`, `ADDRESS` (type: Address), `TOTALGIVE`. Mailchimp merge tags are capped at 10
  characters and silently truncate anything longer rather than erroring — `MEMBERSINCE`/
  `MEMBERUNTIL` (11 chars each) become `MEMBERSINC`/`MEMBERUNTI` if typed as-is, which then
  won't match `config/*.json`'s `mailchimp.mergeFields` and silently drops those two fields
  from every sync. Discovered provisioning the sandbox audience 2026-09-22; use the 9-char
  tags above instead.
* Exclude the `do-not-solicit` tag from every fundraising send and Customer Journey audience.
* Create one Interest Category (e.g. "Communications") with one Interest per campaign type:
  Newsletter, Welcome Drip, Renewal Reminders, and any others donors should be able to toggle
  independently.
* Build the welcome-drip and renewal-reminder Customer Journeys, each gated on its corresponding
  Interest, triggered off `MEMBSINCE`/`MEMBUNTIL` respectively. Recommended renewal cadence:
  42/28/14 days before `MEMBUNTIL` (carried forward from the original `membership-reminders`
  design).
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

**Monday side:**
* Donors board columns: Membership Status, Membership Tier, Member Since, Member Until, Address
  (addr1/city/state/zip), Email — written by `salesforce-import`.
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
text column on 2026-09-18 (the migrated boards had none — the production People board will need
one too before this Worker can send the ADDRESS merge field, which `src/consumer/mapDonor.ts`
omits unless all four address parts are present); the sandbox "Mailchimp Campaigns (sandbox)"
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

## Local development

- `npm install` — install dependencies
- `npm test` — run the Vitest suite (D1-backed via `@cloudflare/vitest-plugin`, no live API calls)
- `npm run typecheck` — type-check with no emit
- `npm run dev` — run the Worker locally with `wrangler dev`
- `npm run deploy` — deploy with `wrangler deploy`
- `wrangler secret put MONDAY_API_TOKEN` / `MAILCHIMP_API_KEY` / `MONDAY_WEBHOOK_SECRET` /
  `MAILCHIMP_WEBHOOK_SECRET` — set secrets (never commit them). Neither webhook route works
  without its secret: both fail closed, 401ing every delivery (including the Monday challenge
  handshake) until the secret is set, rather than accepting unauthenticated requests.
- `wrangler d1 create svbc-mailchimp-sync` — provision D1, then fill the real `database_id` into
  `wrangler.jsonc`

## Related follow-on, not in this Worker

A donor-facing "communication preferences" UI in `donor-portal`, letting a donor toggle their own
Mailchimp Interests directly (writing to Mailchimp, not to Monday — this Worker's inbound side
picks up the resulting change on its own). See the design doc's closing section; the natural home
for that work is the existing `feat/donor-portal-comm-prefs` branch/worktree.
