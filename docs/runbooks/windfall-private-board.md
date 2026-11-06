# Runbook: moving Windfall data to the private Wealth Screening board

Moves the 11 purchased wealth-screening columns off People and People (Historical) onto a private
board three staff can open, proves the copy, then deletes the columns from both People boards.
Design: `docs/superpowers/specs/2026-11-06-windfall-private-board-design.md`. Run every command from
the repo root, with David's own Monday token in `MONDAY_API_TOKEN`, never a Worker's. The script
prints counts and Monday ids only, never a donor value; keep it that way in anything you paste into
a ticket or this file.

The columns: Windfall ID, Net Worth, Net Worth Low, Net Worth High, Net Worth Date, Philanthropic
Giver, Job Title, Windfall Company, LinkedIn, Windfall Priority, Windfall Profile.

Commands (`scripts/windfall-board.mjs`): `inventory`, `copy`, `verify`, `delete-people-columns`.
Exit 0 means nothing wrong, 1 a check failed, 2 a usage or API error (or a write whose outcome is
unknown). `copy` and `delete-people-columns` are dry runs until given `--apply`.

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
  In Monday: open each board, then the Archive (board menu, "Archived items") and look at the
  Windfall ID, Net Worth, Job Title and LinkedIn columns, sorting or filtering to non-empty. Or ask
  the API for `boards(ids: [...]) { items_page(query_params: { ... }) }` with `state: archived`
  and count items whose Windfall ID is non-empty, printing the count only. Any found must be
  handled first (restore them to the board and re-run `copy`, or copy them by hand), or David must
  explicitly accept losing them. Do not delete until one of those is true and is written down in
  the log below.
- Run the deletion in a quiet period. An edit to a Windfall cell between `verify` and the delete is
  lost, and the delete re-reads only titles, not values.
- Inventory every workspace for boards with a Windfall ID column, archived ones included:

```sh
node scripts/windfall-board.mjs inventory --workspace 18210301 --workspace 17141226 --workspace 18201685
```

Expected: only the two production and two sandbox v4 boards. Add any other board that turns up to
the clean-up. It reads active items only; the archived-item check above covers the rest.

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

2. **UI steps** (the script doesn't do these; see "UI steps").
3. **Verify.** `--subscriber` is the exact list of who should be on the board, and the board owner
   (David) counts:

```sh
node scripts/windfall-board.mjs verify --people 18437342592 --historical 18437342607 --board <id> --subscriber 74336833
```

   Expected: exit 0.
4. **A Worker can't read it.** Follow `monday-auth/README.md`, "Measuring production scope with the
   probe", against the sandbox Worker: run it for the Read-only app and for Staff sync with a
   workspace other than 18210301, and note the boards reported for 18210301. If the report doesn't
   name boards, compare its count for 18210301 with the count taken before the copy. Neither app
   may reach the new board.
5. **Moves still work.** Make sure `people-reclassification:writes` is on for the sandbox, then use
   the Worker's on-demand move on one test person, in each direction. Expect the same item id, with
   the Person link and mirrors intact. `verify` still exits 0.
6. **A non-subscriber sees nothing.** As a user who isn't subscribed, open a linked person on
   People (sandbox v4) and search Monday for a Windfall Company value from that item (type it in
   the search box only; do not paste it into any record). Expect no mention of the new board and no
   result. Any hit stops the work.
7. **Delete, with writes held.**

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
8. **Clean up.** After David confirms, delete the sandbox Wealth Screening board and re-run
   `inventory`. No sandbox board may still have a Windfall ID column, so the rehearsal leaves no
   real Windfall values in the sandbox.

### Results to record from the sandbox

| Question | Result |
| --- | --- |
| Does `create_board` seed a column named Person? (`copy` exits 1 and asks the operator to clear it and re-run with `--board`.) | |
| Does `subscribers` include the board owner? (Decides whether `--subscriber` needs David listed.) | |
| Is the Person connect column one-way, with no column appearing on People? | |
| Do values round-trip (Net Worth, dates, checkbox, link, long text) exactly? | |
| Does the activity log on People still show the deleted columns' values? | |
| Can a deleted column be restored, by whom, and for how long? | |

## Production

Each step needs David's go-ahead. Merging the code that removes the Windfall path from
`salesforce-import` and adds `MARKED_COLUMNS['Wealth Screening']` must be on `main` before step 7.

1. **Confirm the digest shipped** (see "Before you start").
2. **Create the board and copy.** Dry run first, then `--apply`. Expect roughly 3,705 People items
   plus about 2,900 from People (Historical).

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
   confirms they can't. Repeat the Worker-reach check (probe, production scope) and the
   non-subscriber item-card check from the sandbox rehearsal.
4. **Check the dashboards.** Read Development — weekly pulse (dashboard 40266055) for widgets that
   use these columns and fix any before moving on. Tell David who can open the backup Shared Drive.
5. **Hold moves, and confirm the backup.**

```sh
node scripts/flags.mjs people-reclassification writes hold
```

   Then confirm the latest nightly `monday-backup` snapshot, taken after step 2, holds both People
   boards with the 11 columns, by counting non-empty values in its files without printing them.
   Counts must match `verify`'s `perColumn`.
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
node scripts/flags.mjs people-reclassification writes on
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
  `delete-people-columns` refuses to run again. Finish the rest by hand in Monday from the list the
  failed run printed (column titles and ids, on both boards).
- **`copy` died after `create_board` and before it removed the seed items.** Remove the seeded
  items by hand, then re-run with `--board <id>` so it doesn't make a second board.
- **A link read came back partly empty.** `copy` prints an unlinked count. Re-run with `--board`;
  it skips anyone already linked, and `verify` reports any duplicates left.
- **`verify` reports a mismatch.** Do not delete. Fix the cause, re-run `copy --board`, and verify
  again.

## Accepted limit

People's activity log may keep showing the old Windfall values for up to a year after the columns
are deleted. David accepted this on 2026-11-06. Record what the sandbox and production show in the
results table and tell David.

## Production log

| Date | Step | Result |
| --- | --- | --- |
| | Archived items checked (count, decision) | |
| | Board created (id) | |
| | `verify` passed | |
| | Columns deleted | |
