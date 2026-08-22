# volunteermatch-sync: implementation design

**Status:** Design complete; **implementation blocked** pending Idealist confirming API access and
cost (see [`README.md`](../../../volunteermatch-sync/README.md)). Unlike `membership-reminders`'s
design doc, this one is not "approved for implementation" — it exists so the build is ready to
start the moment that blocker clears, not so it can start now.
**Builds on:** [`volunteermatch-sync/README.md`](../../../volunteermatch-sync/README.md), the
product/business spec. This document covers the implementation-level decisions that README leaves
open.

## Scope recap (from the README, not re-decided here)

Bidirectional sync between Monday's Volunteers board and VolunteerMatch/Idealist: outbound (open
roles → VolunteerMatch listings) and inbound (VolunteerMatch applicants → Monday subitems).
Cron-polled, no Queue — self-healing on next run.

## Decisions made in this design pass

* **Sync mechanics: cron-poll both directions**, not webhook + Queue. VolunteerMatch/Idealist's
  public docs show no webhook or push mechanism anywhere — the closest thing, applicant email
  notification, is a human-facing UX feature (instant/daily/weekly), not a machine event source.
  Assuming a webhook exists would be guessing against the evidence gathered; polling is the safe
  default and matches `squarespace-forms`/`committee-calendars`'s existing pattern in this repo.
* **Roles live on the existing Volunteers board**, in a new "Open Roles" group, rather than a new
  board — the historical Salesforce-side Volunteer Job/Shift/Hours data already targets that board,
  so open postings join it instead of fragmenting volunteer data across two boards.
* **Applicants land as subitems of the role item**, not a separate applicants board — keeps each
  applicant visibly tied to the role they applied to. A separate board with a linked-item column
  was considered (easier to build cross-role applicant views/automations later) but rejected for
  v1 as a second place staff would have to check.
* **Workspace:** when build starts, a new git worktree `monday-workers-volunteermatch-sync` on
  branch `feat/volunteermatch-sync` off `main` — same one-worktree-per-feature-branch pattern as
  the other in-flight Workers. **Not created yet** — there's nothing to build against until
  Idealist access is confirmed.

## Components (planned, not yet scaffolded)

* `config/svbc.json` — Volunteers board ID, "Open Roles" group ID, role/subitem column IDs
  (placeholders until the group exists), poll interval.
* `src/config.ts` — typed config loader.
* `src/monday.ts` — Monday GraphQL client: query the Open Roles group, write listing ID/sync
  status back to a role item, create applicant subitems. Retry-with-backoff on read and write.
* `src/volunteermatch.ts` — VolunteerMatch/Idealist client: Listings API (create/update/close),
  Apply API (list applications since a cursor). **Cannot be built against a real spec yet** — the
  actual request/response shapes are unknown until Idealist grants access; this file is where that
  unknown gets resolved, not before.
* `src/roles.ts` — outbound orchestration: query Open Roles → diff against D1 `roles` table
  (Monday item ID ↔ listing ID ↔ content hash) → create/update/close on VolunteerMatch → write
  back status → advance D1 only after a confirmed write.
* `src/applicants.ts` — inbound orchestration: poll the Apply API since the D1 cursor → resolve
  each application to its role item via the stored listing ID → create a subitem → advance the
  cursor only after a confirmed write.
* `src/index.ts` — Hono app + `scheduled()` handler running both orchestration steps.

## Data model (D1)

* `roles` — `monday_item_id`, `volunteermatch_listing_id`, `content_hash`, `last_synced_at`,
  `sync_status` (posted / needs_update / closed / error).
* `applicants` — `volunteermatch_application_id` (dedupe key), `monday_subitem_id`,
  `processed_at`.
* `sync_cursor` — single-row table tracking the last successfully processed application
  timestamp/ID for the Apply API poll.

## Error handling

Same invariant as every cron-polled Worker in this repo (see `../../../README.md`'s Reliability
section): D1's last-synced-at / cursor only advances after a confirmed write on the far side
(VolunteerMatch for outbound, Monday for inbound), never before — a failed poll is retried next
cycle instead of silently skipping whatever it should have processed. Retry-with-backoff on
individual API calls within a run, the same pattern `funraise-sync` uses on its webhook-side
Monday writes, applied here to poll-side calls on both APIs instead.

## Testing

Vitest, TDD. Unit-test:

* Outbound diff logic (content-hash change detection, create vs. update vs. close branching).
* Inbound cursor/dedupe logic (no duplicate subitems on a re-run after a partial failure).
* Both Monday GraphQL and VolunteerMatch API calls mocked at their boundary — no live integration
  test is possible until Idealist access exists.

## Deliberately not in v1

Extends the README's existing "Deliberately not in v1" list — see there for the full list
(real-time sync, VolunteerMatch-side listing edits, applicant status tracking back to
VolunteerMatch).

## Open questions blocking the build

1. **Idealist API access and cost** — the standing blocker; owner dwk.
2. **Whether the Apply API supports filtering applications by date/listing** — needed for the
   inbound poll design above; unconfirmed from public docs, resolve when terms are discussed with
   Idealist.
3. **Exact Monday column design** — status column values on the role item, the subitem column set
   for applicant fields — deferred to build time, once the Open Roles group actually exists.
