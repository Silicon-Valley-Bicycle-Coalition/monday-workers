# mailchimp-sync: design

**Status:** Approved for implementation (2026-08-26, revised same day — see revision note below).
**Supersedes:** [`2026-08-22-membership-reminders-design.md`](2026-08-22-membership-reminders-design.md).
`membership-reminders` was built and merged but never deployed — no production usage, no data, no
migration cost — so this replaces its approach rather than extending it.
**Repurposes:** the `membership-reminders/` Worker directory, renamed `mailchimp-sync/`.
**Related follow-on, out of scope here:** a donor-facing "communication preferences" UI in
`donor-portal` (see bottom of this doc) — depends on decisions made here, spec'd separately.

**Revision note:** the first pass of this design covered only Monday → Mailchimp (feeding
Mailchimp's Journeys and segments). Two things extended it same-day, before any code was written:
(1) Mailchimp's `location` lat/long is IP-geolocation-derived, not something to write a mailing
address's coordinates into — corrected in favor of an `ADDRESS`-type merge field; (2) staff also
want campaign/journey membership visible on the Donor's Monday item, and a future donor-portal
unsubscribe UI — both require a **reverse** sync (Mailchimp → Monday) alongside the original
direction. Both are folded in below; no code existed yet, so this is a design revision, not a
migration.

## The ask

Three originally-separate requests turned out to share one underlying gap:

1. **The 3-stage new-member welcome drip** — Salesforce's other membership email automation,
   flagged in `membership-reminders/README.md`'s "Deliberately not in v1" as a follow-up ("same
   machinery would work... trigger on Member Since instead of Member Until... but it's a separate
   decision and separate templates").
2. **SVBC's existing Mailchimp newsletter segmentation** (by city, by prior-donation history) is
   currently fed from Salesforce. That feed breaks at Salesforce retirement — the same
   "stops working at cutover" urgency the plan already flagged for renewal reminders, just one
   layer upstream.
3. **Staff want to see, per donor, which Mailchimp campaigns/journeys they're part of, on the
   Monday board** — and, eventually, let a donor manage that themselves in `donor-portal` (opt out
   of specific campaigns, not just a blanket unsubscribe).

All three reduce to: **nothing keeps Monday.com and Mailchimp in sync with each other**, in either
direction, now that Monday is the post-migration source of truth for donor data. Once that sync
exists — both ways — the welcome drip, renewal reminders, newsletter segments, staff visibility,
and the future donor-portal preference UI are all built on top of it, not separate builds.

## Decision history

* **Rejected: Monday.com native Mailchimp integration.** Confirmed against
  [Monday's own docs](https://support.monday.com/hc/en-us/articles/360002427080-Mailchimp-Integration)
  (2026-08-26): its four templates only push a bare email address into a Mailchimp list
  (*"if you have other required fields in Mailchimp (merge fields)... the template will not
  work"*), or run in the wrong direction (Mailchimp → Monday, for campaign stats / new
  subscribers). No template maps arbitrary Monday columns to Mailchimp merge fields, and none
  reflect Mailchimp state back onto arbitrary Monday columns either. Not a config problem; a
  capability gap in both directions.
* **Rejected: keep `membership-reminders` as a Worker-driven sender, add welcome drip alongside
  it.** Would mean maintaining two different mechanisms for functionally identical problems, and
  leaves the Mailchimp segmentation and staff-visibility gaps unsolved regardless.
* **Chosen: a bidirectional sync Worker + Mailchimp Customer Journeys/Interest Categories.** SVBC
  is on Mailchimp Standard/Premium (Journey date-triggers available). Staff already maintains
  Mailchimp templates for the newsletter, so timing and copy living there — not in this repo — is
  a net reduction in future maintenance burden. This repo's job is keeping data current in both
  directions; content and targeting logic live in Mailchimp, staff-owned.
* **Corrected: geographic targeting uses an `ADDRESS` merge field, not raw lat/long.** Mailchimp's
  per-contact `location` object (latitude/longitude) is populated from IP geolocation at signup/
  engagement time — not designed to be overwritten with a mailing address's geocoded coordinates,
  and API discussions describe exactly that kind of write as unreliable. Mailchimp's "is within X
  miles" segment condition instead reads an `ADDRESS`-type merge field (`addr1`/`city`/`state`/
  `zip`), which Mailchimp geocodes internally — `salesforce-import` already has the full mailing
  address as an input to its own geocoding step, so this needs no new data, just a different
  merge-field shape than originally planned. **Not yet verified against a live Mailchimp
  account/API key** — confirm before relying on it once credentials exist.
* **Chosen: Interest Categories as the single mechanism for campaign/journey membership,** serving
  both staff visibility (this design) and the future donor-portal opt-out UI. Model every campaign
  type — not just the newsletter, but also the welcome drip and renewal reminders — as a Mailchimp
  Interest Category entry, and gate each Journey's entry condition on that interest. A donor
  toggling an interest off (via donor-portal, later) removes them from the corresponding Journey
  too, not just a display flag — one source of truth instead of two.
* **Chosen: an auto-generated "Mailchimp Campaigns" Monday board**, not staff-maintained. Rejected
  a manually-maintained board — campaigns/interests change quarterly, and manual upkeep drifts
  stale. A daily reconciliation cron keeps it current instead (see below).
  **Correction (post-implementation review, 2026-08-26):** only the board's *items* are
  auto-reconciled daily, as designed and implemented in `reconcile.ts`. The board itself is not
  auto-created — no `createBoard` call was ever built, and doing so is out of scope for this fix
  wave (unverified against a live Monday account). Staff creates the "Mailchimp Campaigns" board
  once, the same way every other board id in this repo is provisioned, and fills its id into
  `config/svbc.json`'s `monday.campaignsBoardId`.

## Scope recap

* **Retire:** `membership-reminders`'s cron, email composition, and template code
  (`dates.ts`, `filter.ts`, `reminders.ts`, `templates.ts`, `email.ts` and their tests) — timing
  and copy for both renewal reminders and the welcome drip move to Mailchimp Journeys, staff-owned.
* **Build — outbound (Monday → Mailchimp):** webhook-driven sync of Donor merge fields/tags,
  following this repo's standard shape (root `README.md`'s Reliability section), same as
  `donation-rollups`.
