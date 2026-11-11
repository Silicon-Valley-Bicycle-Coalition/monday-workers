# Runbook: moving volunteer sign-ups to the Volunteers board (production cutover)

Design: `docs/superpowers/specs/2026-11-11-volunteers-board-eventbrite-design.md`. Before the
cutover, `eventbrite-sync` wrote volunteer sign-ups as Event Registrations items (Role =
Volunteer) and `donation-rollups` counted them from there. After it, `eventbrite-sync` writes them
to the Volunteers board (18437909797), `donation-rollups` counts that board, and the old
registrations are archived.

Uses the write switch (root `CLAUDE.md`, "Write switch"). Run commands from the repo root unless
noted. The switch is per Worker, so `hold` stops **all** of `eventbrite-sync`'s writes (orders,
attendees, class emails), not only volunteers; keep the hold short. Leave a hold with `on`, never
`off` (it drops held messages). Every script below needs a `MONDAY_API_TOKEN` that reaches the
Volunteers, Events and Event Registrations boards; the backfill's data lives under
`eventbrite-sync/data/` (gitignored: it holds attendee ids, never commit it).

## Before you start

Take a D1 Time Travel bookmark of the `eventbrite-sync` production database immediately before
step 5 (written out in step 4 below), and write it down. It is the real recovery path for
`attendees` and `class_email_recipients`; the rollback depends on it. Time Travel keeps 30 days.

## Order (do not reorder)

1. **Create the production Volunteers columns and the "Recent events" view.** From
   `eventbrite-sync/`, dry run first and read what it plans:

   ```sh
   MONDAY_API_TOKEN=... node scripts/setup-volunteers-board.mjs --board 18437909797 --events-board <production Events board id>
   ```

   Then the same with `--apply`. It creates Event, Eventbrite Listing, Eventbrite Attendee ID,
   Attendee Name and Attendee Email (each only if missing) and the view (grouped by Event, Date within the
   last 90 days, newest first), and prints the column ids. Then, from the repo root, add the 🔒
   markers (dry run, then `--apply`; the Volunteers entry is already in `MARKED_COLUMNS`):

   ```sh
   MONDAY_API_TOKEN=... node scripts/mark-read-only-columns.mjs --workspace <id>
   MONDAY_API_TOKEN=... node scripts/mark-read-only-columns.mjs --workspace <id> --apply
   ```

2. **Put the production column ids in `eventbrite-sync/config/svbc.json`**, under
   `attendeeSync.volunteers`: `eventColumn`, `listingColumn`, `attendeeIdColumn`,
   `attendeeNameColumn`, `attendeeEmailColumn` are `REPLACE_WITH_COLUMN_ID` until then
   (`monday.boards.volunteers` is already 18437909797). Commit and merge it.

   **Filling all five is what switches the Worker to the Volunteers board**, at the next deploy
   (step 4). While all five are the placeholder, `eventbrite-sync` keeps writing volunteer
   sign-ups as Event Registrations rows (Role = Volunteer) and its class emails read them there,
   exactly as before; so a deploy from `main` before this step is safe. Fill all five or none: a
   half-filled set fails config validation (`npm test`, and the Worker at load) rather than
   splitting volunteers across two boards.

3. **Hold `eventbrite-sync`.**

   ```sh
   node scripts/flags.mjs eventbrite-sync writes hold --env production
   ```

4. **Deploy `eventbrite-sync` only** (`cd eventbrite-sync && npm run deploy`), from the commit
   with the step 2 ids: this deploy is the switch to the Volunteers board. **Not
   `donation-rollups` yet.**

   **Then, before step 5, record a Time Travel bookmark** for the production DB (read-only; run
   from `eventbrite-sync/`, and write the bookmark down):

   ```sh
   npx wrangler d1 time-travel info svbc-eventbrite-sync          # current bookmark; --timestamp <RFC3339|unix> for a past one; --json
   ```

   Restore, if the rollback needs it, is
   `npx wrangler d1 time-travel restore svbc-eventbrite-sync --bookmark <bookmark>` (or
   `--timestamp`). It rewinds the **whole** database, so it is acceptable only before step 7
   (Worker on `hold`, the remap the only write since the bookmark), with the previous build
   deployed. After step 7 never restore it (see Rollback).

