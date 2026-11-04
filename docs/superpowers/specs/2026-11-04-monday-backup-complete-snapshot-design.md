# monday-backup: a complete snapshot, split across a Workflow

**Status:** proposed 2026-11-04. Nothing built yet.

## Why

Production `svbc-monday-backup` first ran on 2026-11-04 and captured 19 of about 262 boards and none
of the 24 docs. Monday is the sole copy of SVBC's donor data since the Salesforce migration, so the
backup has to finish. It also has to say plainly when it did not.

## What the first run showed

Sources: `snapshot_runs` row 1, the run's `manifest.json`, the `createdTime` of each Drive file (the
moment its upload closed), Workers Observability, and read-only Monday queries. Observability holds
only the invocation summary, so there are no per-request timings or retry counts. Timings below are
derived from file timestamps.

**It ran out of time at a steady pace; it did not stall.** CPU was 775 ms of 725 s of wall time.

| Board | Items | Bytes | Seconds | Per 100 items |
| --- | --- | --- | --- | --- |
| Donor Roll Call | 1,671 | 2.1 MB | 45 | 2.4 s |
| Volunteers | 3,936 | 4.7 MB | 88 | 2.1 s |
| Donations | 4,190 | 16.9 MB | 130 | 3.0 s |
| Event Registrations | 6,922 | 15.8 MB | 155 | 2.2 s |
| Recurring Gifts | 1,176 | 2.0 MB | 27 | 2.1 s |
| Affiliations | 6,344 | 10.7 MB | 136 | 2.1 s |
| Empty or one-item boards (11) | 0–6 | ~1–6 KB | 5–8 each | n/a |

`People (Historical)` started at 09:11:41 and was cut off at the 12-minute budget 40 s later. Its
abandoned upload left no file, as designed.

**Limits and retries did not use up the time.**

- Complexity is nowhere near a limit: about 55 per item on `Events`, so roughly 5,500 per page of
  100, against a budget of 20,000,000 a minute.
- Page time holds at 2–3 s across boards. It scales with response size (Donations is the largest per
  item), not with anything that looks like backoff. A retry waits at least 2 s, so repeated retries
  would show up as outliers, and none do. This is an inference: the transport doesn't log retries.

**Account-wide overuse did not visibly contribute.** The account used 120,916 calls on 2026-11-04
against a limit of 10,000, but Monday isn't enforcing that yet (`DAILY_LIMIT_EXCEEDED` is announced
for 2027), and the run shows no throttling signature. The run itself made only about 350 calls, so
it isn't the cause of the overuse either. A complete nightly run will cost an estimated 1,500–2,000
calls, 15–20% of the limit, which matters once enforcement starts.

**A complete run takes about an hour.** Estimated at the measured rates, run serially:

| Part | Minutes |
| --- | --- |
| What was captured on 2026-11-04 | 12 |
| Remaining ~243 boards at ~6 s minimum each | 24 |
| People, People (Historical), Organizations, plus smaller boards | 8 |
| Activities and Campaigns, once visible (below) | 4 |
| 24 docs | 3 |
| **Total** | **~51** |

The overhead dominates: each board costs five sequential requests before it holds any data (schema,
upload session, items, updates, closing the upload). The largest single board is about 4 minutes, so
every unit of work fits comfortably in one invocation, and only the whole does not.

**Board order starves the same boards every night.** `boards` returns descending id, and the run
works straight down that list. The 12-minute mark lands in the same place each night, so `People`,
`Organizations`, the Sponsorship boards and every doc would never be backed up.

**A partial run counts as healthy to the watchdog.** `lastSnapshotAt` accepts `partial`, so a run
holding 19 of 262 boards resets the 36-hour staleness clock. Only the per-run Slack alert says
otherwise. Its stuck-run threshold (1 hour, "no run can outlive the 15-minute cron cap") also can't
survive a run that legitimately takes an hour.