* **Build — inbound (Mailchimp → Monday):** webhook-driven sync of a contact's current Interest
  memberships onto a connect-column on their Donor item, pointing at Campaigns-board items.
* **Build — campaign catalog reconciliation:** a daily cron that keeps the Campaigns board's items
  in sync with Mailchimp's actual Interest Categories/Interests (create, rename, archive).
* **Carry forward, not re-decide:** the existing 42/28/14-day renewal cadence, documented as the
  recommended starting Journey configuration even though it's no longer enforced by code.

## Data flow

### 1. Outbound: Donor data → Mailchimp

```
Donors board (Monday.com)
  │  webhook, on item create / column change (Membership Status, Membership Tier,
  │  Member Since, Member Until, Address fields, Email, and the Total Given / Last Gift
  │  rollup columns donation-rollups already maintains)
  ▼
Cloudflare Worker (webhook handler, src/webhook/outboundRoute.ts)
  │  1. echo the challenge verbatim during webhook-subscription setup (one-time handshake)
  │  2. validate the shared secret embedded in the webhook URL (Monday doesn't sign
  │     payloads — same convention as donation-rollups)
  │  3. upsert into D1 `pending_outbound_syncs`, keyed on the Donor item id — a later
  │     event for the same item replaces the pending row instead of queuing a duplicate
  │  4. enqueue a Cloudflare Queue message referencing the item id
  ▼
Cloudflare Queue (mailchimp-sync-outbound) → consumer
  │  1. fetch the item's current column values fresh from Monday (not from the webhook
  │     payload — avoids acting on stale values if multiple edits landed before the
  │     queue drained)
  │  2. no email column value → skip and ack (not a retry candidate; same pattern as
  │     donation-rollups' "no owner linked yet")
  │  3. map columns to Mailchimp merge fields (MEMBERSINCE, MEMBERUNTIL, MTIER, MSTATUS,
  │     ADDRESS, TOTALGIVE) and tags (active-member / lapsed-member, lifetime-member,
  │     has-donated)
  │  4. PUT the contact via Mailchimp's list-member upsert endpoint (creates or updates
  │     in one call — no separate "does this contact exist" check needed)
  │  on failure: a transient error (429, 5xx) throws and lets Queues retry automatically
  │  (3 attempts) then route to a Dead Letter Queue; a permanent error (400 invalid
  │  email format) logs and acks — retrying it would just fail the same way forever
  ▼
Mailchimp audience (merge fields + tags updated)
  │
  ▼
Mailchimp Customer Journeys (staff-configured, not in this repo)
  • Welcome drip — 3 stages off MEMBERSINCE, gated on the "Welcome Drip" interest
  • Renewal reminders — 3 stages off MEMBERUNTIL, recommended at 42/28/14 days (the
    existing cadence), gated on the "Renewal Reminders" interest
  • Existing newsletter segments (by ADDRESS distance, by has-donated tag) — no longer
    dependent on the Salesforce feed
```