5. **Backfill, then remap, while the Worker is still on `hold`.** From `eventbrite-sync/`:

   ```sh
   MONDAY_API_TOKEN=... node scripts/backfill-volunteers.mjs                              # dry run: plan + report; read the skips
   MONDAY_API_TOKEN=... node scripts/backfill-volunteers.mjs --apply
   MONDAY_API_TOKEN=... node scripts/backfill-volunteers.mjs --remap-out data/remap.sql
   npx wrangler d1 execute svbc-eventbrite-sync --remote --file data/remap.sql
   ```

   The remap rewrites D1 `attendees.monday_item_id` and `class_email_recipients.registration_item_id`
   from the old registration ids to the new Volunteers item ids. It must finish **before the Worker
   leaves `hold`**: an unremapped ledger id could make a volunteer write land on an old Event
   Registrations item, and a merge could overwrite a `claimed` class-email row mid-send. The SQL is
   idempotent, so re-running it is safe. `--apply` is resumable and idempotent on Eventbrite
   Attendee ID (ledger `data/backfill-volunteers-production.jsonl`). **Verify, per event:** the
   number of Volunteers items for the event equals the number of volunteer registrations it had;
   and for three volunteer events the class-email roster and the sent counts (the send page,
   `GET /class-emails/:eventId`) are unchanged from before the cutover. Note the three counts
   *before* step 3 if you want a comparison; they are not recoverable afterwards except from D1.

6. **Deploy `donation-rollups`** (`cd donation-rollups && npm run deploy`) **after** the
   backfill, so no membership sweep runs while volunteer rows are in neither source. Its config
   already has `volunteerBoards: []` and the Volunteers board under `historicalVolunteerBoards`,
   with the optional `historical` checkbox column; the new nightly membership load pages the
   Volunteers board and enqueues only owners whose rows changed.

   **Overlap until step 9.** From this deploy, the old Event Registrations-sourced rows
   (`source` `sweep`/`webhook`) still qualify alongside the new Volunteers rows. That is harmless
   for correctness: the same person-day from both sources collapses when runs are built
   (`buildRuns`). The only residual risk is an old registration cancelled in Monday in the
   meantime still counting. Run steps 9 and 10 the same day as this step, before the 09:00 UTC
   nightly cron if practical.

7. **Turn `eventbrite-sync` writes on.** Set `on` before relying on writes (a missing key or any
   other value reads as `off`):

   ```sh
   node scripts/flags.mjs eventbrite-sync writes on --env production
   ```

8. **Archive the old registrations**, only after the count check in step 5 passed. Archive, never
   delete. From `eventbrite-sync/`:

   ```sh
   MONDAY_API_TOKEN=... node scripts/backfill-volunteers.mjs --archive --remap-out data/remap.sql
   ```

   `--archive` is refused without `--remap-out` in the same run, and archives nothing (exit 1)
   unless every eligible attendee is on the Volunteers board. If it wrote new remap SQL, run it
   again with the `wrangler d1 execute` command from step 5.

