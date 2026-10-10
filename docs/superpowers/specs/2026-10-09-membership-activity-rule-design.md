# Membership activity rule — Design

**Date:** 2026-10-09
**Status:** Approved design, pre-implementation. Decided by David W. Keith (DWK) 2026-10-09; the
planning record with the worked examples is the private repo's `docs/28-membership-activity-rule.md`.
**Workers:** `donation-rollups` (owns the rule). `eventbrite-sync` and `funraise-sync` unchanged;
`mailchimp-sync` optional follow-up.
**Supersedes:** the rule, term length, baseline and type derivation in
`2026-09-15-membership-renewal-write-path-design.md`. That spec's architecture — a pure fold
inside the existing recompute, extend-only merge with the board, changed-only writes, per-gift
term stamps — stays and is extended here, not replaced. Read it first for the parts this one
does not restate.

## Context

The 2026-09-15 write path replicates Salesforce's `Create_members` flow: every Received Donation
gift starts a 12-month term, a $1,000+ gift a Lifetime one, and the owner's Member Since /
Member Until / Tier / Status are the fold of post-cutover gifts over a captured pre-feature
baseline. SVBC has since redefined membership itself:

> A person is a member when they have **given at least $1 or volunteered at least 1 hour in the
> last 13 months.**

With it, four more things are tracked per person: when the current membership began (separately
from the first-ever join), how many times they have lapsed, when they last lapsed, and whether
the current membership is **New**, **Continuing**, or a **Lapsed renewal**.

Everything decided 2026-10-09, in one place:

| Decision | Value |
|---|---|
| Qualifying gift | Status = Received, Gift Type = `Donation` only (`eligibleGiftTypes` stays `["Donation"]`), Amount ≥ $1.00 |
| Qualifying volunteer activity | Event Registrations item with Role = Volunteer and Attendance = Attended; Hours ≥ 1 when filled, **blank counts as 1 hour**, explicit 0 does not qualify |
| Window | 13 months from the latest qualifying activity |
| Lifetime | Unchanged: amount ≥ `lifetimeThresholdCents` → Lifetime, always Active, blank Member Until |
| Member Since | Unchanged: first-ever qualifying activity |
| Current Term Start | New column: start of the current unbroken run |
| Lapse Count / Last Lapsed | New columns: a count and the most recent lapse date; **no per-lapse log** |
| Member Type | New column: New / Continuing / Lapsed renewal; New → Continuing at the **13-month anniversary** of Current Term Start, not at the second activity |
| Migrated baseline | The cutover load keeps the old rule; `donation-rollups` runs **one full-history recompute right after cutover, before Gate C**; the November Board Elections export is the backstop |

## Goals

1. Member Since, Current Term Start, Member Until, Membership Status, Membership Tier, Member
   Type, Lapse Count and Last Lapsed on every People / People (Historical) item follow the rule
   above, from the full history, with no staff edit.
2. A qualifying gift *or* a volunteer check-in landing on its board updates the attendee's
   membership the same way, through the same recompute.
3. Re-running on the same inputs produces the same values (idempotent, self-healing), and the
   nightly pass moves Member Type on the anniversary without an event.
4. A staff-granted comp or hand-set Lifetime is never shortened or downgraded.
5. One command recomputes every person after cutover.

## Non-goals

* **Renewal reminders and welcome drips** — `mailchimp-sync` and the Mailchimp Journeys, unchanged.
* **Auto-lapse on the calendar** — the native Monday automation stays and agrees by construction.
* **Rewriting migrated per-gift term stamps.** Term Start / Term End / Membership Type on gifts
  dated before `fromISO` stay as `salesforce-import` wrote them (12-month ends, old labels).
  Only the owner-level columns are recomputed over history.
* **LCI hours in Paychex, or any new way for staff to log hours.** Event check-in is the signal;
  an Hours column on Event Registrations refines it when someone fills it.
* **A per-lapse history.** Lapse Count + Last Lapsed only (decided). The Membership payments
  view on Donations shows the rest.
* **Membership tiers beyond Member / Lifetime.**

## The rule, in Monday terms

### Qualifying activities

An **activity** is a date, an owner (People item), a kind, and a source item id:

