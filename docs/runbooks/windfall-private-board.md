# Runbook: moving Windfall data to the private Wealth Screening board

Moves the 11 purchased wealth-screening columns off People and People (Historical) onto a private
board three staff can open, proves the copy, then deletes the columns from both People boards.
Design: `docs/superpowers/specs/2026-11-06-windfall-private-board-design.md`. Run every command from
the repo root, with David's own Monday token in `MONDAY_API_TOKEN`, never a Worker's. The script
prints counts, Monday ids and column titles only, never a donor value or name; keep it that way in
anything you paste into a ticket or this file.

The columns: Windfall ID, Net Worth, Net Worth Low, Net Worth High, Net Worth Date, Philanthropic
Giver, Job Title, Windfall Company, LinkedIn, Windfall Priority, Windfall Profile.

Commands (`scripts/windfall-board.mjs`): `inventory`, `copy`, `verify`, `delete-people-columns`,
`snapshot-counts`. Exit 0 means nothing wrong, 1 a check failed, 2 a usage or API error (or a write
whose outcome is unknown, or a snapshot line it can't read). `copy` and `delete-people-columns` are
dry runs until given `--apply`. `snapshot-counts` needs no token.

## Ids

| | Sandbox (v4) | Production |
| --- | --- | --- |
| Workspace | 18210301 | 18201685 |
| People | 18437342592 | 18437909781 |
| People (Historical) | 18437342607 | 18437909784 |

Users: Clarrissa 68160704, Felicia 68302743, Deanna 68302747, David 74336833. The sandbox rehearsal
subscribes David only. Production subscribes all four. The script refuses a board that either
integration user (SVBC Integration, Sandbox Integration) is subscribed to.

## Before you start

- The digest change is deployed and the first send after it carried no Windfall columns (Clarrissa
  confirms, or force a dry run). The Monday 8 am send must not still be copying the data out.
- **Check People and People (Historical) for archived items that hold Windfall values.** The CLI
  reads active items only, so an archived person's values are lost when the column is deleted.
  **There is no verified way to do this check yet.** The sandbox rehearsal must find one that shows
  which archived items hold a Windfall value without printing the values, and record it in the
  results table. Monday's board archive in the UI is the place to start; nobody has tested it.
  Any archived item found must be handled first (restore it to the board and re-run `copy`, or copy
  it by hand). If the rehearsal finds no working method, David accepts the loss in writing before
  production starts, naming Salesforce as the recovery source. Staff edits to Job Title and LinkedIn
  wouldn't be recoverable from it. Do not delete until one of those is true and is written down in
  the log below.
- Run the deletion in a quiet period. An edit to a Windfall cell between `verify` and the delete is
  lost, and the delete re-reads only titles, not values.
- Inventory every workspace for boards with a Windfall ID column, archived ones included:

```sh
node scripts/windfall-board.mjs inventory --workspace 18210301 --workspace 17141226 --workspace 18201685
```

Expected: only the two production and two sandbox v4 boards. Add any other board that turns up to
the clean-up. It reads active items only; the archived-item check above covers the rest.

- **Check the API budget.** `copy` makes about 6,600 single writes, on an account whose daily API
  limit is shared with every Worker, and a snapshot costs an estimated 1,500 to 2,000 more. Read the
  limit and today's use first, and don't run the sandbox and production copies on the same UTC day.
  `monday-backup/README.md` records 10,000 calls a day, resetting at midnight UTC; that figure is
  unverified, so go by what this returns:

```sh
curl -s https://api.monday.com/v2 -H "Authorization: $MONDAY_API_TOKEN" -H 'API-Version: 2026-07' -H 'Content-Type: application/json' -d '{"query":"{ platform_api { daily_limit { total } daily_analytics { last_updated by_day { day usage } } } }"}'
```

- **Set up the way to read a snapshot.** The backup check in production step 5 streams snapshot files
  with `rclone cat`, so no copy of the data lands on disk. `rclone` wasn't installed on David's
  machine on 2026-11-06. Install it (`brew install rclone`) and run `rclone config` to add a Google
  Drive remote with the `drive.readonly` scope, pointed at the backup Shared Drive, signing in as
  someone who can open it. Nothing has tested this yet, so find any problem now rather than during
  the hold.

## Sandbox rehearsal

The sandbox settles the open questions below. Fill in the results section as you go.

1. **Dry run, then copy.**

```sh
node scripts/windfall-board.mjs copy --workspace 18210301 --people 18437342592 --historical 18437342607
```

```sh
node scripts/windfall-board.mjs copy --workspace 18210301 --people 18437342592 --historical 18437342607 --apply
```

   `copy` makes the board private, its columns, and one item per person with a value. Re-running
   skips anyone already linked by Person. If it exits 1 and asks you to clear a column named Person
   that `create_board` seeded, delete that column, then re-run with `--board <id>` from its output.
   The dry run and the apply both print the removed-flag check; see "When something goes wrong" if
   it isn't 0.

2. **UI steps** (the script doesn't do these; see "UI steps").
3. **Verify.** `--subscriber` is the exact list of who should be on the board, and the board owner
   (David) counts:

```sh
node scripts/windfall-board.mjs verify --people 18437342592 --historical 18437342607 --board <id> --subscriber 74336833
```

   Expected: exit 0.
4. **No Worker token can read it.** Deploy `monday-auth` to the sandbox with the probe's board field
   (`npm run deploy:sandbox` from `monday-auth/`), where the probe is already on. Open
   `https://svbc-monday-auth-sandbox.svbc-account.workers.dev/oauth/probe/<app>` for `portal`, `sync`
   and `readonly`, and enter the sandbox `START_KEY`, workspace 18210301 and the new board's id. Each
   report must show `"board": { "id": "<id>", "empty": true }`. Anything else stops the work,
   including `{ "ok": false, ... }`: an error isn't a pass, so try again, and ask David if it repeats.
   As a control, run `readonly` once with People (sandbox v4), 18437342592, and expect
   `"empty": false`, so an empty answer is known to mean something.
5. **Moves still work, both ways.** The on-demand route only goes from People (Historical) to People,
   so the other way takes a sandbox pass, which moves everyone due, up to the 400-move cap. Never do
   this in production. The Worker is
   `https://svbc-people-reclassification-sandbox.svbc-account.workers.dev`. Make sure
   `people-reclassification:writes` is on for the sandbox.

   Operator calls send the sandbox Worker's `RECLASSIFY_SECRET` as a Bearer header. No copy of
   its value is kept: `monday-migration/.env` has no `RECLASSIFY_SECRET_SANDBOX` (checked
   2026-11-12), and Cloudflare secrets are write-only. So before this step, set a new value on
   the sandbox Worker and save the same value as `RECLASSIFY_SECRET_SANDBOX` in
   `monday-migration/.env`, which the commands below read. Replacing it affects only operator
   calls; the cron and the promote webhook don't use it. From `people-reclassification/`:

```sh
openssl rand -hex 32   # paste this value at the prompt below and into monday-migration/.env
npx wrangler secret put RECLASSIFY_SECRET --env sandbox
set -a; . ../../monday-migration/.env; set +a   # path from the primary checkout; loads RECLASSIFY_SECRET_SANDBOX
```

   1. Pick a test person on People (sandbox v4) with a row on the new board, no Funraise Profile link,
      not a Lifetime member, and no registration, volunteer hours or logged contact in the last seven
      years. Give them an old `Last Gift Date`, such as 2010-01-01, and an old or empty `Member
      Until`. Passes move the longest-lapsed first, so this puts them inside the cap.
   2. Preview, and check `GET /reclassify/status` shows them planned as aged out:

```sh
curl -X POST -H "Authorization: Bearer $RECLASSIFY_SECRET_SANDBOX" "https://svbc-people-reclassification-sandbox.svbc-account.workers.dev/reclassify/run?dryRun=true"
```

   3. Run the pass without `?dryRun=true`. It outlives the HTTP request, so follow it in
      `GET /reclassify/status`. The person is now on People (Historical).
   4. Give them a recent `Last Gift Date`, because the route refuses anyone before the cutoff. Then
      move them back:

```sh
curl -X POST -H "Authorization: Bearer $RECLASSIFY_SECRET_SANDBOX" "https://svbc-people-reclassification-sandbox.svbc-account.workers.dev/reclassify/move-to-people/<itemId>"
```

   Expect the same item id each way, with the Person link and mirrors intact on the new board.
   `verify` still exits 0.
6. **A non-subscriber sees nothing.** As a user who isn't subscribed, open a linked person on
   People (sandbox v4) and search Monday for a Windfall Company value from that item (type it in
   the search box only; do not paste it into any record). Expect no mention of the new board and no
   result. Any hit stops the work. Then try the same, and opening the board directly, with an account
   admin who isn't subscribed, if one exists, and record the answer in the results table.
7. **Mark the columns, and verify again.** This proves `verify` still finds the columns under their
   📜 titles. Read the dry run first; it should list only the new board's 11 columns:

```sh
MONDAY_API_TOKEN=... node scripts/mark-read-only-columns.mjs --workspace 18210301 --suffix " (sandbox v4)"
```

```sh
MONDAY_API_TOKEN=... node scripts/mark-read-only-columns.mjs --workspace 18210301 --suffix " (sandbox v4)" --apply
```

   Then re-run the `verify` from step 3. Expected: exit 0.
8. **Delete, with writes held.**

```sh
node scripts/flags.mjs people-reclassification writes hold --env sandbox
```

```sh
node scripts/windfall-board.mjs delete-people-columns --people 18437342592 --historical 18437342607 --board <id> --subscriber 74336833
```

```sh
node scripts/windfall-board.mjs delete-people-columns --people 18437342592 --historical 18437342607 --board <id> --subscriber 74336833 --apply
```

   Delete the Wealth screening view from People in the UI. Then set writes back to what they were
   (`on` leaves `hold`; never `off`, which drops held messages).
9. **Clean up.** After David confirms, delete the sandbox Wealth Screening board and re-run
   `inventory`. No sandbox board may still have a Windfall ID column, so the rehearsal leaves no
   real Windfall values in the sandbox.

**A second rehearsal** needs `--name "Wealth Screening (sandbox v4)"`. `copy` sees boards in every
state, so the deleted board still clashes with the default name, and it can't be passed to `--board`.
With that name, `mark-read-only-columns --suffix " (sandbox v4)"` still finds the board.

### Results to record from the sandbox

| Question | Result |
| --- | --- |
| Does `create_board` seed a column named Person? (`copy` exits 1 and asks the operator to clear it and re-run with `--board`.) | |
| Does `subscribers` include the board owner? (Decides whether `--subscriber` needs David listed.) | |
| Is the Person connect column one-way, with no column appearing on People? | |
| Do values round-trip (Net Worth, dates, checkbox, link, long text) exactly? | |
| Does the activity log on People still show the deleted columns' values? | |
| Can a deleted column be restored, by whom, and for how long? | |
| What's the working method for finding archived items that hold a Windfall value, printing no value? (None found: David accepts the loss in writing, see "Before you start".) | |
| Can an account admin who isn't subscribed reach the private board or its values? (Test with one if one exists, or say none does. If yes, the policy wording has to allow for admins.) | |

## Production

Each step needs David's go-ahead. The code that removes the Windfall path from `salesforce-import`
and adds `MARKED_COLUMNS['Wealth Screening']` must be on `main` before the deletion, step 6, so
nothing can put the data back. The probe's board field must be merged before step 3 needs it.

1. **Confirm the digest shipped** (see "Before you start").
2. **Create the board and copy.** Check the API budget first (see "Before you start"), and don't
   do this on the sandbox copy's UTC day. Dry run first, then `--apply`. Expect roughly 3,705 People
   items plus about 2,900 from People (Historical), and a removed-flag check of 0.

```sh
node scripts/windfall-board.mjs copy --workspace 18201685 --people 18437909781 --historical 18437909784
```

```sh
node scripts/windfall-board.mjs copy --workspace 18201685 --people 18437909781 --historical 18437909784 --apply
```

   Then the UI steps.
3. **Subscribe the three, and verify.** `copy` doesn't subscribe staff, so subscribing Clarrissa,
   Felicia and Deanna is a UI step that must happen before `verify` can pass. `verify` fails if
   the subscribers differ from the list given, and the list includes David as owner:

```sh
node scripts/windfall-board.mjs verify --people 18437909781 --historical 18437909784 --board <id> --subscriber 74336833 --subscriber 68160704 --subscriber 68302743 --subscriber 68302747
```

   Expected: exit 0. Each of the three confirms they can open the board, and one other staff member
   confirms they can't. **Tell the three not to edit the board until step 7:** until the delete,
   any edit there is a mismatch against People and blocks it.

   Then repeat the non-subscriber item-card and account-admin checks from the sandbox rehearsal, and
   the token check. The probe is off in production, so it needs one deploy with it on, per
   `monday-auth/README.md`, "Measuring production scope with the probe". From `monday-auth/`:

```sh
npx wrangler deploy --var PROBE_ENABLED:true
```

   Open `https://svbc-monday-auth.svbc-account.workers.dev/oauth/probe/<app>` for `portal`, `sync` and
   `readonly`, with the production `START_KEY`, workspace 18201685 and the board id. Each must show
   `"board": { "id": "<id>", "empty": true }`; anything else stops the work, as in the sandbox. Run
   `readonly` once with People, 18437909781, as the control, expecting `"empty": false`. Then turn it
   off, and confirm the `curl` prints `404`:

```sh
npm run deploy
```

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://svbc-monday-auth.svbc-account.workers.dev/oauth/probe/portal
```

4. **Check the dashboards.** A dashboard search for "wealth" found three copies of Development —
   weekly pulse. Read all three for widgets that use these columns, and fix any before step 6:
   40266055 (production, workspace 18201685), 39934083 (workspace 17141226) and 40208733 (workspace
   18210301). Tell David who can open the backup Shared Drive.
5. **Hold moves, and confirm the backup.**

```sh
node scripts/flags.mjs people-reclassification writes hold --env production
```

   Then confirm the latest nightly `monday-backup` snapshot, taken after step 2, holds both People
   boards with the 11 columns. Stream the files; don't download them, because a working file would
   hold Windfall values. Each run is a folder named `YYYY-MM-DD run-N`. `pipefail` makes a failed
   download show as a failed command:

```sh
set -o pipefail
rclone cat "<remote>:<run folder>/board-18437909781.jsonl" | node scripts/windfall-board.mjs snapshot-counts
rclone cat "<remote>:<run folder>/board-18437909784.jsonl" | node scripts/windfall-board.mjs snapshot-counts
rclone cat "<remote>:<run folder>/manifest.json" | jq '{errors: (.errors | length), people: .itemCountsByBoard["18437909781"], historical: .itemCountsByBoard["18437909784"]}'
```

   Both must exit 0, and each file's item count must match the manifest. A run folder with no
   `manifest.json` isn't usable, and the manifest must show no errors for these two boards. Then run `verify` (step 3) and, for each
   title, compare the two files' counts added together with `verify`'s People figure. Two differences
   are expected:

   - The snapshot counts a profile holding only the removed flags; `verify` doesn't, because it counts
     after the scrub. So Windfall Profile can be higher on the snapshot side.
   - Staff edits on People since the snapshot.

   Any other difference means stop and ask David.
6. **David deletes the columns.** Do the archived-item check and pick a quiet period first. Run
   without `--apply` and read the list, then David runs it with `--apply`:

```sh
node scripts/windfall-board.mjs delete-people-columns --people 18437909781 --historical 18437909784 --board <id> --subscriber 74336833 --subscriber 68160704 --subscriber 68302743 --subscriber 68302747
```

```sh
node scripts/windfall-board.mjs delete-people-columns --people 18437909781 --historical 18437909784 --board <id> --subscriber 74336833 --subscriber 68160704 --subscriber 68302743 --subscriber 68302747 --apply
```

   Then delete the Wealth screening view from People and from People (Historical) in the UI.
   `delete_column` doesn't remove views. Expected: exit 0, and a person on People shows no Windfall
   column to any staff member.
7. **Resume, and finish up.**

```sh
node scripts/flags.mjs people-reclassification writes on --env production
```

```sh
MONDAY_API_TOKEN=... node scripts/mark-read-only-columns.mjs --workspace 18201685 --apply
```

   Confirm the next reclassification pass moves people without a blocked-move error. Report the
   activity-log and restore findings to David, and leave #81 open for the policy update.

## UI steps

The script doesn't do these. Do them on the new board after `copy`.

- Add the **Lifetime Giving**, **Donor Level** and **Do Not Solicit** mirror columns through the
  Person column. Mirrors mean no Worker writes to this board.
- Build the main view: Net Worth, Philanthropic Giver, Job Title, Windfall Company, LinkedIn,
  Lifetime Giving, Donor Level, sorted highest Net Worth first, excluding Do Not Solicit.
- Subscribe the staff (production: Clarrissa, Felicia, Deanna). Turn off the Person column's
  two-way option if the UI offers it, so no column appears on People.
- After the delete, delete the Wealth screening view from People and People (Historical).

## When something goes wrong

- **A partial delete can't resume.** `verify` then fails on the missing titles, so
  `delete-people-columns` refuses to run again. Finish the rest by hand in Monday from what the
  failed run printed: its "Not deleted" list gives each column's board id, column id and title. If
  the outcome of one delete is unknown, it's named separately as "may or may not be gone" and isn't
  in that list, so check that column in Monday first. If the run stopped before deleting anything, it
  says so and can simply be re-run.
- **`copy` died after `create_board` and before it removed the seed items.** Remove the seeded
  items by hand, then re-run with `--board <id>` so it doesn't make a second board.
- **A link read came back partly empty.** `copy` prints an unlinked count. Re-run with `--board`;
  it skips anyone already linked, and `verify` reports any duplicates left.
- **`verify` reports a problem.** Do not delete. It lists each one by id, and by column title for a
  mismatch. Job Title and LinkedIn stay staff-editable on People until the delete, so expect the odd
  mismatch over the day or more between copy and delete. People is the source until then, so the fix
  is on the board: delete the board rows it lists (`Mismatch`, `Duplicate`, `Extra`), then re-run
  `copy --board <id> --apply`, and verify again. A deleted row's person is then no longer linked, so
  they're copied afresh. A `Missing` line has no row to delete; the re-run copies that person. This
  only works before step 6: after the delete there's nothing left on People to copy from.
- **The removed-flag check isn't 0.** `copy` stops before writing anything, and `verify`, and so the
  delete, fail. It lists People item ids (from `copy`) or board item ids (from `verify`). Look at each
  profile by hand in Monday, without pasting it anywhere. If a flag really is there in a form the
  scrubber doesn't handle, or if the words are there deliberately (a false positive), edit the value
  on People so it no longer contains them, and re-run. For a hit on the board, also delete that row
  so `copy` writes it again. There's no override.
- **`snapshot-counts` exits 2.** It names the line it couldn't read and doesn't quote it. Check you
  piped a `board-<id>.jsonl` file, and that `rclone` didn't stop part way. Don't open the file to look.

## Accepted limit

People's activity log may keep showing the old Windfall values for up to a year after the columns
are deleted. David accepted this on 2026-11-06. Record what the sandbox and production show in the
results table and tell David.

## Production log

| Date | Step | Result |
| --- | --- | --- |
| | Archived items checked (method, count, decision), or David's written acceptance | |
| | Board created (id) | |
| | `verify` passed | |
| | Columns deleted | |