**The manifest can't report boards it can't see.** `Activities` (9,000 items) and `Campaigns` (2,818)
are in the production CRM workspace and appear nowhere in the manifest: not captured, not skipped,
not deleted. Both are private boards, and SVBC Integration isn't a subscriber, so `boards` never
returns them to its token. The same goes for three small legacy boards (`Donations`, `Donors`,
`Subitems of Donors`) and one scratch board. A run that finishes every board it can see would still
report `success` while missing 9,000 activity records.

**The zero update counts are real.** `updateCountsByBoard` is 0 on all 19 boards, but an independent
token also finds no updates on four of them, and does find one on a board the run didn't reach. The
Read-only app also holds `updates:read`. The first complete run should show non-zero counts on boards
like `Development: Marketing and Communications Projects`.

**The sandbox can't rehearse this.** `svbc-monday-backup-sandbox` has failed every night
(`Cannot read properties of undefined (reading 'replace')`, run 39 and earlier): it has no
`GOOGLE_SERVICE_ACCOUNT_*` or `SLACK_WEBHOOK_URL` secrets, and `config/backup.sandbox.json` still
holds a placeholder folder id and the old sandbox workspace id. Its Slack alert can't fire either,
so nobody has heard about it.

## Goals

- Every board and doc the integration user can see is captured every night, with no 15-minute
  constraint on the whole run.
- `success` means complete, including the boards we know must be there. Anything less alerts, and
  doesn't satisfy the watchdog.
- A retried board never leaves two same-named files in a snapshot folder.
- The manifest and `RESTORE.md` say honestly that a snapshot spans a window of time.

## Non-goals

- Reducing the account's API overuse. That's a separate investigation.
- Parallelism. An hour at 01:00–02:00 Pacific is fine, and serial keeps the load and the code simple.
- File contents, automations, or anything else `README.md` already lists as out of scope.
- Making the sandbox work. A follow-up (see Rollout).

## Design

### A Workflow, one step per board or doc

The README's direction holds up against the evidence: a bigger single run is impossible at a hard
15-minute cap with about 51 minutes of work, and each board fits easily in a step.

| Option | Verdict |
| --- | --- |
| **Workflow, a step per board** | **Chosen.** No wall-time limit per step, built-in retries, and step results survive restarts, so the run reads top to bottom with no bookkeeping. New to this repo, and also a new thing for a fork to learn. |
| Queue, a message per board | Familiar here, but each message has the same 15-minute limit, and knowing when the run is done means hand-built fan-in counting in D1. |
| Cron every 15 minutes resuming from D1 | A hand-written version of what Workflows provides. |
| Concurrency inside the cron | Would need 5x or more with no headroom, and a failure still loses the run. |

The `0 9 * * *` cron stops doing the work. It reads the write switch and calls
`env.SNAPSHOT.create({ id: 'nightly-<scheduledTime>' })`. The Workflow
also runs on demand with `npx wrangler workflows trigger svbc-monday-backup-snapshot`, which is how
the first production run gets tested without waiting for 09:00 UTC.

`SnapshotWorkflow.run()`:

1. `start`: read the switch, then insert the `snapshot_runs` row. Returns `{ runId, startedAtUtc }`,
   or stops with no row if the switch isn't `on`, matching today's skip.
2. `folder`: `ensureFolder`, already idempotent by name.
3. `list boards` and `list docs`: return in-scope summaries with deleted boards moved to
   `deletedBoardsSkipped`, ordered so `config.priorityWorkspaceIds` comes first (see Order). Listings
   stay well under the 1 MiB step-result limit (about 262 summaries of a few hundred bytes).
4. `board <id>` per board: returns `{ itemCount, updateCount, subitemBoardIds, startedAt, finishedAt }`.
   A newly found subitems board is appended to the list, which is deterministic because the list is
   built only from step results.
5. `doc <id>` per doc, likewise.
6. `manifest`: upload `manifest.json`, then `finish`: write the D1 row and send the partial alert if
   there are errors.

**Failure handling.** Every step: `retries: { limit: 2, delay: '1 minute', backoff: 'exponential' }`,
`timeout: '30 minutes'`. Board and doc steps run inside `try/catch` in `run()`, so a board that
exhausts its retries becomes an entry in `errors` and the run carries on. An uncaught failure before
the board loop (Drive auth, say) calls the existing `recordRunFailure` and alert, then rethrows.

