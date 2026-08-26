# mailchimp-sync: design

**Status:** Approved for implementation (2026-08-26).
**Supersedes:** [`2026-08-22-membership-reminders-design.md`](2026-08-22-membership-reminders-design.md).
`membership-reminders` was built and merged but never deployed — no production usage, no data, no
migration cost — so this replaces its approach rather than extending it.
**Repurposes:** the `membership-reminders/` Worker directory, renamed `mailchimp-sync/`.

## The ask

Two originally-separate requests turned out to be the same underlying gap:

1. **The 3-stage new-member welcome drip** — Salesforce's other membership email automation,
   flagged in `membership-reminders/README.md`'s "Deliberately not in v1" as a follow-up ("same
   machinery would work... trigger on Member Since instead of Member Until... but it's a separate
   decision and separate templates").
2. **SVBC's existing Mailchimp newsletter segmentation** (by city, by prior-donation history) is
   currently fed from Salesforce. That feed breaks at Salesforce retirement — the same
   "stops working at cutover" urgency the plan already flagged for renewal reminders, just one
   layer upstream.

Both problems reduce to the same missing piece: **nothing keeps Mailchimp's contact data current
from Monday.com**, the post-migration source of truth. Once that sync exists, the welcome drip,
the renewal reminders, and the existing newsletter segments are all just Mailchimp configuration
on top of it — not separate builds.

## Decision history (why Mailchimp, not a Worker-side send)