9. **One-time statement on the `donation-rollups` D1**, by the operator, after confirming the
   Volunteers board holds those people. Without it, old Event Registrations-sourced rows keep
   counting, and a registration later cancelled would still count. Run from `donation-rollups/`.

   **First capture what the undo needs**, before the UPDATE. Write down the count, and save the
   ids (`volunteer_activity`'s primary key is `registration_item_id`; migration
   `0009_membership_activity.sql`):

   ```sh
   npx wrangler d1 execute svbc-donation-rollups --remote --command "SELECT COUNT(*) AS qualifying FROM volunteer_activity WHERE source IN ('sweep','webhook') AND qualifies = 1"
   npx wrangler d1 execute svbc-donation-rollups --remote --json --command "SELECT registration_item_id FROM volunteer_activity WHERE source IN ('sweep','webhook') AND qualifies = 1" > data/pre-step-9-qualifying.json
   ```

   The count is the number of `sweep`/`webhook` rows that qualify now: it is what step 9 will
   turn off, and what the undo must turn back on. `data/pre-step-9-qualifying.json` lands in
   `donation-rollups/data/`, which the repo-root `.gitignore` (`data/`, at any depth) ignores;
   it holds registration item ids, so never commit it. Then run:

   ```sh
   npx wrangler d1 execute svbc-donation-rollups --remote --command "UPDATE volunteer_activity SET qualifies = 0 WHERE source IN ('sweep','webhook')"
   ```