**In-memory state doesn't survive hibernation,** so counts and errors are rebuilt from step results
as `run()` replays, and nothing else is kept outside a step.

**Giving up.** Ten board or doc failures in a row end the run as `partial`, with an alert and an entry
saying so. A failing step costs at least 3 minutes, so an outage would otherwise take over 14 hours
and pass for a stuck run.

**The per-step deadline stays, per step.** Each board step builds its clients with a fresh `Deadline`
at 25 minutes, so a stuck call fails with a clear `BudgetExhaustedError` before the step's own opaque
30-minute timeout. The 12-minute budget, its `pastDeadline` checks and the finalize grace all go.

**Monday daily limit.** `DAILY_LIMIT_EXCEEDED` becomes a `NonRetryableError` so each board fails fast
once enforcement starts, recorded as usual. The run ends `partial`, with the priority workspace
already captured.

### Retrying a board must not duplicate a file

Drive allows duplicate names, and the service account is a Contributor, so it can't delete. A step
that closed its upload and then failed before returning would otherwise write a second
`board-<id>.jsonl` on retry, which Drive would zip as `board-<id> (1).jsonl`.

So board and doc steps first look for that filename in the run folder. Files appear only when an
upload closes, so an existing file is complete: the step takes its counts by streaming it back and
returns without re-uploading. `DriveClient` gains `findFile` and a way to read a file's lines.

Accepted risks, both narrow: Drive listings can lag, so a retry could miss a just-closed file and
write a second copy, which the at-least-1-minute retry delay makes unlikely. And a `start` step
repeated after its insert committed leaves a stray `running` row, whose only effect is one false
"never finished" alert 12 hours later.

### Status means complete

- `success` requires no errors **and** every id in the new `config.requiredBoardIds` present in the
  listing. A missing one is an error: `board <id>: required but not visible to this token`.
  Production lists the CRM boards in workspace `18201685`: People `18437909781`, People (Historical)
  `18437909784`, Organizations `18437909779`, Donations `18437909794`, Activities `18437909798`,
  Campaigns `18437909788`, Event Registrations `18437909792`, Events `18437909790`, Volunteers
  `18437909797`, Affiliations `18437909787`, Recurring Gifts `18437909789`. (Not the legacy `Donations`
  board, `8845443596`.) This is the guard for silently invisible private boards, and new boards are
  added by hand. Sandbox: empty. The list ships in the first MR, complete, so the subscriber change
  (Rollout) lands before the merge rather than after it.
- `lastSnapshotAt` counts only `success`; the alert reads "no complete snapshot in over 36 hours".
  Partial runs keep alerting individually. If one board fails nightly you get both alerts, on purpose.
  **On deploy this alert fires on the first hourly check,** because no run has ever been complete and
  the watchdog was armed on 2026-11-03. That's true, so it stays: no re-arming and no migration. It
  repeats at most every 24 hours until the first `success`.
- `STUCK_RUN_MS` goes from 1 hour to 12 hours. `abandonStaleRuns` keeps working, and a very late
  finisher can still overwrite `abandoned` with its real result, which is the truth.
- **Write switch mid-run.** Board and doc steps read the switch. An explicit `hold` or `off` stops the
  run: a new `stopped` status (a free-text column, so no migration), no manifest and no alert. A KV
  read error throws so the step retries it, and a persistent one is recorded like any failed board. A folder
  without a manifest already means "don't use" in `RESTORE.md`. This reads once per step rather than
  once per run, because a run now lasts an hour and `hold` has to take effect.

### Order

`config.priorityWorkspaceIds` (production: the CRM workspace, `18201685`) sorts first, stable within
it; docs follow boards. Order no longer decides what gets captured, but if a run dies or hits the
daily limit, the donor data is already safe.

### Not a point in time