### 2. Campaign catalog reconciliation (new — keeps the lookup board honest)

```
Daily Cron Trigger
  ▼
Cloudflare Worker (scheduled handler, src/campaigns/reconcile.ts)
  │  1. fetch all Interest Categories + Interests from Mailchimp
  │  2. diff against D1 `campaign_items` (keyed on Mailchimp's stable interest_id, not
  │     name — names can be edited without changing identity)
  │  3. new interest, not in the table → create a Monday item on the Campaigns board,
  │     record its item id in `campaign_items`
  │  4. interest gone from Mailchimp, still tracked → archive the Monday item (not
  │     delete — preserves donors' historical connections to it) and mark the row
  │     archived in `campaign_items`
  │  5. interest renamed → matched by interest_id; update the Monday item's name,
  │     no duplicate created
  ▼
"Mailchimp Campaigns" board (Monday.com) — one item per Interest, auto-maintained
```

### 3. Inbound: Mailchimp contact state → Monday

```
Mailchimp audience
  │  webhook, on subscribe / unsubscribe / profile update / cleaned (Mailchimp Marketing
  │  webhooks aren't cryptographically signed — same "hard-to-guess secret embedded in
  │  the URL" convention as the Monday side, per Mailchimp's own recommendation)
  ▼
Cloudflare Worker (webhook handler, src/webhook/inboundRoute.ts)
  │  1. validate the shared secret
  │  2. upsert into D1 `pending_inbound_syncs`, keyed on the contact's email — coalesces
  │     rapid-fire events the same way the outbound side does
  │  3. enqueue a Cloudflare Queue message referencing the email
  ▼
Cloudflare Queue (mailchimp-sync-inbound) → consumer
  │  1. fetch the contact's current interests from Mailchimp (fresh, not from the
  │     webhook payload, same staleness reasoning as outbound)
  │  2. resolve each subscribed interest to a Campaigns-board item id via `campaign_items`
  │     (a live Monday fetch only on a cache miss — the Campaigns board is small, unlike
  │     donation-rollups' board-relation filtering problem, so this is cheap)
  │  3. look up the Donor item by Email column (a plain text-column filter, which Monday
  │     does support — donation-rollups' filtering problem was specific to board-relation
  │     columns, not text columns)
  │  4. write the *full current set* of resolved Campaign item ids to the Donor's
  │     connect-column in one call — recompute the whole set every time rather than
  │     diffing incrementally, same philosophy as donation-rollups' rollup recompute
  │     (simpler, self-healing, cheap at this scale)
  │  no email match on the Donors board → skip and ack, not a retry candidate
  ▼
Donor item's "Mailchimp Campaigns" connect-column (Monday.com) — reflects current
subscriptions, visible to staff on the board
```

