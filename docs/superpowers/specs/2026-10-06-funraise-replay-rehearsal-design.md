# Funraise replay rehearsal — design

**Status:** proposal, 2026-10-06. The runbook (`monday-migration` `docs/23`, step 5) requires the
replay to be rehearsed before Gate A: "replaying one Worker's stored deliveries into another has
never been run." This is how to do that with what exists, what it proves, and what it can't.
Tool under test: `funraise-sync/scripts/replay-window.mjs` (!186), with reject-and-flag (!185).

## What there is to replay

Read-only, counts only, from the sandbox D1 `svbc-funraise-sync-sandbox` on 2026-10-06:

| | |
|---|---|
| Stored deliveries | 71, received 2026-09-19 → 2026-10-06, all `written`, all with a Monday item id |
| By Funraise status | 57 `Complete` (45 of them recurring installments), 14 `Failed` |
| Not present | refunds, event tickets, gifts before FY 2026, emptied payloads, Test-button rows (`-1`) |

That is about four gifts a day, so a weekend window is roughly 10–20 deliveries: the replay takes
under a minute at the default 2 s pause. The data covers one-time gifts, installments and `Failed`
naturally. It does **not** cover a refund, a ticket, an archived-year gift or a purged payload;
those need synthetic envelopes (below) or are covered by unit tests only.

## Target: a local Worker, not a new deployment

Run the merged code (the !185 and !186 branches merged in a scratch worktree, never pushed) as
`wrangler dev --env sandbox`. The target is then a real Worker with a **fresh local D1** and a
local queue, and the replay posts to `http://localhost:8787`. The source is the real sandbox D1.
The consumer writes to the real **sandbox v3 boards** with the sandbox token, so adopt, create and
the Recurring Gift link are exercised for real.

Why not a throwaway deployed environment: it costs a D1, two queues and four secrets, and a new
`env` block risks the route-inheritance problem (an environment without explicit `routes: []` can
take over a live custom domain on first deploy). Local gives the same code path for the part under
test. A deployed `rehearsal` environment is the fallback only if the local queue turns out to
behave differently from Cloudflare's for this Worker.

Needs from the person running it (I won't handle tokens): a `.dev.vars` in `funraise-sync/`
(gitignored) with `MONDAY_API_TOKEN` (the sandbox integration user), `FUNRAISE_WEBHOOK_SECRET` (any
throwaway value; the replay sends the same one) and, for the installment stage, `FUNRAISE_API_KEY`.

## Scenarios

Each line is a command, an expected result, and the check. Run in order; S3 and S4 change sandbox
boards, so confirm before running them.

**S0 — preflight.** `replay-window.mjs --since 2026-09-01T00:00:00.000Z --dry-run`. Expect
71 replayable, 0 not, no `-1`, exit 0. A `--since` in the future gives 0 and exit 0.

**S1 — overlap, the real window (adopt).** Empty local D1. Replay all 71. Expect 71 `enqueued`,
and in the consumer: 71 adopted, 0 created.
* Check: the Donations board's item count is unchanged, and for every `entity_id` the local D1's
  `monday_item_id` equals the sandbox D1's. This is the central claim of the decided design: an
  overlapping window is safe.
* Before running, hand-edit **Gift Type** on one Donations item. After: it is unchanged. Adopt
  must not rewrite first-write stamps.

**S2 — idempotency.** Run S1's command again. Expect 71 `duplicate`, 0 `enqueued`, no Monday
writes in the consumer log, exit 0.

**S3 — create path.** Choose three gifts: a one-time `Complete`, an installment, and a `Failed`.
Delete their Donations items, reset the local D1, replay. Expect those three created once each
(Funraise link, Donor link, Thank You Sent, Gift Type, Fiscal Year Ending, Recurring Gift link for
the installment) and 68 adopted; board count back to its original value.
* **Cleanup, required:** the sandbox Worker's `events` rows for those three now point at deleted
  items. `UPDATE events SET monday_item_id = NULL WHERE entity_id IN (…)` on the sandbox D1 so a
  later edit adopts the new item instead of failing. Deleting and recreating also makes
  `donation-rollups` (sandbox) recompute the owners; expected.

**S4 — stale guard, and the `Refunded` prerequisite.** With `curl`, send one replayed
transaction's stored envelope with `sentAt` one lower: expect `{"ok":true,"duplicate":true}` and
the item untouched. Then send it with a *higher* `sentAt` and `transaction.status: Refunded`:
expect an `enqueued` answer and, **if the `Refunded` label exists on Donations → Status**, the item
flips; if not, the write dead-letters after about 21 minutes. Either result is the finding: it
checks runbook step 4.2's prerequisite. Revert with a later `Complete` envelope.

**S5 — archived-year flag.** Send a synthetic envelope: a new transaction id, `donationDate` in
January 2025, and the `supporter.id` of an *existing* donor (taken with
`json_extract(raw_payload,'$.supporter.id')`, which is not PII), so matching finds the donor
instead of creating one. Expect the local row `needs_review`, no Donations item created, one error
line naming the transaction id.

**S6 — failure paths.**
* Wrong secret: exit 1, `STOPPED at <first id>`, local `events` still empty.
* Target down (stop the dev server): every delivery `failed`, exit 1. Start it again and re-run:
  all `enqueued`. This shows the script is resumable.
* Optional, deployed-only: `--pause-ms 0` against 71 to see whether the 60/min rate limiter's
  response classifies as `failed` rather than `auth`.

**S7 — installments with the ledger filled (the runbook's order).** The runbook runs the
subscriptions bootstrap walk before the replay so installments find their Recurring Gift in the
ledger. Copy the sandbox `subscriptions` and `poll_cursors` tables into the local D1, reset
`events`, replay, and expect no Funraise subscription lookups in the consumer log. Without the copy
(S1), each distinct subscription costs one Funraise API request against the 3,000-a-month budget.

## Exit criteria

S0–S6 pass, S7 shows the lookup count drop to zero, and the output is kept. Then update the
runbook's `BUILD: TBD (#48)` for the replay rehearsal, and record any divergence, in particular
anything the local queue did differently.

## What this does not prove

* **The production D1's starting state.** Still its own pre-step 6.2 count of `events`,
  `subscriptions` and `poll_cursors`.
* **A deployed queue and its pause behavior**, production secrets and URL, and rate-limit
  enforcement on a deployed Worker. The local run uses Wrangler's simulations of those.
* **Production boards and columns.** The `Refunded` label, `entityIdColumn` and the Funraise-ID
  lookup against production ids; these are step 4.2 and step 6.2 work.
* **Real traffic during the window**, and the consumer's behavior at volume. 71 is small and
  `Failed` and `Complete` gifts only.

## Cost and risk

About 1.5–2 hours. Monday API use is on the order of 200 calls. The risk is in S3 and S4, which
change a handful of sandbox Donations items; both have a stated revert or cleanup, and neither
touches production or Salesforce. S1, S2, S5 and S6 write nothing that persists beyond the local D1
(S1 rewrites the Funraise-owned columns of existing sandbox items with identical values).