A run spans about an hour, up from 12 minutes, so the snapshot is a sequence of per-board captures.
A link from a board captured late to an item created after its target board was captured can't be
remapped. The restore already handles this: it drops the link and reports it (`restore.ts`, "dropped
(not in this restore)"). 09:00 UTC is quiet, though Workers do write overnight.

- **Manifest**, additive, so `monday-backup/2` stays and older snapshots still read: `finishedAt`,
  and `capturedAt: { "<id>": { startedAt, finishedAt } }` for each board and doc.
- **`RESTORE.md`:** a section saying a snapshot is captured board by board over a window, what that
  can produce (a dropped link warning for a very recent item), and to read the window from the
  manifest. For "undo a bad change", pick a run whose window ended before the change.
- **`parseSnapshot`:** no change needed beyond typing the new fields.

### Observability

One log line per board or doc: id, counts, milliseconds, requests and retries, counted through the
transport's `fetchFn` option so `graphql.ts` stays byte-identical (a retry is the same query sent
again, whatever the reason). This fills the gap that made this investigation rely on file timestamps.

### Config and docs

- `wrangler.jsonc`: a `workflows` entry (name `svbc-monday-backup-snapshot`, binding `SNAPSHOT`,
  class `SnapshotWorkflow`) in both environments; the sandbox's name ends `-sandbox`. Keep
  `limits.subrequests: 50000`, which leaves plenty of room for an estimated 3,000 a run.
- `README.md`: status, data flow, the plan-limits paragraph, failure visibility.
- `docs/uat/monday-backup.md` if it describes the run.

## Testing

`run()` delegates to a plain function taking a `step` interface, tested with a fake step (runs each
callback, records names, supports forced failures and replay). `backup.test.ts` moves onto it.
Cover: retry finds an existing file and doesn't re-upload; a board exhausting retries lands in
`errors` and the run continues; a discovered subitems board is appended; a missing required board
makes the run `partial`; priority order; replay rebuilds counts; the switch stopping mid-run.
`watchdog` and `runs` tests change for `success`-only and the new threshold. One smoke test through
`@cloudflare/vitest-plugin`'s Workflow introspection proves the class and binding are wired.

Before merging, try the never-yet-live queries by hand with one read-only call each: doc `blocks`
paging, and `items_page` on a `custom_object` and a `document` board. If those error nightly, the run
is `partial` forever until they're handled.

## Rollout

1. Add SVBC Integration as a subscriber on Activities and Campaigns (a production change, needing
   approval; see Open decisions), before the merge, so `requiredBoardIds` is satisfiable from the
   first run.
2. MR with tests. **Merging deploys to production** through Workers Builds (the first merge touching
   `monday-backup/src/`, so it also proves the watch path; confirm the deployed version afterward).
3. `wrangler workflows trigger`, watch it, then check `snapshot_runs` for `success`, and check that
   Drive has one file per manifest entry with matching counts.
4. Boards that fail for structural reasons get fixed or added to `excludeBoardIds` with approval.
5. Keep the 09:00 UTC cron as the ongoing test: the next night's run should match.

No sandbox rehearsal: it would first need a service account, a Drive folder and a Slack webhook, and
this run is read-only on Monday and only adds a new folder to Drive. Fixing the sandbox is a
follow-up, along with its stale `MONDAY_API_TOKEN` secret and workspace id.

**Until this ships,** each 09:00 UTC run repeats the same 19 boards.

## Open decisions

1. **Add SVBC Integration to the private boards?** Required for Activities and Campaigns to be backed
   up. The catch is that all three OAuth apps act as this one user, so the internet-facing
   `member-portal`'s read-only token can then read these boards too (the risk the root README already
   accepts for what that user sees). The alternative is a separate backup-only Monday user, which
   needs a seat and a new consent.
2. **The legacy `Donations`, `Donors`, `Subitems of Donors` and the scratch board.** The token can't
   see them, so by default they stay out and `excludeBoardIds` stays empty. Backing them up means
   subscribing SVBC Integration to them as well. Default taken unless told otherwise.

## Left to the builder

Internal names, exact file layout, how the fake step is shaped, and whether re-reading an existing
file takes subitem ids from its header line or re-queries the schema.