## Components

Reused from `membership-reminders` (renamed directory, adapted):

* `src/monday.ts` — GraphQL client; kept largely as-is, extended to fetch Address fields and the
  donation-rollup columns, plus item-by-email lookup and connect-column writes for the inbound
  side.
* `src/retry.ts` — generic retry-with-backoff; reused across Monday reads/writes and both
  Mailchimp API directions.
* `src/config.ts`, `src/types.ts` — adapted to the new config shape (below).

New, modeled on `donation-rollups`' webhook-driven shape:

* `src/webhook/outboundRoute.ts`, `src/webhook/inboundRoute.ts`, `src/webhook/validate.ts` —
  challenge handshake (Monday side) + shared-secret validation (both sides).
* `src/db/pendingOutbound.ts`, `src/db/pendingInbound.ts` — the two coalescing D1 tables.
* `src/db/campaignItems.ts` — the interest_id ↔ Monday item id cache/authoritative mapping.
* `src/consumer/outbound.ts` — fetch Donor → map → upsert to Mailchimp.
* `src/consumer/inbound.ts` — fetch contact interests → resolve → write connect-column.
* `src/campaigns/reconcile.ts` — the daily cron handler (catalog diff/create/archive).
* `src/mailchimp/client.ts` — Mailchimp API client (list-member upsert/read, Interest Categories/
  Interests list), keyed by MD5-lowercase-email per Mailchimp's API convention.
* `migrations/0001_create_pending_outbound_syncs.sql`
* `migrations/0002_create_pending_inbound_syncs.sql`
* `migrations/0003_create_campaign_items.sql`

Removed entirely: `src/dates.ts`, `src/filter.ts`, `src/reminders.ts`, `src/templates.ts`,
`src/email.ts` and their tests — no day-offset math, no template rendering, no direct email
sending left in this repo.

## Config (`config/svbc.json`)

```json
{
  "monday": {
    "apiUrl": "https://api.monday.com/v2",
    "donorsBoardId": null,
    "campaignsBoardId": null,
    "columns": {
      "membershipStatus": "REPLACE_WITH_COLUMN_ID",
      "membershipTier": "REPLACE_WITH_COLUMN_ID",
      "memberSince": "REPLACE_WITH_COLUMN_ID",
      "memberUntil": "REPLACE_WITH_COLUMN_ID",
      "addr1": "REPLACE_WITH_COLUMN_ID",
      "city": "REPLACE_WITH_COLUMN_ID",
      "state": "REPLACE_WITH_COLUMN_ID",
      "zip": "REPLACE_WITH_COLUMN_ID",
      "email": "REPLACE_WITH_COLUMN_ID",
      "totalGiven": "REPLACE_WITH_COLUMN_ID",
      "mailchimpCampaigns": "REPLACE_WITH_COLUMN_ID"
    }
  },
  "mailchimp": {
    "apiBaseUrl": "https://REPLACE_WITH_DC.api.mailchimp.com/3.0",
    "audienceId": "REPLACE_WITH_AUDIENCE_ID",
    "mergeFields": {
      "memberSince": "MEMBERSINCE",
      "memberUntil": "MEMBERUNTIL",
      "membershipTier": "MTIER",
      "membershipStatus": "MSTATUS",
      "address": "ADDRESS",
      "totalGiven": "TOTALGIVE"
    },
    "tags": {
      "activeMember": "active-member",
      "lapsedMember": "lapsed-member",
      "lifetimeMember": "lifetime-member",
      "hasDonated": "has-donated"
    }
  },
  "lifetimeTierValue": "Lifetime",
  "activeStatusValue": "Active"
}
```