| Kind | Source | Qualifies when | Date |
|---|---|---|---|
| `gift` | Donations item (D1 `gifts`) | `status = receivedStatusLabel`, `gift_type ∈ eligibleGiftTypes`, `amount_cents ≥ minAmountCents` (100), a valid date — no date gate | `gift_date` |
| `migrated-term` | Donations item with a migrated Term Start, `gift_date < fromISO` | Term Start non-empty — **regardless of amount, type or status**. Salesforce never booked membership revenue as Opportunity amounts and comp terms have no gift at all; an amount gate over history would un-member people who were members | Term Start |
| `volunteer` | Event Registrations item (D1 `volunteer_activity`) | Role label ∈ `volunteerRoleLabels`, Attendance label ∈ `countedAttendanceLabels`, Hours ≥ 1 or blank, Attendee set | the linked Event's Start date (the registration carries no date of its own) |
| `volunteer-historical` | Volunteers board (2014–2020, read once by the full recompute) | Status ∈ `countedStatusLabels`, Hours ≥ 1 | Date |

`fromISO` keeps its name and value (the cutover date) but changes meaning: it is now the boundary
between *migrated history, trusted as stamped* and *live rule, amount-gated*, not an exclusion.

### Runs

Sort an owner's activities by date (ties by kind then item id, so the order is stable). Each
activity's **reach** is `addMonths(date, termMonths)` with `termMonths = 13` — the existing
`addMonths` rule, Feb 29 and month-end overflow rolling to the 1st. An activity dated on or before
the previous activity's reach extends the current run; one dated after it starts a new run.

* run.start = first activity's date; run.end = last activity's date + 13 months.
* runs = the ordered list; current = the last one; earlier = all before it.

### Owner state

| Column | Derivation |
|---|---|
| Member Since | `runs[0].start` — min with the board value (never later than what staff or the import wrote) |
| Current Term Start | `current.start` — written outright |
| Member Until | blank if Tier = Lifetime; else `current.end`, max with the board value (comps survive) |
| Membership Tier | Lifetime if any qualifying `gift` has `amount_cents ≥ lifetimeThresholdCents` — Lifetime only when the gift is dated on/after `fromISO` (a pre-cutover large gift is ordinary activity; its outcome is the migrated Tier the board keeps) — or the board already says Lifetime; else Member; untouched when the owner has no activity and no board membership |
| Membership Status | Active if Tier = Lifetime or written Until ≥ today (UTC); else Lapsed — unchanged |
| Lapse Count | `earlier.length` — written outright. A currently lapsed member's own lapse is not counted until they come back and start a new run |
| Last Lapsed | `earlier.at(-1).end`, blank when Lapse Count = 0 — written outright |
| Member Type | `anniversary = addMonths(current.start, termMonths)`. **Continuing** if `today ≥ anniversary` **and** `current.end > anniversary` (the run holds more than one activity — without the second condition a single-activity run would read Continuing for the one day it is both past its anniversary and still Active). Else **New** if Lapse Count = 0, else **Lapsed renewal**. On lapse the last value stays; Status already says Lapsed |

Member Type is the only column that depends on today without an event; see "Nightly duty".

### Per-gift term stamps

