# people-reclassification

**Staff UAT script:** [`docs/uat/people-reclassification.md`](../docs/uat/people-reclassification.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status: Live in sandbox, writes on** (2026-11-03; Deploy step 6). The daily cron continues
the remaining work (about 270 moves) on 2026-11-04 at 10:00 UTC, then runs quarterly. Deploy steps 1–5 are done against CRM
Sandbox v4: one live move succeeded and kept every value and link checked (see "Move
mechanics"), after fixing the `columns_mapping` it sends. A full live pass followed
(2026-11-03 01:03–01:23 UTC): **400 of 400 moved** to People (Historical), 0 failed or
ambiguous. People went from 8,084 to 7,683 items and Historical from 8,053 to 8,454. Two moved
people compared column by column were identical. All 86 Volunteers and 35 Event Registrations
records linked to moved people still link to them. About 137 to-historical and 133 to-live
moves remain for the next pass. Writes were then turned back on and left on (step 6,
2026-11-03).

Two things to know when operating it:
* **A pass reads the write switch once, at its start.** Turning writes off mid-pass does not
  stop that pass, only the next one.
* **`POST /reclassify/run` outlives its HTTP request.** A 400-move pass takes about 20 minutes,
  and the client connection drops after about 2 minutes (curl reported `HTTP 000`), but the pass
  keeps running. Follow it in `runs` and `moves` (or `GET /reclassify/status`), not the
  response. Production is not provisioned: no D1, and
`config/svbc.json` still holds `0` board ids (the production `svbc-people-reclassification` is
only a placeholder created by setting `RECLASSIFY_SECRET`: no D1, no cron). Every Monday write
ships **off** (the write switch `people-reclassification:writes` is unset, which means `off`).

First sandbox dry run (2026-11-02, cutoff 2019-11-02): 8,084 People / 8,053 Historical scanned;
538 people decided to-historical and 133 to-live; 400 to-historical planned (the
`maxMovesPerRun` cap; to-historical is planned first), all `aged-out` with latest activity
2001-01-01 to 2019-05-10. Three sampled items checked by hand: the latest activity matched
max(Last Gift Date, Member Until), no Lifetime tier, no Funraise profile. It first aborted on
column parity (`Campaign` tags and a hand-added `monday Doc v2` on People only); the spec now
gives both People boards the same columns (`salesforce-import` `PEOPLE_COLUMNS`), `Campaign` was
added to both Historical boards, and the sandbox-only doc column was deleted.
**Priority:** Post-cutover. The import lands People at ~74% of the ceiling; the plan's own
trigger line is 85%, and the growth analysis puts a 7-year window at ~71% today, so this is
headroom maintenance rather than a cutover blocker — but it is the only thing that will ever
move anyone between the two boards.
**Owner:** David (decided 2026-10-09).
**Stack:** Hono + TypeScript + D1 (the shared stack, see `../README.md`); a daily cron and an
authenticated HTTP trigger; no queue (a failed pass is continued by the next day's cron).

## The ask

Monday caps a board at 10,000 items on SVBC's Pro plan. `salesforce-import` keeps the People
board under it by splitting people between **People** (activity since a fixed date,
`peopleActiveSinceISO: 2019-01-01`) and **People (Historical)**, but that split is computed once
at import: a fixed cutoff only ever adds people to the live board, nobody ages out, and a lapsed
donor on Historical who gives again stays where staff don't look day to day. The private
planning repo's `migration-plan.md` ("Decisions Needed → Still open", first bullet) asks for a
periodic pass that replaces the fixed cutoff with a **rolling 7-year activity window**
(window size decided 2026-09-21, sized by `scripts/analyze-people-rolling-window.mjs`), moves
people out of the live board when their latest activity falls outside it, moves reactivated
people back, runs quarterly or whenever the live board crosses ~85% of the ceiling, and warns
when People (Historical) nears its own ceiling. This Worker is that pass.

Decided 2026-09-30: the import keeps the 2019 cutoff for cutover itself; the window takes
effect only once this Worker runs.

## Data flow

```
Cloudflare cron, daily 10:00 UTC ──► src/duties.ts: does today owe a pass?
                                      quarterly (1st of Jan/Apr/Jul/Oct, caught up later in the
                                      month if missed) · threshold (People ≥ 85% of the ceiling,
                                      no pass this week) · continuation (last pass left work)
POST /reclassify/run           ──►   the same pass, on demand (follows the write mode; ?dryRun=true forces a plan-only pass)
                                            │
                                            ▼
                             src/pass.ts — one pass, reads first, then writes
  0. take the D1 pass lease — one pass at a time, cron or HTTP; a pass that finds it held is skipped
  1. settle any 'planned'/'ambiguous' ledger rows from an interrupted pass (where is the item now?)
  2. read both People boards' schemas; resolve every column by TITLE; build the move mapping;
     refuse the pass if the boards disagree on any value-bearing column
  3. page People + People (Historical): Last Gift Date, Member Until, Membership Tier, Funraise Profile
     page Events (Date) and Event Registrations (Attendee, Event, Attendance, Source)
     page Volunteers (Volunteer, Date)
  4. classify every person (src/classify.ts) — live / historical / no evidence
  5. plan: aged-out live people → Historical (longest-lapsed first); reactivated Historical
     people → People (most recent first); capped by run.maxMovesPerRun and each board's room
  6. for each move: ledger row 'planned' → move_item_to_board(columns_mapping) → 'moved'
     (dry run: row 'dry-run', no Monday call)
  7. warn if Historical is at ≥ 80% after the pass; optionally raise one IT Requests item per cooldown
                                            │
                                            ▼
              D1 ledger (runs, moves, alerts, pass_lease) — every decision, auditable; GET /reclassify/status
```

### The liveness rule (`src/classify.ts`)

Mirrors `classifyContact` in `salesforce-import/src/transform/people.ts` and the sizing script's
replay of it, with the fixed cutoff replaced by `today − window.years` (same month and day; the
date is read in `window.timeZone`):

| Signal | Source | Effect |
|---|---|---|
| Linked Funraise supporter profile | People `Funraise Profile` (link, non-empty) | **Never ages out** — the import rule; the sizing analysis counted these 2,004 people as perpetual, and `perpetual.funraiseLinked` can turn it off |
| Lifetime member | People `Membership Tier` = `Lifetime` | Never ages out |
| Current member | People `Member Until` after today | Live (a placeholder term decades out counts too — the analysis folded those 127 into the always-live bucket) |
| Last gift | People `Last Gift Date` — donation-rollups' rollup, kept current on **both** boards | Activity date |
| Membership term end | People `Member Until` on or before today | Activity date |
| Event registration | Event Registrations → the linked Event's `Date`, counted when `Attendance` ∈ `countedAttendanceLabels` (`Attended`) **or** `Source` ∈ `countedRegisteredSources` (`Funraise`) — the import's "a Funraise registration is a paid ticket; an Eventbrite registration counts only once checked in" rule (decision 2026-09-08) | Activity date |
| Volunteer hours | Volunteers `Date`, via the `Volunteer` link | Activity date (optional source; `volunteers: null` turns it off) |

Latest activity = the max of the activity dates; dates after today are ignored as data-entry
defects (docs/07's `CloseDate` finding), except Member Until, which is clamped to today. Live
if latest activity ≥ cutoff, historical if before it. **No evidence at all → left in place and
counted** (`verdicts.unknown` in the report): advocacy contacts (Stakeholder Type = City or
Agency Staff / Elected Official) and anyone staff add by hand leave no gift, term or
registration behind, and sweeping them to Historical on absence would be wrong. Staff Task
activity (`recentActivityIds` in the import) is not a source: the sizing analysis left it out,
and the Activities board holds two years of it, inside any window.

Rollup columns that already exist on People are used in preference to re-scanning Donations:
`Last Gift Date` is donation-rollups' maintained rollup (it writes all three owner boards, so a
Historical person's new gift shows up there within minutes), and `Member Until` is written by
the import and by donation-rollups' renewal path. Registrations and volunteer hours have no
rollup on People, so those two boards are paged (~7k and ~4k items in the sandbox; the Events
board, ~250, supplies the dates).

### Move mechanics — what a move keeps

`move_item_to_board` keeps the item id, its updates and its description; what it does to column
values depends on `columns_mapping`. **The rules, probed against sandbox v4 on 2026-11-02**
(the API docs say most of this; the community advice this Worker first followed did not):

* Given at all, `columns_mapping` must have an entry for **every source column except the name
  column**. Leaving any column out, or including the name, fails with "Columns mapping is not in
  the expected format". So does any mapping on API versions 2026-07, 2026-10 and 2027-01 alike.
* A `target: null` entry is accepted and drops that column's data. Formula columns can't be
  mapped, so they are always null.
* Connect columns **are** mapped explicitly, like any other column.

So:

* The two People boards are created by the import from one column spec, so titles agree while
  ids differ per board. Each pass reads both schemas and builds an **explicit mapping of every
  column but the name** by title + type (`src/columns.ts`), leaving nothing to "best match";
  a column with no counterpart maps to null, which is only allowed for types holding no value
  of their own (formula, mirror, auto-number, …).
* **If either board lacks a column the other has, the pass refuses to move anything** and names
  the columns — a column added to one board by hand (as happened to Donations in the v3
  rebuild) would otherwise silently lose values.
* **Inbound links survive by construction, not by the move:** the import creates every connect
  column that points at people (`Donor`, `Soft Credit`, `Attendee`, `Volunteer`, `Person`)
  connected to **both** People boards (`CONNECT_TARGETS` in `salesforce-import/src/load/boards.ts`),
  and the item id does not change, so a Donation's Donor link still resolves after the move.
  donation-rollups already handles the board change: it reads an owner's board at recompute
  time (`getItemBoardId` → `ownerColumnsByBoard`).
* **Verified on one live move** (sandbox v4, 2026-11-02, item `13398233886`, People →
  People (Historical), `maxMovesPerRun: 1` and writes on for that one pass). After the move:
  same item id; all 64 columns compared by title, and all 41 with a value were identical;
  `Organization` (one-way, stored on the person) and `Affiliations` links intact, and the
  Affiliation's `Person` still links back; a test update kept its id. Neither People board has
  webhooks (donation-rollups listens on Donations only), so a move triggers no recompute.
  **Not covered:** that person had no gifts, so inbound `Donor` links weren't exercised. They
  rest on the item id not changing (above).
  If a later move does lose a link, the fallback is to restore it from the ledger row (item id,
  both boards) and the Donations board's Donor column, and to prefer archive-in-place on the
  live board (archived items don't count toward the ceiling) over moving. That is a design
  change, not a config one.

### Dry run, ledger, idempotence

* **The write switch** (`people-reclassification:writes` in the shared FLAGS KV namespace; flip it
  with `node scripts/flags.mjs people-reclassification writes on|hold|off --env sandbox|production`)
  must be `on` for any Monday write — moves and the IT Requests alert alike. `off` (also a missing
  key) runs the pass as a dry run: it does the full read and records its plan as `moves` rows with
  status `dry-run`, so `/reclassify/status` shows what a live pass would do. `hold`, and `unknown`
  (the KV read failed), skip the cron run entirely: no Monday call, no ledger row. Without a query
  parameter `POST /reclassify/run` follows the mode (409 under `hold`/`unknown`);
  `?dryRun=true` forces a plan-only pass in any mode but `unknown`; the cron ignores such a
  preview when deciding whether a pass is due, so it never stops a continuation or uses up a
  quarterly or threshold pass (cron dry runs under `off` do count). `?dryRun=false` is rejected
  with 400 — it used to run one live pass while the old `DRY_RUN` var said true; set the mode to
  `on` instead. `/reclassify/status` reports the current `mode`.
* **Ledger** (`migrations/0001_create_ledger.sql`): `runs` (one per pass, with the report),
  `moves` (one per decided item: direction, the activity date the decision rested on, the
  reason label, status), `alerts` (IT Requests items raised). A `moves` row goes `planned` →
  `moved` only after Monday confirms (the cron-Worker invariant in `../CLAUDE.md`); a transport
  `AmbiguousWriteError` leaves it `ambiguous`; the next pass settles `planned`/`ambiguous` rows
  by asking Monday which board the item is on now, before deciding anything new.
* **Idempotence:** the cron's run id is the date plus the trigger, so a double-fired trigger
  finds the finished row and skips. Board state is re-read every pass, so a repeated pass moves
  nothing twice; an item already moved simply isn't on the source board any more.
* A pass stops after five consecutive move failures (Monday is unhappy, not one odd item) and
  reports `remaining`; the next day's cron continues.

## APIs & auth

* **Monday GraphQL** (`src/monday/graphql.ts`, the canonical transport copy; `src/monday/client.ts`
  tunes it to 4 attempts / 30 s per request). Reads: `boards { items_count items_limit columns
  groups }`, `items_page(limit: 500)` with `column_values` (+ `linked_item_ids` on connect
  columns), `items(ids:) { board { id } }`. Writes: `move_item_to_board`, and `create_item` on IT
  Requests when configured — both sent non-idempotent so a timeout is recorded, never retried blind.
* **Monday access:** from the `monday-auth` broker, not a stored token. Both deployments bind
  `MONDAY_AUTH` (`wrangler.jsonc` `services`) to its `SyncToken` entrypoint — the *SVBC Staff Sync*
  OAuth app, consented as SVBC Integration (production, `svbc-monday-auth`) or Sandbox Integration
  (sandbox, `svbc-monday-auth-sandbox`) — which needs access to both People boards, Events, Event
  Registrations, Volunteers and (production) IT Requests; moving items needs edit rights on both
  boards. `src/monday/graphql.ts` `tokenProviderFor` asks the broker per request and re-asks once on
  a 401. A `MONDAY_API_TOKEN` secret is only the fallback while the cutover is under way (delete it
  once the binding works); with neither, building the Monday client throws a config error naming
  both. Local `wrangler dev` has no broker to call, so put a `MONDAY_API_TOKEN` in `.dev.vars` for
  it. Design: `docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md`.
* **`RECLASSIFY_SECRET`:** shared secret for `/reclassify/*`, sent as
  `Authorization: Bearer <secret>` (never in the query string, where it would be logged with the
  URL); constant-time, fail-closed — unset disables the routes. Behind the repo-standard
  60/min/IP rate limit.
* **One pass at a time:** every pass, cron or HTTP, dry run or live, holds a single-row D1 lease
  (`pass_lease`, `migrations/0002_pass_lease.sql`) for its duration. A pass that finds it held is
  skipped — the cron logs it and tries again next day; `POST /reclassify/run` answers `409`. A
  lease whose holder died expires after 30 minutes.

## Monday targets

Boards by id, columns **by title** — resolved at the start of every pass, so no column id lives
in config and a renamed column fails the pass loudly rather than reading blanks.

| Config | Sandbox (`config/sandbox.json`, CRM Sandbox v4) | Production (`config/svbc.json`) |
|---|---|---|
| `boards.live` | People `18437342592` | `0` until cutover |
| `boards.historical` | People (Historical) `18437342607` | `0` |
| `eventRegistrations` / `.events` | Event Registrations `18437342649` / Events `18437342639` | `0` / `0` |
| `volunteers` | Volunteers `18437342662` | `0` |
| `alerts.itRequests` | `null` (log only — IT Requests is a production board) | `8846215481`, `Type` = `IT Support`, 30-day cooldown |

Column titles (`peopleColumns`, the registrations and volunteers `columns` blocks) are the ones
the import and donation-rollups create: `Last Gift Date`, `Member Until`, `Membership Tier`,
`Funraise Profile`, `Attendee`, `Event`, `Attendance`, `Source`, `Date` (Events), `Volunteer`,
`Date` (Volunteers). Checked against the CRM Sandbox v4 boards 2026-10-28: all present with the
expected types, and the two People boards' columns agree. The Events start date is titled
`Date`, not `Start` — `Start` is the Campaigns and Affiliations column — so the config's
original `startColumn: "Start"` would have failed every pass at the Events schema read.

Other config: `window` (`years: 7`, `timeZone`), `thresholds` (`itemsLimit: 10000`,
`liveTriggerPct: 85`, `historicalWarnPct: 80`), `run` (`maxMovesPerRun: 400` — with the
~60 page reads a pass makes, well inside Workers Paid's 1,000 subrequests per invocation;
`quarterlyMonths`), `perpetual`. `groupId: null` on a board means its first group.

## Sandbox environment — inbound only, no outbound data

`wrangler.jsonc` `env.sandbox`: `npm run deploy:sandbox` deploys `svbc-people-reclassification-sandbox`
against the CRM Sandbox boards in `config/sandbox.json`, chosen at request time by the
`ENVIRONMENT` var (`src/environment.ts`), with its own D1, FLAGS KV namespace and secrets; its write switch is independent of production's.
This Worker writes only to Monday, so the split exists so the two deployments can coexist after
cutover; `config/split.test.ts` fails if production shares a board id with the sandbox, if the
sandbox ever points at the production IT Requests board, or if `env.sandbox` shares a resource
with the top level. Design: `../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.

## Deploy

Steps 1–6 are done in sandbox (2026-11-02/03; the sandbox operator secret is
`RECLASSIFY_SECRET_SANDBOX` in `monday-migration/.env`). The sandbox write switch is `on`.
Production has not been started.
Before step 1 in any environment, check that the two People boards' columns match (same title
and type both ways): a pass aborts on any difference, and Monday's API can't create a
`direct_doc` column to fix one.

1. `wrangler d1 create svbc-people-reclassification-sandbox`; paste the id into
   `env.sandbox.d1_databases[0].database_id`; `wrangler d1 migrations apply
   svbc-people-reclassification-sandbox --env sandbox --remote`.
2. `wrangler secret put RECLASSIFY_SECRET --env sandbox` (Monday access is the `MONDAY_AUTH`
   binding to the sandbox broker, consented as Sandbox Integration — no token secret).
3. `npm run deploy:sandbox`. With the switch unset (`off`) the daily cron and
   `POST /reclassify/run` only plan. Every operator call carries the secret as a header:
   `curl -X POST -H "Authorization: Bearer $RECLASSIFY_SECRET" https://<worker>/reclassify/run`.
4. Read the plan: `GET /reclassify/status` (the last ten runs with their reports) and
   `wrangler d1 execute … --command "SELECT * FROM moves WHERE status = 'dry-run'"`. Check a
   sample of `aged-out` rows against the boards and against the sizing analysis's expectation
   (~7,150 live at N=7).
5. One live move: with `run.maxMovesPerRun` set to 1 (or after confirming the dry-run plan is
   tiny), `node scripts/flags.mjs people-reclassification writes on --env sandbox`, then
   `POST /reclassify/run`, and set the mode back to `off` (or `hold`) once it has
   moved. Verify that item's links and updates on its new board — see "Move mechanics". Then
   raise the cap and run the rest.
6. Only then leave `writes` at `on` so the quarterly cron runs live. Production: the same steps against the top-level block once cutover fills
   `config/svbc.json`'s board ids; Workers Builds / the `deploy-sandbox:people-reclassification`
   CI job follow the repo's usual pattern (root README "Deploys").

## Open

* **Continuation compares a UTC date with a Pacific one.** `decideCron` (`src/duties.ts`)
  checks `lastRun.startedAt.slice(0, 10)` (UTC) against `todayISO` (America/Los_Angeles). A pass
  started in the UTC evening can make the next morning's 10:00 UTC cron think it already ran
  "today", so the continuation slips a day. That's harmless, but it's why the 2026-11-03 01:03
  UTC pass continues on 11-04, not 11-03.
* **Which item limit?** Monday reports each People board's `items_limit` as **100,000**
  (sandbox v4, 2026-11-02). The threshold trigger prefers that over `thresholds.itemsLimit`
  (10,000; `src/index.ts`, `src/pass.ts` `countOf`), so it would fire at about 85,000 items.
  The Historical warning still uses 10,000. If 100,000 is the real ceiling on SVBC's plan, the
  headroom this Worker manages is far larger than the plan assumed: decide which number rules,
  then make the trigger and the warning agree.
* **Window granularity.** The sizing analysis compared calendar years (`refYear − year < N`);
  this Worker uses a rolling date (`today − 7 years`, same month/day), so people age out through
  the year in quarterly batches rather than all at once each January. The counts differ only at
  the edges; confirm this is the intended reading of "activity in the last N years".
* **Funraise-linked people never age out.** That is the import's rule and the analysis counted
  them as perpetual (2,004 today), but a supporter profile with no gift in 7 years is still a
  lapsed donor. `perpetual.funraiseLinked: false` makes them subject to the window — a policy
  call.
* **No-evidence people stay put.** Advocacy contacts and hand-added people are never moved; if
  the live board accumulates them, a `Stakeholder Type`-aware rule (pin some labels live, treat
  others as movable on the item's creation date) is the next step.
* **Inbound Donor links are untested live, though the mechanism is proven.** None of the 400
  people in the full pass had a gift on sandbox Donations. Inbound links of the same kind
  (`Volunteer`, `Attendee`) all survived, 121 of 121, so Donor links should too.
* **People (Historical) at 81% already** (sandbox, 2026-08-24; v4 at 80.5%, 2026-10-28). This Worker warns and refuses
  to overfill it, but the era split the plan's item 4 asks for is a separate design.
* **Activities board** as an activity source (staff touches) — deliberately out; revisit if
  staff expect a recent call to keep someone live.

## Development

```sh
npm test            # vitest, Workers runtime, D1 migrations applied per run
npm run typecheck   # wrangler types --include-runtime=false && tsc --noEmit
node ../scripts/check-log-safety.mjs   # from the repo root; no names or emails are ever logged
```

Tests mock the Monday client (`src/pass.test.ts`'s `fakeClient`) against the real D1 ledger.

## Sources

* `monday-migration/migration-plan.md` — "Decisions Needed → Still open" (first bullet, the
  mechanism; 2026-09-21 window size; 2026-09-30 cutover cutoff).
* `monday-migration/docs/11-salesforce-import-design.md` §1b–1d — the ceiling, the Donations
  era split, the People inclusion rule.
* `monday-migration/scripts/analyze-people-rolling-window.mjs` — the activity definition and
  the N=7 sizing.
* `salesforce-import/src/transform/people.ts` (`classifyContact`), `src/transform/index.ts`
  (the recent-activity sets), `src/load/boards.ts` (`CONNECT_TARGETS`, column titles).
* `donation-rollups/scripts/setup-owner-columns.mjs` — the `Last Gift Date` rollup title;
  `donation-rollups/src/custodian/custodian.ts` — the capacity-alarm shape this borrows.
* Monday API reference, Items → `move_item_to_board` (columns_mapping semantics), and
  community threads on connect-column mapping.