Board/column IDs remain placeholders, same as the original `membership-reminders` config — the
Donors board doesn't exist until `salesforce-import`'s load stage runs, and the Campaigns board is
created by this Worker itself on first reconciliation run (its id then gets filled in). The
Mailchimp audience ID and merge-field tags are real once staff creates them (one-time setup in the
Mailchimp UI — merge fields must exist in the audience before the API can write to them; see
Prerequisites). Mailchimp API keys embed a datacenter suffix (e.g. `-us21`) that determines the
API host; `apiBaseUrl` should be derived from the key at deploy time rather than hand-maintained.

## Error handling

Follows the root README's webhook-driven Worker shape (D1 idempotency → Queue → retry → DLQ) on
both the outbound and inbound sides — no new failure shape to design there, unlike
`membership-reminders`' cron-based send-then-stamp, which needed its own reasoning. Two additions:

* The outbound consumer must distinguish **transient** Mailchimp failures (429, 5xx — throw, let
  Queues retry) from **permanent** ones (400 invalid email — log and ack, since retrying a
  malformed address fails identically every time).
* The inbound consumer's Campaigns-board item lookup (`campaign_items`) can miss on a genuinely
  new interest that the daily reconciliation cron hasn't picked up yet — treat a cache miss as
  "trigger an on-demand Campaigns-board refresh, then retry once within the same consumer run,"
  not a hard failure; only DLQ if the interest still can't be resolved after that.

The **campaign catalog reconciliation cron** is a third, simpler shape — a self-healing
cron-poller like `committee-calendars`, not queue-backed (a small board, low-frequency changes, no
retry infrastructure needed): if one day's run fails outright, the next day's run re-diffs from
scratch and catches up. No cursor to advance, so no "advance before confirmed write" risk either.

## Testing

Vitest, TDD, mirroring `donation-rollups`' structure (`test/apply-migrations.ts` for D1-backed
tests, mocked Monday GraphQL and Mailchimp clients at their boundaries — no live API calls in
tests). Cover:

* Outbound webhook coalescing: two rapid column-change events for the same item produce one
  `pending_outbound_syncs` row, not two.
* The no-email-column skip-and-ack path (outbound) and no-Donor-match skip-and-ack path (inbound).
* Column → merge-field/tag mapping, including the Lifetime-tier and Active/Lapsed tag logic.
* Transient-vs-permanent Mailchimp error handling (retry-and-DLQ vs log-and-ack).
* Campaign reconciliation: create/rename/archive logic against a mocked Mailchimp Interest
  Categories response, including the interest_id-not-name matching behavior.
* Inbound connect-column write: full-set-replace behavior (a donor with 3 interests, one removed,
  produces a 2-item connect-column write, not a diff/patch).
* Retry/backoff behavior against a mocked Mailchimp client.

## Prerequisites (Mailchimp-side, staff task, not code)

* Create the six merge fields listed above (including the `ADDRESS`-type one) in the target
  audience's settings before first deploy — the API will reject writes to merge fields that don't
  exist yet.
* Create one Interest Category (e.g. "Communications") with one Interest per campaign type:
  Newsletter, Welcome Drip, Renewal Reminders, and any others staff wants donors to be able to
  toggle independently later.
* Build the two Customer Journeys (welcome drip off MEMBERSINCE, renewal reminders off
  MEMBERUNTIL), each gated on its corresponding Interest. Recommended starting cadence: renewal at
  42/28/14 days before MEMBERUNTIL (carried forward from the original `membership-reminders`
  design); welcome drip timing is a staff/copy decision, not re-litigated here.
* Re-point the existing city/donation-history newsletter segments at the `ADDRESS` merge field
  (distance-based) and `has-donated` tag this Worker maintains, replacing the Salesforce-fed
  source.
* Set up a webhook (Audience → Settings → Webhooks) pointed at this Worker's inbound endpoint,
  with a hard-to-guess secret in the URL, subscribed to Subscribes/Unsubscribes/Profile updates/
  Cleaned addresses.

## Monday-side prerequisites

* Donors board columns: Membership Status, Membership Tier, Member Since, Member Until, Address
  fields, Email — written by `salesforce-import`.
