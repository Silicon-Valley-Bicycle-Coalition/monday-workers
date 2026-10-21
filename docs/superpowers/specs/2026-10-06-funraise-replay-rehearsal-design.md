# Funraise replay rehearsal — design

**Status:** partly run, 2026-10-06 and 2026-10-21 (see "Results"). The runbook (`monday-migration` `docs/23`,
step 5) requires the replay to be rehearsed before Gate A: "replaying one Worker's stored
deliveries into another has never been run." This is how to do that with what exists, what it
proves, and what it can't. Tool under test: `funraise-sync/scripts/replay-window.mjs` (!186), with
reject-and-flag (!185). S0, S1, S2, S4, S5, S7 and the wrong-secret case of S6 have run and pass
(S4's `Refunded` half confirms a known gap); S3 was blocked by a permission check and is the one
scenario left.

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

## Results (2026-10-06)

Run as designed: the merged `main` code (replay script, without !185) as `wrangler dev --env sandbox`
on a fresh local D1, the real sandbox D1 as the source, the real sandbox v3 boards as the write
target, with the Sandbox Integration token. Replays used `--pause-ms 1000` or more except where
noted.

| | Result |
|---|---|
| **S0** preflight | **Pass.** 71 replayable, 0 not, all `written`, no `-1`. A `--since` in the future gave 0 rows. |
| **S1** overlap (adopt) | **Pass.** 71 `enqueued`, 0 failed; the local D1 drained to 71 `written` within about 30 s. Donations board 3,899 items before and after. All 71 local `monday_item_id`s equal the sandbox ledger's. A before/after read of nine columns on the 71 items (Funraise link, Thank You Sent, Gift Type, Fiscal Year, Recurring Gift link, Donor link, amount, status, date) showed **no change**. A Gift Type hand-edited to `REHEARSAL-MARKER` before the run was still there after, so adopt does not rewrite first-write stamps. |
| **S2** idempotency | **Pass on the third run:** 71 `already present`, 0 failed, exit 0, and no consumer activity. The first two runs had failures; see below. |
| **S6** wrong secret | **Pass.** `STOPPED at <first id>` on HTTP 401 and nothing further sent; the local `events` table stayed empty. |
| **S6** target down, then up | Not run as such. The 429 runs below showed the same recovery: a re-run after the cause cleared completed. |
| **S3** create path | **Not run: blocked.** Claude Code's auto-mode permission check refused the `delete_item` calls on three sandbox Donations items (an installment, a one-time `Complete` and a `Failed`, chosen and recorded first), even after the user approved the sandbox writes. Nothing was deleted, and the create path (`createItem` for a gift with no existing item) is still unrehearsed. Re-run it with the deletion done by hand or under an explicit permission rule. |
| **S4** stale guard | **Pass.** An envelope for a replayed transaction with `sentAt` 1,000 ms older than the stored one answered `{"ok":true,"duplicate":true}`; the item's amount and status were unchanged. |
| **S4** `Refunded` | **Confirms the gap, and shows how it fails.** A newer envelope with `transaction.status: Refunded` was accepted (`{"ok":true}`) and the consumer's write was rejected by Monday: *"This status label doesn't exist, possible statuses are: Received, Received (Historical), Failed, Pending"*. The `events` row went to `failed` with that error, and the item stayed `Received`. The sandbox Donations Status column has **no `Refunded` label**, so runbook step 4.2 is a real prerequisite: on the deployed Worker every buffered refund would retry 1, 4 and 16 minutes and then dead-letter. Nothing needed reverting. No label was added. |
| **S5** archived-year flag | **Pass** (run after !185 merged, on `main`'s code). A synthetic envelope, transaction `99000001` dated 2025-01-15 (FY 2025), $1, built from an existing donor's payload shape so matching found the donor, item name "REHEARSAL S5 (synthetic, archived-year)". The route answered `{"ok":true}`; the local `events` row went to `needs_review` with no Monday item and the error *"needs review: transaction is in fiscal year 2025, before the oldest active year 2026, and no active Donations item carries its Funraise ID … Nothing was created."* The Donations board stayed at 3,899 items and none carries Funraise id `99000001`; the log has one error line naming only the id (no `@`), so the message was acked and not retried; the donor was matched, not created. |
| **S7** installments, ledger filled | **Pass (2026-10-21,** `main` at `174c4bc`). Same setup as S1 (`wrangler dev --env sandbox`, fresh local D1, sandbox v3 boards, Sandbox Integration token), with the sandbox D1's `subscriptions` (1,176 rows) and `poll_cursors` (2) exported with `wrangler d1 export --table … --no-schema` and loaded into the local D1 first. `FUNRAISE_API_KEY` was a dummy value: without one the consumer has no Funraise client and skips the ledger lookup too (`not wired`), so S7 would prove nothing; with a dummy, a ledger hit never calls Funraise and a miss would fail with a 401 and log `could not resolve Recurring Gift`. The window has grown since S1: `--since 2026-09-01T00:00:00.000Z` now holds **114** transactions, **78** of them installments across 73 subscriptions, all in the ledger. Replay at the default `--pause-ms 2000`: 114 `enqueued`, 0 failed, exit 0. The consumer drained to 114 `written`, every local `monday_item_id` equal to the sandbox ledger's; the log has **0** `could not resolve`, `not found in Funraise` or `not wired` lines and no errors or 429s, so there were no Funraise lookups; the local `subscriptions` table stayed at 1,176 rows with nothing newly written. Donations board 3,942 items before and after, and a full before/after read of every column on the 114 items showed **no change**. All 78 installments' Recurring Gift links (read as `linked_item_ids`; a connect column's `text` and `value` come back empty) point at the Recurring Gifts item the ledger names: 78 match, 0 empty, 0 different. |

The marker edit was reverted (Gift Type back to `Donation`) and the local Worker stopped. Nothing
else on the sandbox boards differs from before.

### Finding: the 60-requests-a-minute limiter, shared across runs

The first S2 run, at `--pause-ms 100`, ended with 60 `already present` and **11 failed**; the
second, at 1,500 ms, with 57 and **14 failed**. Every failure was `HTTP 429 rate limit exceeded`
from the Worker's `REQUEST_RATE_LIMITER` (60 per 60 s, keyed per client). The first burst used up
a window and the next run's opening requests landed in it. Both runs exited 1, which is correct:
the script counts a 429 as `failed`, not as `auth`, so it neither aborts nor hides it, and a
re-run after the window cleared completed cleanly. So:

* Keep the default `--pause-ms 2000` (30 a minute). Do not drop it low for speed: a cutover
  window is tens of gifts.
* After any run that ended with 429s, wait a minute before the re-run, or the re-run collides with
  the same window.
* Production is keyed on `CF-Connecting-IP`, so the limit applies to the operator's address; the
  local run used the fixed `local` key, so the same behavior is expected but has not been seen
  deployed.

### Finding: remote D1 reads failed mid-session (Cloudflare error 7403)

Earlier on 2026-10-06, `wrangler d1 execute svbc-funraise-sync-sandbox --remote` worked for the
preflight, the item-id mapping and the candidate selection. Later in the day the same call, under
the same OAuth login (`wrangler whoami` still reported it logged in), returned *"The given account
is not valid or is not authorized to access this service [code: 7403]"*. It is a Cloudflare-side
authorization error, not an expired login (that one gives a different message and was fixed
earlier by `wrangler login`). The cause is unknown: the login may have been refreshed with fewer
scopes, or something changed on the account.

* **What it means for cutover:** `replay-window.mjs` reads the **source D1 through wrangler**, so
  it would fail the same way. Check `wrangler d1 execute <db> --remote --command "SELECT 1"` on the
  operator's machine before the weekend, and `wrangler login` again if it fails. Do not discover
  this at step 6.2.
* **How S5 went around it:** it needed only one stored payload, which the local scratch D1 from S4
  already held, so the envelope was built from that. The replay scenarios themselves (S0–S4) all
  ran before the error appeared.
* **Not yet diagnosed:** whether a fresh `wrangler login` clears it. The script's stderr fix (!187)
  does surface the message, so the failure is at least readable.

## Exit criteria

S0–S7 pass (S0, S1, S2, S4, S5, S7 and the wrong-secret case of S6 already have; S3 needs a way past the deletion block), and the output is kept. Then update the
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
