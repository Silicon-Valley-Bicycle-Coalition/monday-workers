# membership-reminders: implementation design

**Status:** Approved for implementation (2026-08-22).
**Builds on:** `membership-reminders/README.md` (since repurposed as `mailchimp-sync`; current spec: [`mailchimp-sync/README.md`](../../../mailchimp-sync/README.md)), which is
the decided product/business spec. This document covers the implementation-level decisions that
README leaves open.

## Scope recap (from the README, not re-decided here)

Daily Cron Trigger Worker. Query the Donors board for Membership Status = Active and Member Until
exactly 42/28/14 days out (one query per stage), skip Lifetime tier and blank Member Until, send
that stage's templated email, then stamp the Reminders Sent column before considering the send
complete. Re-runs are idempotent because already-stamped items for the current term are skipped.

## Decisions made in this design pass

* **Workspace:** new git worktree `monday-workers-membership-reminders`, branch
  `feat/membership-reminders`, off `main` — same one-worktree-per-feature-branch pattern as
  `monday-workers-si` (`feat/salesforce-import`), kept isolated so it doesn't collide with that
  in-flight work.
* **Email provider:** not decided yet. `src/email.ts` exposes a `sendReminderEmail()` function;
  v1's implementation is a logging stub (records what would have been sent, returns success).
  Swapping in Resend (or another provider) later is a single-file change isolated from
  orchestration logic. This also unblocks `donor-portal`, which was deferring to whatever this
  Worker picked.
* **Monday board/column IDs:** the Donors-board columns this Worker depends on (Membership Status,
  Membership Tier, Member Since, Member Until, Reminders Sent) don't exist yet — no sandbox board
  is built. All IDs live in `config/svbc.json` as placeholders, following `salesforce-import`'s
  config-as-JSON pattern (a fork or a later sandbox board is a config edit, not a code change).
  End-to-end testing against real Monday data waits until the sandbox board exists; until then, all
  tests mock the GraphQL client at its boundary.
* **Renewal link:** no real renewal page exists yet. `config/svbc.json` carries a clearly-marked
  placeholder URL (`https://bikesiliconvalley.org/renew`) that staff can swap once a real page
  exists. Not blocking the build.

## Components

* `config/svbc.json` — board ID, column IDs (placeholders), the three stage offsets (42/28/14
  days), and the renewal-link placeholder.
* `src/config.ts` — typed config loader.
* `src/monday.ts` — Monday GraphQL client: one query per stage (Membership Status=Active, Member
  Until=today+offset), and the Reminders Sent column update. Retry-with-backoff on both read and
  write calls.
* `src/email.ts` — `sendReminderEmail()` interface; logging-stub implementation for v1.
* `src/templates.ts` — the three stage templates (subject, greeting, expiration date, renewal
  link) as plain data, separate from send logic, so copy edits don't touch code paths.
* `src/reminders.ts` — orchestration: per stage, query → filter (belt-and-suspenders skip of
  Lifetime/blank Member Until, even though the query should already exclude them) → skip if
  already stamped for this term → send → stamp. Collects a run summary (sent/stamped/skipped/
  failed counts per stage).
* `src/index.ts` — Hono app + `scheduled()` handler wired to the Cron Trigger.

## Error handling

The parent repo's Reliability section (see `../../../README.md`) covers two shapes: webhook-driven
Workers (fixed with a Cloudflare Queue) and self-healing cron-pollers with a "last processed"
cursor. This Worker is a third shape — a per-item send-then-stamp inside a daily batch — that
README doesn't fully cover:

* If the **stamp write** fails after a successful send: low risk. Tomorrow's exact-day-offset
  filter won't match this item again, so there's no duplicate-send risk — the member did get the
  email, the idempotency record is just incomplete.
* If the **send** fails outright: higher risk. The exact-day window won't recur, so a silent
  failure here means that member never gets that stage's reminder — a real cost, since these
  reminders are the org's recurring-revenue mechanism.

Mitigation: retry each item's send-then-stamp a few times with backoff within the same run. At the
end of the run, log a summary (sent/stamped/skipped/failed per stage) at error level when any
failures remain after retries, so a persistent failure is visible in Cloudflare's logs rather than
silently disappearing. Slack alerting on failure is a nice-to-have, deliberately deferred (see
below) — not required for v1 to ship safely, since error-level logging already makes failures
discoverable.

## Testing

Vitest, TDD. Unit-test:

* Stage-window date math (42/28/14 days out, including month/year boundaries).
* The Lifetime/blank-Member-Until filter.
* Idempotency skip logic (already-stamped-for-this-term detection).
* Retry/backoff behavior, against a mocked GraphQL client.
* Template rendering (all three stages).

No live integration test against real Monday is possible yet — the sandbox board doesn't exist.

## Deliberately not in v1

Extends the README's existing "Deliberately not in v1" list:

* **Live email sending** — stubbed pending a provider decision (see above).
* **Slack failure alerting** — error-level logging only; revisit if silent misses turn out to be a
  real problem in practice.
* **Real renewal-link URL** — placeholder in config until a renewal page exists.