* The Total Given / Last Gift rollup columns `donation-rollups` maintains.
* A new connect-column on the Donors board, pointed at the (auto-created) Campaigns board.
* A webhook subscription (`create_item` + `change_column_value`) on the Donors board, pointed at
  this Worker's outbound endpoint, with a shared secret embedded in the URL — same handshake
  pattern as `donation-rollups`.

## Deliberately not in this design

* **A resync sweep for missed Monday/Mailchimp *data* webhooks.** Webhook + Queue + DLQ visibility
  is the same reliability bar every other webhook-driven Worker in this repo ships with; add a
  manual full-resync path only if missed webhooks turn out to be a real problem in practice. (This
  is distinct from the Campaign *catalog* reconciliation cron above, which is required regardless —
  Mailchimp has no webhook event for "Interest Category created/deleted" at all, so polling is the
  only option there, not a reliability fallback.)
* **Running the native Monday↔Mailchimp integration alongside this Worker** for contact creation.
  The upsert call this Worker already makes creates-or-updates in one call; having two systems
  write the same subscriber record would be a race condition for no benefit.
* **Any email content or send-timing logic in this repo.** That's the whole point of the design —
  it now lives in Mailchimp, staff-owned.
* **The donor-portal preference UI itself** — see below.
* **A Donor's second email address (added 2026-09-08).** Mailchimp subscription state belongs
  to an address, not a person, and `salesforce-import` now writes one consent status per email
  column on People (Email Consent, Secondary Email Consent). This design keys both directions on
  the single `email` column only: the Secondary Email is neither pushed outbound nor matched
  inbound (such a webhook records as `skipped`). Extending to it — second column id in config,
  lookup across both, and a second connect column or a union of interests — is a follow-up.

## Related follow-on: donor-portal communication preferences (separate spec)

Staff also want donors to eventually manage their own campaign subscriptions (unsubscribe from,
e.g., the newsletter without leaving the renewal-reminder Journey). Once this design's Interest
Category model exists, that becomes: `donor-portal` reads the logged-in donor's current interests
from Mailchimp and lets them toggle each one, writing back via Mailchimp's API directly (not
through Monday — `mailchimp-sync`'s inbound side picks up the resulting change and reflects it on
the board on its own).

This is a real expansion of `donor-portal`'s scope: its README explicitly lists "editing their own
info" as cut from v1, needing its own scope. A narrow write path to Mailchimp's Interest Categories
(not to Monday or the donor's core record) is a much smaller surface than that general concern, but
it's still a new design pass — auth already exists (magic link), but this needs its own Mailchimp
API credential, UI, and decision about what "campaigns" a donor sees named as (staff-facing
Interest names may not be donor-friendly copy). A `feat/donor-portal-comm-prefs` branch/worktree
already exists, reserved but with no commits yet — the natural home for that follow-up spec once
this design ships.

## Sources

* `membership-reminders/README.md` (original ask, now superseded for the send/timing portions)
* `donation-rollups/` — the closest existing precedent for a Monday-triggered, webhook-driven
  Worker writing to an external system with D1 idempotency + Queue + DLQ
* [Monday.com Mailchimp Integration docs](https://support.monday.com/hc/en-us/articles/360002427080-Mailchimp-Integration) —
  confirms the native integration's field-mapping limitation (checked 2026-08-26)
* [About Geolocation | Mailchimp](https://mailchimp.com/help/about-geolocation/), [All the
  Segmenting Options | Mailchimp](https://mailchimp.com/help/all-the-segmenting-options/) —
  location data is IP/engagement-derived; distance segmentation uses the `ADDRESS` merge field
  (checked 2026-08-26, **not yet confirmed against a live account**)
* Mailchimp Marketing webhooks are unsigned; a URL-embedded secret is Mailchimp's own recommended
  authentication approach (checked 2026-08-26) — same convention this repo already uses for
  Monday webhooks