Unchanged mechanics, new values: for each qualifying `gift` (post-`fromISO` only), Term Start =
gift date, Term End = gift date + 13 months (blank for a Lifetime gift), Membership Type =
`new` if the gift starts the first run, `lapsedRenewal` if it starts a later run, `continuing`
if it extends a run, `lifetime` for a Lifetime gift. A gift that lands while the owner is
already Lifetime gets no stamp (the flow's "already a life member" exit, as before). Volunteer
activities stamp nothing.

### Merge with the board

The 2026-09-15 extend-only merge, extended: Since = min, Until = max (blank for Lifetime), Tier
never downgrades, Status derived. Current Term Start, Lapse Count, Last Lapsed and Member Type
are **derived facts written outright** — a staff edit to them is overwritten on the next
recompute. Known limit, accepted: a staff comp that only extends Until does not bridge two runs,
so a person comped across a gap still counts one lapse. If a comp should count as activity, log
it as a volunteer registration.

## Baseline — retired

The `membership_baseline` capture existed so New / Renewal / Reacquire stayed stable when the
fold only saw post-cutover gifts. A full-history fold is deterministic from the ledger, so the
baseline is no longer read. The table and migration 0005 stay (dropping is a separate migration,
not worth a deploy); `baselineStore` and its README reset runbook line go.

## Architecture

```
Donations board — create / column change ───────────────┐  (existing)
Event Registrations board — create_pulse, Attendance,   │
  Role, Hours or Attendee column change ────────────────┤  (new webhook subscription, same route)
                                                        ▼
donation-rollups webhook → pending_recomputes (kind: 'donation' | 'registration') → Queue → consumer
  │  registration: read the item (Attendee, Event → Start, Attendance, Role, Hours, Source),
  │                upsert volunteer_activity, resolve owner = Attendee (and the previous Attendee
  │                if the link moved — same re-point handling as a Donor link change)
  │  donation:     existing ledger refresh (now also persisting Term Start)
  │  then, for the owner:
  │  1. computeRollup (existing — gifts only; volunteer activity never touches giving numbers)
  │  2. activities = gifts(owner) ∪ migratedTerms(owner) ∪ volunteerActivity(owner)
  │  3. deriveMembership(activities, config, today) → owner state + per-gift terms
  │  4. merge with the board; write changed owner columns in the one existing call
  │  5. stamp changed per-gift term columns (existing)
  ▼
People / People (Historical): the eight membership columns
Donations: Term Start / Term End / Membership Type
  ▼ (existing, unchanged)
mailchimp-sync webhook on the People columns → merge fields; member-portal reads the same columns
```

Nightly (custodian, 09:00 UTC): a **`membership`** duty recomputes every owner whose Member
Type is due to change — those with `anniversary ∈ (yesterday, today]` — plus the same duty on
demand with `all=true` for the one-time post-cutover recompute.

## Volunteer activity in D1

Migration `0009_volunteer_activity.sql`:

```sql
CREATE TABLE volunteer_activity (
  registration_item_id TEXT PRIMARY KEY,   -- Event Registrations (or Volunteers) item
  board_id TEXT NOT NULL,
  owner_item_id TEXT,                      -- Attendee; NULL = unlinked registrant, never qualifies
  owner_board_id TEXT,
  activity_date TEXT NOT NULL,             -- ISO; the Event's Start (or the Volunteers row's Date)
  hours REAL,                              -- NULL = blank = counts as 1
  qualifies INTEGER NOT NULL,              -- 1 when role, attendance, hours and owner all pass
  source TEXT NOT NULL,                    -- 'webhook' | 'sweep' | 'historical'
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_volunteer_owner ON volunteer_activity (owner_item_id);

ALTER TABLE gifts ADD COLUMN term_start TEXT;  -- migrated Term Start, read from the board
```

`gifts.term_start` is filled whenever the ledger refresh reads a gift's Term Start column (the
read already happens for the term-stamp compare) and by the full recompute's board read for
archived gifts the webhook path never touches. It is only consulted for gifts dated before
`fromISO`.

A second table for the derived owner state is deliberately **not** added: the anniversary query
the nightly duty needs is served by reading Current Term Start from the two People boards
(`items_page` filtered to a date range on that column), which is also the only reliable way to
find owners whose membership came from a staff edit rather than an activity.

## Webhook route

