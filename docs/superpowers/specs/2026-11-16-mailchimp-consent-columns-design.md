# mailchimp-sync: keep the Email Consent columns current

**Status:** Design, approved approach (2026-11-16). Branch `feat/mailchimp-consent-sync`.
**Affects:** `mailchimp-sync` only (a new hourly cron path), plus `scripts/mark-read-only-columns.mjs`.
**Builds on:** `2026-09-08-person-org-email-model-design.md` ("Consent and `mailchimp-sync`"),
`2026-11-09-sponsor-outreach-board-design.md` ("Prerequisite: Work Email Consent must be current").

## Why

Monday has five consent columns, one per address column:

| Board | Address column | Consent column |
|---|---|---|
| People, People (Historical) | Personal Email | Personal Email Consent |
| People, People (Historical) | Household Email | Household Email Consent |
| Affiliations | Work Email | Work Email Consent |

Each is a status column (Subscribed / Unsubscribed / Cleaned / Not in Mailchimp). `salesforce-import`
filled all five once at cutover from a Mailchimp export, and nothing has updated them since.
Mailchimp is the consent system of record (decided 2026-08-21), and Salesforce's opt-out flags
were not migrated.

The Sponsor Outreach send (Martha's Gmail, recipients from Affiliations) excludes Work Email
Consent = Unsubscribed or Cleaned and re-reads the column at send time. David decided on
2026-11-09 that `mailchimp-sync` must keep that column current before the send page goes live,
rather than having the send ask Mailchimp. On 2026-11-16 he widened that to the two People
consent columns, so staff reading any consent column see Mailchimp's current state.

## Goals

* Every consent column reflects Mailchimp's current status for that column's address, within an
  hour.
* The first run brings the cutover snapshot current (the backfill), with no separate script.
* An address entered or changed on Monday gets its consent filled on the next run.
* An opt-out is never lost: nothing this sync does may turn an address Mailchimp won't email into
  one Monday says may be emailed.

## Non-goals

* No change to who is in Mailchimp. This path only reads Mailchimp and writes Monday.
* No Mailchimp audience webhook in production, and no change to the inbound consumer (the
  connect-column path). Production stays outbound-only for Mailchimp → Monday events, as decided
  2026-10-30.
* No consent for Organizations' email columns or People's Other Emails (no consent column exists).
* Do Not Solicit is untouched; an unsubscribe in Mailchimp still doesn't check it (README, "Nothing
  flows back").

## Approaches considered

1. **Hourly full reconcile (chosen).** A cron reads the whole audience and the five address /
   consent column pairs, and writes only differences. Stateless, self-healing, its first run is
   the backfill, and it covers addresses staff add on Monday. Cost: up to an hour of lag, which a
   manually started sponsor send tolerates (the legal window to honor an unsubscribe is 10
   business days).
2. **Audience webhook + nightly reconcile.** Minutes-fresh, but needs the production audience
   webhook registered, the inbound consumer made to work without a Campaigns board, and a per-event
   lookup across three boards and five columns. About twice the code for freshness the send
   doesn't need. Can be added later on top of 1 if an hour proves too slow.
3. **Webhook + one-time backfill.** Rejected: misses every event dropped under the write switch's
   `off`, and never fills consent for addresses added on Monday.

## What Mailchimp actually holds (production, read 2026-11-16)

* Audience `eab542a5df`: 23,032 subscribed, 145 unsubscribed, 12,436 cleaned, 4 transactional,
  and **25,439 archived**. `GET /lists/{id}/members` leaves archived contacts out unless asked
  with `status=archived`.
* ~6,350 Monday consent values say Unsubscribed where Mailchimp now says **archived** (2,671
  archived in 2026-11, 14,538 in 2025-09). Archiving hides the contact's prior status. Reading
  those as "Not in Mailchimp" would mark thousands of opt-outs as sendable.
* Real drift, archived treated as below: ~30 Subscribed → Unsubscribed/Cleaned, ~60 Not in
  Mailchimp → Subscribed, ~50 blanks to fill (People and Historical); on Affiliations, 1 blank.
  372 Affiliations have a Work Email, none shared between Affiliations; 12 are also someone's
  Personal or Household Email.

## Status mapping

Mailchimp status for the address (lowercased, trimmed), to the label written:

| Mailchimp | Label |
|---|---|
| `subscribed` | Subscribed |
| `unsubscribed` | Unsubscribed |
| `cleaned` | Cleaned |
| `archived` | **Cleaned if the column already says Cleaned, otherwise Unsubscribed** |
| `pending`, `transactional` | **the existing value if it is Unsubscribed or Cleaned, otherwise Not in Mailchimp** |
| absent from the audience (all statuses read, archived included) | **the existing value if it is Unsubscribed or Cleaned, otherwise Not in Mailchimp** |

* Archived → Unsubscribed is the opt-out-preserving reading: Mailchimp won't send to an archived
  contact, and re-adding one needs the person's consent. *(My call, put to David with the approaches on 2026-11-16; he chose the approach without
  objecting to it.)*