* **Rejected: Monday.com native Mailchimp integration.** Confirmed against
  [Monday's own docs](https://support.monday.com/hc/en-us/articles/360002427080-Mailchimp-Integration)
  (2026-08-26): its four templates only push a bare email address into a Mailchimp list
  (*"if you have other required fields in Mailchimp (merge fields)... the template will not
  work"*), or run in the wrong direction (Mailchimp → Monday, for campaign stats / new
  subscribers). No template maps arbitrary Monday columns to Mailchimp merge fields or tags. It
  cannot carry Member Since, Member Until, Membership Tier, City, or a donation signal — so it
  cannot drive Journey date-triggers or segments. Not a config problem; a capability gap.
* **Rejected: keep `membership-reminders` as a Worker-driven sender, add welcome drip alongside
  it.** Would mean maintaining two different mechanisms (Worker cron+templates vs. Mailchimp) for
  functionally identical problems, and leaves the Mailchimp segmentation gap (item 2 above)
  unsolved regardless.
* **Chosen: a sync Worker + Mailchimp Customer Journeys.** SVBC is on Mailchimp Standard/Premium,
  which supports Journey triggers on a per-contact date merge field — exactly what both the
  welcome drip (off Member Since) and renewal reminders (off Member Until) need. Staff already
  maintains Mailchimp templates for the newsletter, so putting timing and copy there (instead of
  in this repo) is a net reduction in future maintenance burden, not just a preference. This repo's
  only remaining job is keeping the data current.

## Scope recap

* **Retire:** `membership-reminders`'s cron, email composition, and template code
  (`dates.ts`, `filter.ts`, `reminders.ts`, `templates.ts`, `email.ts` and their tests) — timing
  and copy for both renewal reminders and the welcome drip move to Mailchimp Journeys, staff-owned.
* **Build:** `mailchimp-sync` — a webhook-driven Worker that keeps a Mailchimp audience's merge
  fields and tags current from the Donors board, following this repo's standard webhook-driven
  shape (see root `README.md`'s Reliability section), same as `donation-rollups` — inverted
  direction (Monday change → external write) rather than external event → Monday.
* **Carry forward, not re-decide:** the existing 42/28/14-day renewal cadence, documented in the
  new README as the recommended starting Journey configuration even though it's no longer
  enforced by code.

## Data flow

```
Donors board (Monday.com)
  │  webhook, on item create / column change (Membership Status, Membership Tier,
  │  Member Since, Member Until, City, Email, and the Total Given / Last Gift rollup
  │  columns donation-rollups already maintains)
  ▼
Cloudflare Worker (webhook handler, src/webhook/route.ts)
  │  1. echo the challenge verbatim during webhook-subscription setup (one-time handshake)
  │  2. validate the shared secret embedded in the webhook URL (Monday doesn't sign
  │     payloads — same convention as donation-rollups)
  │  3. upsert into D1 `pending_syncs`, keyed on the Donor item id — a later event for
  │     the same item replaces the pending row instead of queuing a redundant duplicate
  │  4. enqueue a Cloudflare Queue message referencing the item id
  ▼
Cloudflare Queue → consumer Worker
  │  1. fetch the item's current column values fresh from Monday (not from the webhook
  │     payload — avoids acting on stale values if multiple edits landed before the
  │     queue drained)
  │  2. no email column value → skip and ack (not a retry candidate; same pattern as
  │     donation-rollups' "no owner linked yet")
  │  3. map columns to Mailchimp merge fields (MEMBERSINCE, MEMBERUNTIL, MTIER, MSTATUS,
  │     CITY, TOTALGIVE) and tags (active-member / lapsed-member, lifetime-member,
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
  • Welcome drip — 3 stages, triggered off MEMBERSINCE, replacing Salesforce's automation
  • Renewal reminders — 3 stages, triggered off MEMBERUNTIL, recommended at 42/28/14 days
    (the existing cadence) as a starting point
  • Existing newsletter segments (by city, by has-donated tag) — same data, no longer
    dependent on the Salesforce feed
```

## Components

Reused from `membership-reminders` (renamed directory, adapted):

* `src/monday.ts` — GraphQL client; kept largely as-is, extended to fetch City and the
  donation-rollup columns alongside the existing membership columns.
* `src/retry.ts` — generic retry-with-backoff; reused for both the Monday item fetch and the
  Mailchimp API call.
* `src/config.ts`, `src/types.ts` — adapted to the new config shape (below).

New, modeled on `donation-rollups`' webhook-driven shape:

* `src/webhook/route.ts`, `src/webhook/validate.ts` — challenge handshake + shared-secret
  validation, same pattern as `donation-rollups`.
* `src/db/pending.ts` — the `pending_syncs` D1 table and upsert-and-coalesce logic (one row per
  Donor item id, replaced on each new event rather than queuing duplicates).
* `src/consumer/processBatch.ts` — queue consumer: fetch → map → upsert to Mailchimp.
* `src/mailchimp/client.ts` — Mailchimp API client (list-member upsert, keyed by
  MD5-lowercase-email per Mailchimp's API convention).
* `migrations/0001_create_pending_syncs.sql`.

Removed entirely: `src/dates.ts`, `src/filter.ts`, `src/reminders.ts`, `src/templates.ts`,
`src/email.ts` and their tests — no day-offset math, no template rendering, no direct email
sending left in this repo.

## Config (`config/svbc.json`)

```json
{
  "monday": {
    "apiUrl": "https://api.monday.com/v2",
    "donorsBoardId": null,
    "columns": {
      "membershipStatus": "REPLACE_WITH_COLUMN_ID",
      "membershipTier": "REPLACE_WITH_COLUMN_ID",
      "memberSince": "REPLACE_WITH_COLUMN_ID",
      "memberUntil": "REPLACE_WITH_COLUMN_ID",
      "city": "REPLACE_WITH_COLUMN_ID",
      "email": "REPLACE_WITH_COLUMN_ID",
      "totalGiven": "REPLACE_WITH_COLUMN_ID"
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
      "city": "CITY",
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
Donors board doesn't exist until `salesforce-import`'s load stage runs. The Mailchimp audience ID
and merge-field tags are real once staff creates them (one-time setup in the Mailchimp UI — merge
fields must exist in the audience before the API can write to them; see Prerequisites below).
Mailchimp API keys embed a datacenter suffix (e.g. `-us21`) that determines the API host; the
config's `apiBaseUrl` should be derived from the key at deploy time rather than hand-maintained.

## Error handling

Follows the root README's webhook-driven Worker shape exactly (D1 idempotency → Queue → retry →
DLQ) — no new failure shape to design, unlike `membership-reminders`' cron-based
send-then-stamp, which needed its own reasoning. The one addition: the queue consumer must
distinguish **transient** Mailchimp failures (429 rate limit, 5xx — throw, let Queues retry) from
**permanent** ones (400 invalid email — log and ack, since retrying a malformed address fails
identically every time and would otherwise loop until the DLQ).

## Testing

Vitest, TDD, mirroring `donation-rollups`' structure (`test/apply-migrations.ts` for D1-backed
tests, mocked Monday GraphQL and Mailchimp clients at their boundaries — no live API calls in
tests). Cover:

* Webhook coalescing: two rapid column-change events for the same item produce one `pending_syncs`
  row, not two.
* The no-email-column skip-and-ack path.
* Column → merge-field/tag mapping, including the Lifetime-tier and Active/Lapsed tag logic.
* Transient-vs-permanent Mailchimp error handling (retry-and-DLQ vs log-and-ack).
* Retry/backoff behavior against a mocked Mailchimp client.

## Prerequisites (Mailchimp-side, staff task, not code)

* Create the six merge fields listed above in the target audience's settings before first deploy —
  the API will reject writes to merge fields that don't exist yet.
* Build the two Customer Journeys (welcome drip off MEMBERSINCE, renewal reminders off
  MEMBERUNTIL) using the merge fields this Worker populates. Recommended starting cadence:
  renewal at 42/28/14 days before MEMBERUNTIL (carried forward from the original
  `membership-reminders` design); welcome drip timing is a staff/copy decision, not re-litigated
  here.
* Re-point the existing city/donation-history newsletter segments at the CITY and has-donated tag
  this Worker maintains, replacing the Salesforce-fed source.

## Monday-side prerequisites (unchanged from `membership-reminders`)

* Donors board columns: Membership Status, Membership Tier, Member Since, Member Until, City,
  Email — written by `salesforce-import`.
* The Total Given / Last Gift rollup columns `donation-rollups` maintains.
* A webhook subscription (`create_item` + `change_column_value`) on the Donors board, pointed at
  this Worker, with a shared secret embedded in the URL — same handshake pattern as
  `donation-rollups`.

## Deliberately not in this design

* **A reconciliation/backfill cron sweep.** Webhook + Queue + DLQ visibility is the same
  reliability bar every other webhook-driven Worker in this repo ships with; add a manual
  full-resync path only if missed webhooks turn out to be a real problem in practice, rather than
  building it speculatively.
* **Running the native Monday↔Mailchimp integration alongside this Worker** for contact creation.
  The upsert call this Worker already makes creates-or-updates in one call; having two systems
  write the same subscriber record would be a race condition for no benefit.
* **Any email content or send-timing logic in this repo.** That's the whole point of the design —
  it now lives in Mailchimp, staff-owned.

## Sources

* `membership-reminders/README.md` (original ask, now superseded for the send/timing portions)
* `donation-rollups/` — the closest existing precedent for a Monday-triggered, webhook-driven
  Worker writing to an external system with D1 idempotency + Queue + DLQ
* [Monday.com Mailchimp Integration docs](https://support.monday.com/hc/en-us/articles/360002427080-Mailchimp-Integration) —
  confirms the native integration's field-mapping limitation (checked 2026-08-26)