`AppDeps.donationBoardIds` becomes a map of board id → kind (`'donation' | 'registration'`),
built from `donationBoards` and the new `volunteerBoards`. A registration event is accepted
only for `create_pulse` and column changes on the configured Attendee, Event, Attendance, Role
and Hours columns; every other column change on that board is acknowledged and ignored (the
ignore set already exists for classify's output columns). `pending_recomputes` gains a `kind`
column (migration 0009 too) so the consumer knows what the item id is. Dedup stays keyed on the
item id. The Volunteers (historical) board gets **no** subscription — it is record-keeping.

## Nightly duty and the one-time recompute

`DUTIES` gains `'membership'`, nightly, idempotent, cursor-resumed like `classify`:

* **Nightly:** page each configured People board for items whose Current Term Start is between
  13 months + 1 day ago and 13 months ago (inclusive of today's anniversary), enqueue an owner
  recompute for each. Expected volume: tens per night.
* **`POST /custodian/run/membership?secret=…&all=true`:** page *every* item on both People boards
  plus every owner in `gifts` and `volunteer_activity`, dedupe, and enqueue one recompute each,
  honoring the existing `owner_recomputes` coalescing and the daily D1 write quota
  (`consumer/quota.ts`); the duty reports `remaining > 0` and resumes the next night until the
  cursor clears. ~15,500 owners. Before the first run it also loads the historical Volunteers
  board into `volunteer_activity` (source `historical`) and backfills `gifts.term_start`.
  This is the post-cutover step; the runbook (private repo `docs/23`) gets one line pointing here.

Because the one-time pass is just the normal recompute per owner, there is no separate
migration path from 12-month to 13-month state: the fold rewrites every owner column from
history and the extend-only merge keeps anything staff set higher. Nobody loses status —
13 months is longer than 12.

## Configuration

`donation-rollups/config/svbc.json` and `config/sandbox.json`, `membership` block:

```jsonc
"membership": {
  "fromISO": "2026-10-16",              // migrated-history boundary (the cutover date)
  "eligibleGiftTypes": ["Donation"],
  "minAmountCents": 100,                // NEW — "given at least $1"
  "termMonths": 13,                     // was 12
  "lifetimeThresholdCents": 100000,
  "statusLabels": { "active": "Active", "lapsed": "Lapsed" },
  "tierLabels":   { "member": "Member", "lifetime": "Lifetime" },
  "typeLabels":   { "new": "New", "continuing": "Continuing", "lapsedRenewal": "Lapsed renewal", "lifetime": "Lifetime" }
                                        // keys renamed from renewal/reacquire; used for both the
                                        // owner's Member Type and the per-gift Membership Type
},
"volunteerBoards": [{                   // NEW — Event Registrations
  "boardId": 0,
  "columns": { "attendee": "…", "event": "…", "attendance": "…", "role": "…", "hours": null, "source": "…" },
  "eventBoard": { "boardId": 0, "columns": { "start": "…" } },
  "volunteerRoleLabels": ["Volunteer"],
  "countedAttendanceLabels": ["Attended"]
}],
"historicalVolunteerBoards": [{         // NEW — Volunteers, read once by the full recompute
  "boardId": 0,
  "columns": { "volunteer": "…", "date": "…", "hours": "…", "status": "…" },
  "countedStatusLabels": ["Completed"]
}],
"ownerColumnsByBoard": {
  "<People>": { "…": "…", "membership": {
    "status": "…", "tier": "…", "since": "…", "until": "…",
    "currentTermStart": "…", "memberType": "…", "lapseCount": "…", "lastLapsed": "…"   // NEW
  }},
  "<People (Historical)>": { "…same eight…" }
}
```

`hours: null` is allowed (the column does not exist yet; blank = 1 hour either way). Validation
follows `requireKeys`: when `membership` is non-null, all eight owner column ids are required on
every board that has a `membership` entry, and `volunteerBoards` may be empty (gifts-only rule)
but not absent. The per-Worker `split.test.ts` extends to the new board ids. Production ids are
filled at cutover like every other id; the CRM Sandbox v3 ids go in `sandbox.json` once the
four columns and the Event Registrations Hours column exist there (`docs/22` carry-forward in
the private repo).

## Components

* `src/membership/derive.ts` — `deriveMembership(activities, config, todayISO)` replaces the
  baseline-based signature; new `buildRuns(activities, termMonths)`, `memberTypeFor(run, lapseCount,
  todayISO)`, `MembershipActivity` type; `mergeWithBoard` grows the four outright columns;
  `membershipColumnValues` compares all eight. `addMonths` unchanged.
* `src/db/volunteerActivity.ts` — `upsert`, `forOwner(ownerItemId)`, `ownersWithActivity()`.
* `src/db/gifts.ts` — `term_start` read/write.
* `src/db/pending.ts` — `kind`.
* `src/monday/client.ts` — `getRegistration(itemId)` (with the Event's Start through the
  board_relation), `getOwnerMembership` reads eight columns, `pageOwnersByCurrentTermStart(boardId,
  fromISO, toISO)`, `pageHistoricalVolunteers(board)`.
* `src/webhook/route.ts`, `validate.ts` — board kind, accepted column set for registrations.
* `src/consumer/processBatch.ts` — registration branch; membership step takes activities, not
  baseline; `baselineStore` removed from `ConsumerDeps`.
* `src/custodian/custodian.ts` — the `membership` duty, nightly and `all=true`.
* `src/config.ts`, `src/types.ts`, `config/*.json`, `config/split.test.ts`.
* `migrations/0009_volunteer_activity.sql`.
* `README.md` — the "Membership renewal write path" section rewritten around this spec, including
  the post-cutover command; drop the baseline-reset line.

## Error handling

* A registration whose Event link or Event Start is missing is stored with `qualifies = 0` and a
  reason in the consumer log (no PII — item ids only, per `check-log-safety`); it is not a fault.
* An Attendee re-point recomputes both the old and new owner, as a Donor re-point does.
* A deleted registration (Monday returns nothing) marks the row `qualifies = 0`; an archived
  registration keeps its last read (archived items read empty board_relations, the same trap as
  archived gifts, issue #26).
* Config mismatch (a missing column id) surfaces on the write → retry → DLQ → alert, as today.
* The nightly duty's page read failing leaves the cursor in place; the next night resumes.

## Testing

* **`derive.test.ts`** — table-driven, mirroring the private repo's `docs/28` worked examples:
  first-ever gift (New, Until +13 months); second gift inside the run (Since unchanged, Until
  extends, Type New until the anniversary then Continuing); gap > 13 months (new run, Lapse
  Count 1, Last Lapsed = old run end, Type Lapsed renewal); gap of exactly 13 months to the day
  (same run); volunteer check-in with blank Hours qualifies, Hours 0 does not, Hours 0.5 does
  not; $0.99 gift ignored, $1.00 counts; migrated term with $0 amount counts before `fromISO`
  and not after; Lifetime: Until blank, Type still derived; single-activity run on its
  anniversary day reads New, not Continuing; a Failed gift drops out; identical output on re-run;
  stable order for same-day activities.
* **`processBatch.test.ts`** — registration message upserts `volunteer_activity` and recomputes
  the Attendee; Attendee change recomputes both owners; unlinked registrant recomputes nobody;
  the eight owner columns are written only when changed; per-gift stamps use the new labels;
  no baseline store is consulted.
* **`route.test.ts`** — registration events accepted only for the configured columns; a
  Volunteers-board event is ignored.
* **`custodian.test.ts`** — `membership` duty enqueues exactly the owners whose anniversary
  falls in the window; `all=true` dedupes owners across the three sources and resumes on
  `remaining > 0`.
* **`config.test.ts`** — eight owner columns required with the block on; `volunteerBoards`
  required (may be empty); `hours: null` accepted; renamed `typeLabels` keys required.
* **Sandbox verification** (manual): on CRM Sandbox v3, hand-create a $1 Received Donation
  dated today for a Lapsed member → Current Term Start = today, Until +13 months, Type Lapsed
  renewal, Lapse Count incremented; set a registration's Attendance to Attended with Role =
  Volunteer for a never-member → New with Until +13 months; run `membership?all=true` twice →
  second run writes nothing.

## Sequencing

1. Build and test on the feature branch; type-check and `split.test.ts` pass.
2. Add the four People columns, the Event Registrations Hours column and the relabelled
   Membership Type labels to CRM Sandbox v3; fill `sandbox.json`; deploy `--env sandbox`;
   apply migration 0009 to the sandbox D1; run the sandbox verification.
3. Production: columns and labels created as part of the `docs/22` cutover carry-forward; ids
   into `svbc.json`; migration 0009 applied **before** deploying the build that reads it (the
   0005/0006 ordering lesson in the README applies).
4. After the cutover load and before Gate C: register the Event Registrations webhook, then
   `POST /custodian/run/membership?all=true`; let it resume nightly until `remaining = 0`.
   Backstop deadline: before the November Board Elections export.

## Sources

* Private planning repo `docs/28-membership-activity-rule.md` (rule, every decision of
  2026-10-09, worked examples) and `docs/22` §3.1/§3.9 (column text).
* `2026-09-15-membership-renewal-write-path-design.md` and `donation-rollups/README.md`
  "Membership renewal write path" (the mechanics this extends).
* `people-reclassification/config/svbc.json` — the Event Registrations / Events / Volunteers
  read shape (Attendee, Event → Start, Attendance, Source; Volunteer, Date) this reuses.