* Absence never lifts an opt-out (added 2026-11-16, from the build's security review). Offset
  paging can skip a member when another is archived or deleted mid-read, and a contact deleted
  outright from Mailchimp leaves no status. Either would otherwise read as "Not in Mailchimp",
  which may be emailed. The reader also treats a `total_items` that changes between pages as a
  short read. *(My call.)*
* `pending` (double opt-in not confirmed) and `transactional` carry no marketing consent, so
  "Not in Mailchimp" fits, except that neither lifts an existing opt-out: an unsubscribed person
  who resubmits a signup form and never confirms stays Unsubscribed. *(My call; tightened
  2026-11-16 after the branch review.)*
* An item whose address column is blank keeps whatever its consent column says. *(My call,
  revised 2026-11-16 after the first production dry run: ~980 items have no address but carry a
  cutover consent value, mostly Not in Mailchimp. Clearing them would trip the cap on the first
  run, and there is nothing to send to.)*
* Consent is per address, so an address on several items (a shared Household Email; a work
  address that's also someone's Personal Email) writes the same label to each item's column.
  No ownership rule is needed. The one exception is the archived rule, which reads each item's
  current label, so two items sharing an archived address may keep Cleaned on one and get
  Unsubscribed on the other; both are non-sendable, so that's accepted. *(My call.)*

## Design

A new module, `src/consent/` (names are the builder's), run from `scheduled()`:

1. **Read Mailchimp.** Page `GET /lists/{audienceId}/members?count=1000&fields=total_items,
   members.email_address,members.status` twice: once default (subscribed / unsubscribed /
   cleaned / pending / transactional) and once `status=archived`. Build `address → status`.
   Check each pass read exactly `total_items` members; otherwise abort the run, writing nothing,
   and alert (a short read would turn real opt-outs into "Not in Mailchimp").
2. **Read Monday.** For each configured board, page every item with only the configured address
   and consent column ids (`items_page` / `next_items_page`, 500 per page) through the existing
   `HttpMondayClient` and the shared GraphQL transport.
3. **Plan.** For each item and each of its pairs, compute the desired label from the mapping
   above and compare it with the current label text; collect only differences.
4. **Guard, split by direction** *(David, 2026-11-16)*. Changes **to Unsubscribed or Cleaned**
   are always written: they can only stop mail. Changes toward a sendable value (to Subscribed,
   or to Not in Mailchimp) are capped by `consent.maxChangesPerRun` (config;
   500 in both environments, above the ~150 expected on the first production run). Over the cap,
   the run writes only the non-sendable changes, skips every sendable one, logs an error with the
   counts by transition, and alerts. An operator raises the cap deliberately if a large change is
   real.
5. **Write.** `change_multiple_column_values` per item (all of that item's changed consent
   columns in one call), several items aliased per request. A failed item is logged and counted;
   the rest carry on, and the next hour retries it.
6. **Alert.** A tripped cap, a failed or short Mailchimp read, a board that couldn't be read, or
   any failed item write posts one line to Slack through the
   existing `sendAlert` / `SLACK_WEBHOOK_URL` (unset: log only), once per run, counts only.
7. **Log** one summary line: items read per board, changes by board and transition, writes
   succeeded and failed, mode. Never an email address or a person's name; item ids and counts
   only (the `log-safety` CI check applies).

**Schedule.** A second cron trigger, hourly at minute 5 (`5 * * * *`), in both environments;
the existing daily `0 15 * * *` stays the Campaigns reconcile. `scheduled()` dispatches on
`event.cron`. The two are independent: one failing doesn't stop the other. The hourly run does
nothing (one log line) while `consent.enabled` is false.

**Config** (`config/svbc.json`, `config/sandbox.json`, validated in `src/config.ts`): a new
`consent` block: `enabled`, the boards and their address → consent column pairs, and
`maxChangesPerRun`. `enabled` is true in the sandbox and **false in production** until David's
go-ahead (see Rollout). Ids:

| | Production | Sandbox (v4) |
|---|---|---|
| People | `18437909781`: `email_mm8nx6qg` → `color_mm8ntb35`, `email_mm8n2wzk` → `color_mm8nh158` | `18437342592`: `email_mm8h4kkb` → `color_mm8h9ee2`, `email_mm8hj3f8` → `color_mm8hkgaa` |
| People (Historical) | `18437909784`: `email_mm8nfyfc` → `color_mm8ngfkm`, `email_mm8np26g` → `color_mm8nz8gk` | `18437342607`: `email_mm8h8jbh` → `color_mm8h4dfr`, `email_mm8hzsdg` → `color_mm8hmyx1` |
| Affiliations | `18437909787`: `email_mm8ndy69` → `color_mm8nb7dq` | `18437342615`: `email_mm8h6cxh` → `color_mm8hz58t` |

`config/split.test.ts` extends to the new board ids (production and sandbox must not share one).
Board and column ids come from config, never from titles; any title lookup a script adds goes
through `bareTitle`.

**Write switch** (`mailchimp-sync:writes`, existing): `on` writes; `off` runs the whole read and
plan and logs a `"writeSwitch":"skipped"` line per would-be item write through the existing
recording proxy (`dryRunMonday` gains the new write method); `hold` / `unknown` skip the run.
Stateless, so there is no cursor to protect: the next `on` run writes whatever still differs.

**Monday access:** the existing `MONDAY_AUTH` → `SyncToken` binding. The Staff Sync app's user
must reach Affiliations (private board): check with
`node scripts/check-monday-token-scope.mjs` before the sandbox deploy, and subscribe the
integration user to the board if not.

**Side effects on other webhooks.** Writing a People consent column fires People's
`change_column_value` webhooks. `mailchimp-sync`'s own outbound route skips it (consent columns
aren't in `donorColumnIds`); other Workers watching People (`people-reclassification`,
`contact-roles` on Affiliations) must also ignore it. The builder confirms each skips columns it
doesn't read before the first production run; the first run writes ~150 items, later runs a few.

**Column markers.** Add the five consent columns to `MARKED_COLUMNS` as 🔒 (People, People
(Historical), Affiliations) and re-run `scripts/mark-read-only-columns.mjs` on production and
sandbox, so staff see they're Worker-owned (an edit is overwritten within the hour).

**Operator plan script** *(David, 2026-11-16)*: `scripts/consent-plan.mjs` (inside
`mailchimp-sync`, importing the Worker's own modules through Node type stripping, like its other
`.mjs` scripts) runs steps 1-3 locally with `MAILCHIMP_API_KEY` and `MONDAY_API_TOKEN` from the
operator's shell and `--env sandbox|production`, prints the transition counts per board and
column, and writes nothing. It's how production is rehearsed: the Worker-wide write switch can't
be set to `off` there without dropping live outbound syncs.

**Limits.** ~60 Mailchimp GETs and ~50 Monday reads per run, plus writes: well under a Worker's
subrequest limit and the cron's 15-minute wall clock. Monday complexity per run is small next to
the hourly budget; the transport already backs off on 429s. **CPU:** `limits.cpu_ms` rises from
100 to 1,000 in both environments *(David, 2026-11-16)*, as `contact-roles` and
`people-reclassification` have. The cap is per Worker, so the public webhook routes get the same
looser cap; accepted rather than splitting the cron into its own Worker. Measure a real run's CPU
time in the sandbox (Workers Logs `cpuTime`) and record it in the README; the sandbox audience is
small, so also time the plan script against production to estimate.

## Rollout

1. Build test-first in `mailchimp-sync`; README section "Consent columns"; root README status line.
2. Sandbox: check token scope, run the plan script, deploy (`enabled: true`); confirm a
   sandbox-audience unsubscribe appears on the matching sandbox item within an hour, and a blank
   consent fills. The sandbox write switch can be flipped freely there.
3. Production, on David's go-ahead only: the same build deploys with `enabled: false`, so
   merging and deploying changes nothing but the CPU cap. Run the plan script against
   production and show David the transitions (expect ~150, and no Unsubscribed → Not in
   Mailchimp). On his yes, set `enabled: true`, deploy, watch the first hourly run's summary,
   then add the 🔒 markers. The write switch stays `on` throughout.

Note: `mailchimp-sync` has been deployed to production since at least 2026-11-14 and is writing
(`docs/runbooks/migration-hold.md`); the README's "not deployed" status line is stale, and this
work corrects it.

## Left to the builder

Module and type names; how many items per aliased write request; the summary log's exact shape;
whether the Mailchimp pages run sequentially or a few at a time.
