# volunteermatch-sync

**Status:** Design complete — do not start the build until Idealist confirms access and cost (see
Status of the API below). That's the only remaining blocker; the shape of the build itself is
settled.
**Priority:** Post-migration, non-blocking.
**Owner:** dwk — confirms API access/terms with Idealist first; build the sync once confirmed.
**Stack:** Hono + TypeScript + D1, Cron Trigger (no Queue — self-healing poll, same shape as
`squarespace-forms`/`committee-calendars`).

## The ask

Broaden volunteer recruitment beyond SVBC's own site by syndicating open roles to VolunteerMatch's
network, and bring the resulting applicants back into Monday so staff aren't working two systems.

## Status of the API

[VolunteerMatch](https://developers.volunteermatch.org/api-docs) is now part of
[Idealist](https://www.idealist.org/en/open-network-api) as the **Open Network API**, split into a
**Listings API** (post/read opportunities) and an **Apply API** (submit/retrieve applications).
**Cost and access terms are not yet confirmed** — the full technical reference is gated behind
partner access, and pricing is gated behind an inquiry form. This remains the actual blocker, not a
technical one. Check directly with Idealist before committing to any build work, and while doing so
confirm two things this design had to assume from public docs alone:

* **Whether the Apply API supports listing/filtering applications by date or by listing.** Nothing
  in the public docs confirms this either way; the inbound polling design below depends on it.
* **Whether any real-time push mechanism exists beyond what's publicly documented.** Nothing found
  suggests one — Idealist's own dashboard notifies organizations of new applicants by **email
  only** (instant/daily/weekly, per their FAQ), not by webhook — but it's worth asking directly
  rather than assuming silence means "no."

## Data flow

```
Monday "Volunteers" board, "Open Roles" group
  │  Cron Trigger polls on a schedule, diffs against D1 (role ↔ listing ID + content hash)
  ▼
VolunteerMatch / Idealist Listings API
     create / update / close listing; listing ID + sync status written back to the role item

VolunteerMatch / Idealist Apply API
  │  Cron Trigger polls for applications since a D1 cursor
  ▼
Monday role item
     new subitem per applicant (name, email, message)
```

Two independent poll loops on one scheduled trigger, not a webhook + Queue shape — see Status of
the API above for why. Same self-healing invariant as every other cron-polled Worker in this repo
(see `../README.md`'s Reliability section): the D1 cursor/last-synced-at only advances after a
confirmed write, never before, so a failed poll is retried next cycle instead of silently skipped.

## Monday targets

* **Open roles:** a new **"Open Roles" group on the existing Volunteers board**, not a separate
  board — keeps volunteer data in one place rather than splitting live postings from the board's
  historical shift/hours records.
* **Applicants:** one **subitem per applicant, under the role item they applied to** — keeps
  applicant and role tightly linked and visible in one place, rather than a separate applicants
  board.
* Exact column names/values (a status column for posted/needs-update/closed, the subitem column
  set for applicant fields) aren't decided here — build-time detail, config-driven per this repo's
  fork-friendly convention (see `../README.md`).

## Matching & idempotency

D1 stores the Monday item ID ↔ VolunteerMatch listing ID pair, plus a content hash of the role's
synced fields so an unchanged role is skipped without re-diffing the full item on every poll.
Applicant polling stores a last-processed cursor (by date or by ID, depending on what the Apply
API actually supports — see Status of the API) so a re-run after a partial failure doesn't
recreate subitems for applicants already written.

## Testing

Vitest. Unit-test the outbound diff/mapping logic and the inbound cursor/dedupe logic against
mocked Monday GraphQL and VolunteerMatch API responses — same shape as the other Workers in this
repo. No live integration test is possible until Idealist access exists.

## Deliberately not in v1

* **Real-time sync** — polling only; see Status of the API for why a webhook shape isn't assumed.
* **Editing/withdrawing a listing from the VolunteerMatch side** — this Worker is
  Monday-authoritative for role content; VolunteerMatch-side edits aren't pulled back.
* **Applicant status tracking back to VolunteerMatch** (e.g. marking someone "contacted" so it
  shows in their dashboard) — one-directional for applicants; Monday is where staff work from
  here on.

## Sources

* [VolunteerMatch API docs](https://developers.volunteermatch.org/api-docs) (full reference gated
  behind partner access)
* [Idealist Open Network API](https://www.idealist.org/en/open-network-api) — Listings API + Apply
  API overview, pricing gated behind an inquiry form
* [Idealist VolunteerMatch FAQ](https://www.idealist.org/en/help/welcome-to-idealist-volunteermatch-frequently-asked-questions) —
  confirms applicant notifications are email-only (instant/daily/weekly); no webhook mentioned
* Plan section: VolunteerMatch / Idealist (Integrations) — `migration-plan.md` (private planning
  repo)
* Implementation design:
  [`docs/superpowers/specs/2026-08-22-volunteermatch-sync-design.md`](../docs/superpowers/specs/2026-08-22-volunteermatch-sync-design.md)