10. **Run the full recompute**, so membership reflects the Volunteers board now rather than over
    several nights (the nightly load enqueues at most `ENQUEUE_PER_RUN` = 3,500 owners a night):

    ```sh
    curl -m 3600 -X POST -H "Authorization: Bearer $CUSTODIAN_SECRET" \
      "https://<donation-rollups worker URL>/custodian/run/membership?all=true"
    ```

    Repeat until `detail.remaining` is `0` (see `donation-rollups/README.md`, "The `membership`
    duty"). Or accept the nightly catch-up, which works through the backlog in slices.

11. **Spot-check at the next sweep:** open a volunteer who attended an event in the last year and
    confirm their membership activity (`Member Until`, Member Type) reflects the volunteering.

12. **Remove the old production webhooks** on the Event Registrations board (18437909792) that
    `donation-rollups` subscribed for volunteers, by hand in Monday. They are now ignored; leaving
    them only wastes deliveries.

## Rollback

Rollback is clean only **before step 7** (writes `on`). Keep `eventbrite-sync` on `hold`
throughout.

1. **Redeploy the previous `eventbrite-sync` build and, if step 6 ran, the previous
   `donation-rollups` build** (re-deploy the prior commit from each Worker directory).
2. **Unarchive** the original registrations in Monday (ids are in the ledger, below).
3. **Restore the eventbrite-sync D1 from the Time Travel bookmark taken before step 5.** This is
   the real recovery path for `attendees` and `class_email_recipients`:
   `npx wrangler d1 time-travel restore svbc-eventbrite-sync --bookmark <bookmark>`. It rewinds
   the whole database to the bookmark, so it is acceptable **only before step 7**, while the
   Worker is on `hold` and the remap is the only write since the bookmark. **After step 7, never
   restore the whole DB**: it would also erase legitimately received attendees and class-email
   `sent` records, and cause duplicate emails. Use targeted fixes with staff review instead. Pointing
   the ids back by hand is **NOT scripted** and is only a fallback: the forward remap
   (step 5) merged some `class_email_recipients` rows and deleted the duplicates, including `sent`
   records, and those cannot be reconstructed; without the snapshot a second class email could
   go out. Two columns are involved, `attendees.monday_item_id` and
   `class_email_recipients.registration_item_id`. The ledger supplies each old and new id:
   `eventbrite-sync/data/backfill-volunteers-production.jsonl`, one JSON object per line,
   `{"attendeeId":"...","registrationItemId":"<old>","volunteerItemId":"<new>"}` (a line without
   `registrationItemId` has no old item to return to). The operator must write and review any
   reverse statements first. Example for ONE id pair only, not a script to run as is:

   ```sql
   -- EXAMPLE: one attendee. Substitute the ledger's values; review before use.
   UPDATE attendees SET monday_item_id = '<old registrationItemId>' WHERE attendee_id = '<attendeeId>';
   UPDATE OR IGNORE class_email_recipients SET registration_item_id = '<old registrationItemId>'
     WHERE registration_item_id = '<new volunteerItemId>' AND event_id = '<event id>' AND kind = '<kind>';
   ```

   Two traps. The primary key is `(event_id, kind, registration_item_id)`, so without `OR IGNORE`
   a row whose old id already exists for the same event and kind aborts with UNIQUE; with it the
   row is silently left on the new id. And one new `volunteerItemId` can map to **several** old
   registrations (an attendee registered twice: what the script's `duplicateMoves` reports), so
   reversing on `registration_item_id = '<new>'` alone repoints every row to one old id; always
   key on `(event_id, kind)` too, and prefer the Time Travel restore for those.
4. **Undo step 9.** This applies only to a rollback after step 9, which is by definition past
   the clean-rollback window (step 9 runs after step 7): read "After step 7" below for what that
   means. Restore exactly the rows captured in step 9:
   `UPDATE volunteer_activity SET qualifies = 1 WHERE registration_item_id IN (<ids from
   data/pre-step-9-qualifying.json>)`. The blanket
   `UPDATE volunteer_activity SET qualifies = 1 WHERE source IN ('sweep','webhook')` is
   equivalent only if the count recorded in step 9 equals the number of `sweep`/`webhook` rows
   now (that is, none of them had `qualifies = 0` beforehand).
5. Leave `hold` with `on` only when the old build and the D1 ids agree.

**After step 7 a rollback is not clean, and a Time Travel restore is off the table** (it would
 erase attendees and `sent` records received since the bookmark; see item 3). Attendees created only on the Volunteers board (new
sign-ups since writes went on) have no old registration to point back to. Do not delete them:
they are not lost. Leave those items on the Volunteers board and leave their D1 ids pointing at
them; decide with staff whether to copy them onto Event Registrations by hand. Re-running the
forward remap SQL is safe (it is idempotent), but that is for finishing step 5, not a rollback
step. Never delete the Volunteers items the backfill created.

## For staff

- **Recent events view.** On the Volunteers board, open the **Recent events** view: items grouped
  by **Event**, covering the last 90 days, newest first. Each group is one real event; expand it
  to see who volunteered.
- **`Event` defaults to the volunteer listing itself.** A stand-alone volunteer event (a listing
  with no attendee event) therefore groups by itself and needs nothing.
- **Re-pointing `Event`.** When a volunteer listing belongs to an attendee event (volunteers for
  a ride or class), open the volunteer's item and pick the attendee event in **Event**. Volunteers
  for the same real event should all point at the one Events item. The sync never writes `Event`
  again after creating the item, so your choice sticks. **Eventbrite Listing** keeps the listing
  they signed up for.
- **Do not edit** the 🔒 columns (Eventbrite Listing, Eventbrite Attendee ID, Attendee Name,
  Attendee Email). Staff statuses No-Show, Prospect and Confirmed are kept by the sync.
- **Do not uncheck Historical** on a migrated row. Historical rows count towards membership only
  with Hours >= 1; unchecking it makes the row count as a live sign-up and changes history counts.
  (Monday cannot lock a single checkbox; it is a convention.)

## Known gaps / not verified

- The setup script's live `--apply` path and the backfill's live run were not exercised against
  Monday before the first operator run: only dry-run, tests and an equivalent run through the
  Monday MCP on the sandbox v3 board 18431577321. Read each dry run before applying.
- A Volunteers item deleted in Monday is never removed from `volunteer_activity` (archiving is
  the supported route), so a deleted row keeps counting until its D1 row is removed by hand.
- Staff unchecking Historical on a migrated row would change history counts (see "For staff").
- The sandbox rehearsal boards differ: `eventbrite-sync` sandbox writes to Volunteers v3
  (18431577321), `donation-rollups` sandbox reads v4 (18437342662). An end-to-end sandbox
  rehearsal needs the two configs pointed at the same board first.
- The first nightly catch-up after cutover is capped at `ENQUEUE_PER_RUN` owners per night; step 10
  avoids that.
- How the grouped view renders in the Monday UI (group order, empty-relation group) is not
  verified.
