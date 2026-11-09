# Move Windfall data to a private board

Status: design, awaiting approval. From
[#81](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/work_items/81) and
finding 4 of the [privacy policy review](../../reviews/2026-11-03-privacy-policy-review.md).

## Why

SVBC holds purchased wealth-screening estimates on donors. They sit in 11 columns on both People
boards, where all 12 staff subscribers and SVBC Integration can see them. The **Wealth screening**
view on People even ranks everyone by net worth. Only three staff use this data, for deciding who to
reach out to. The published policy says access is limited to employees who need to know, and today
that isn't true.

Production `report-digests` also has writes on, with its first sends due 2026-11-02 (cutover log), so
the weekly email to Clarrissa may already carry this data. The live send wasn't checked. The Salesforce
wealth report subscriptions are gone: only the Eventbrite orders report remained on 2026-11-02. The
root `README.md` status row still says sandbox only, and is out of date.

The internet-facing `member-portal` also reads Monday as SVBC Integration. Any board that user is
subscribed to can be read with the portal's token, so where this data sits affects the public
Worker's exposure as well as staff access.

## Goals

- Only Clarrissa, Felicia and Deanna use the Windfall data, on a new private **Wealth Screening**
  board, with David as board owner.
- SVBC Integration and Sandbox Integration are not subscribed to it, so no Worker token can read it.
- The Windfall columns and the Wealth screening view are gone from People and People (Historical).
- Wealth data no longer goes out in email.
- The board works for outreach prioritization: a person can be ranked and opened without leaving it.
- Recently Divorced and Recent Death in Family don't reach the new board.

## Non-goals

- Updating the privacy policy. #81 stays open for that.
- Deciding the other life-event and property flags, or the political fields retained in Salesforce.
  Those belong to the policy owner.
- Purging Windfall data from existing backup snapshots or the Salesforce org.
- Restricted column permissions on People. Monday's docs disagree on whether Pro has them, and a
  private board uses a control SVBC already relies on.

## Anti-goals

The work has failed, even if it technically runs, if:

- a person outside the board's subscribers can see any Windfall value, through a connected column,
  a mirror, the item card or a view;
- a Worker token can read the board;
- Windfall values are logged, committed, or left in a working file;
- data is deleted from People before the new board has been checked against it.

## Decided

| Decision | Who |
|---|---|
| A separate private board, not hidden columns | David |
| Access: Clarrissa, Felicia, Deanna | David |
| Wealth data comes out of the digest, because Clarrissa doesn't rely on it weekly | David |
| Lingering activity-log values are accepted | David |

## Design

### The board

- **Name and place:** Wealth Screening, in the Donors & Contacts workspace, created with
  `board_kind: private`. `member-portal/scripts/setup-production-boards.mjs` already creates private
  boards this way.
- **Items:** one per person with a value in any of the 11 columns on either People board, so nothing
  is lost when the columns go. The item name is the person's name. On 2026-11-06 production People
  had 3,704 with a Windfall ID, plus 1 with only a Job Title and none with only a LinkedIn. People
  (Historical) wasn't counted; the 2026-10-26 dry run suggests about 2,900 there. (Builder check; my
  call.)
- **Columns:** the 11 Windfall columns under their current titles (Windfall ID, Net Worth, Net Worth
  Low, Net Worth High, Net Worth Date, Philanthropic Giver, Job Title, Windfall Company, LinkedIn,
  Windfall Priority, Windfall Profile), plus:
  - **Person:** a one-way connect column to both People boards. No column appears on People.
  - **Lifetime Giving** and **Donor Level:** mirrors through Person, so that ranking uses current
    giving without any Worker writing to this board.
- **Main view:** the existing Wealth screening columns and sort (Net Worth, highest first), excluding
  people marked Do Not Solicit. Mirror the exclusion column if the view needs it.
- **Markers:** all 11 columns get 📜 through `MARKED_COLUMNS`, including Job Title and LinkedIn,
  which are unmarked today.

### Moving the data

A one-time operator script in `scripts/`, run with David's token rather than a Worker's, following
`scripts/make-boards-private.mjs`:

- Reads current values from both People boards, not from the Salesforce extract, so staff edits to
  Job Title and LinkedIn carry over.
- Finds columns through `bareTitle`.
- Removes `Recently Divorced` and `Recent Death in Family` from the `Flags:` line of Windfall Profile.
- Is safe to re-run: it skips any person already linked by Person.
- Has a dry run, and prints only counts. It writes no donor data to the console or to disk, and the
  log-safety check must pass.
- Reports a reconciliation by comparing every value on the two sides, allowing only for the two
  removed flags. It prints counts of items and of mismatches, never the values. Any mismatch blocks
  deleting the People columns.

### `report-digests`

- `recent-gifts-wealth` becomes `recent-gifts`: Received gifts of $400 and up from the last 60 days,
  largest first, with the gift columns plus Lifetime Giving and Donor Level.
- The "under $400, screened donors" section goes, since the Worker can no longer tell who was
  screened. So do the `WEALTH` Windfall titles and the Windfall wording in the subject and intro.
- Recipient stays Clarrissa. Schedule, view and `minAmount` stay.
- Keep the `recipientDomains` guard, since digests still carry donor data. Update its comments and
  tests, which give wealth data as the reason.

### Code and docs that stop putting data back

- `salesforce-import`: remove the Windfall descriptions and the Wealth screening view from
  `configure/spec.ts` so re-running `configure` can't recreate them. Stop `transform/people.ts` from
  writing Windfall columns, and record the change in the README's Windfall section.
- `scripts/mark-read-only-columns.mjs`: move `WINDFALL` from People to the new board.
- Update `report-digests/README.md`, `docs/uat/report-digests.md`, `docs/uat/monday-boards.md` and
  the root `README.md`. Add a dated note to finding 4 of the privacy review. Its draft wording "our
  staff can see it" should become something like "a small number of staff".

### Rollout

**Sandbox rehearsal.** Rehearse on the sandbox v4 People boards, because they have the Windfall
columns. `People (sandbox v4)` holds a live Wealth screening view, it is private, and Sandbox Integration is
subscribed. v3 People, which `report-digests` sandbox config points at, has no Windfall columns, so
test the digest change there. Run steps 2–7 with Sandbox Integration off the new board. Skip step 5,
since the sandbox backup has never completed a run. Finish by deleting the sandbox Wealth Screening
board, so the rehearsal leaves no real Windfall values in the sandbox. Before starting, list every
board with a Windfall ID column, including archived ones, and include any other that turns up.

**Production:**

1. Deploy the changed digest as its own merge request, ahead of the rest. It stops new copies going
   out by email and doesn't depend on the board. The next send is Monday 8 am.
2. Create the board, run the script, and check the reconciliation.
3. Add the three subscribers. Confirm each can see the board and at least one other staff member
   can't.
4. Set `people-reclassification:writes` to `hold`. `moveMapping` blocks a move when a value-bearing
   source column has no match on the target, so deleting from one People board at a time would block
   moves until both are done.
5. Confirm a nightly `monday-backup` snapshot from just before deletion holds the People boards with
   the columns intact, by reading its files. This is the recovery copy. `monday-backup` restore hasn't
   been rehearsed and rebuilds into a workspace rather than a live board, so recovery would mean a
   script reading the snapshot. No such script is needed up front: the new board has already matched
   value for value, and Salesforce keeps the source. (My call.)
6. Delete the columns and the Wealth screening view from both People boards. This is the step that
   can't be undone through the Workers, so David runs it.
7. Set `people-reclassification:writes` back to `on`, re-run the marking script, and confirm a move
   still works.

### Must pass before step 6

If any of these fail, stop before deleting anything. These are my calls.

- `ReadOnlyToken` and `SyncToken` both fail to read the board by id, in sandbox and production. If
  an integration user turns out to be an account admin with access to private boards, that's a failure.
- The reconciliation shows no mismatches.
- A person moved between People and People (Historical) keeps their Person link and mirrors. The
  design assumes a move keeps the item id; test this in the sandbox before production.
- With a one-way connection, a non-subscriber sees nothing about the board on a People item card.
- Monday search for a known value from a non-subscriber account finds nothing.

## Accepted limits

- **People's activity log (David, 2026-11-06).** If it still shows Windfall values after the columns
  are deleted, proceed anyway. People's subscribers could see them there for up to a year, Pro's
  retention. This is the one exception to the first anti-goal.
- **No automatic backup of the new board.** `monday-backup` runs as SVBC Integration, so it can't see
  the board. The data is frozen, and the snapshot from rollout step 5 is the recovery copy. Notes
  staff add on this board wouldn't be backed up, apart from Monday's own 25-day retention.
- **Existing snapshots keep the data,** and `monday-backup` retains snapshots indefinitely.
- **Emails already sent** stay in the recipients' inboxes.
- **New people won't appear.** The Windfall subscription has ended, so the board only shrinks or goes
  stale, and a person removed from People leaves a board item with an empty link.

## To check during the build

- **Account admins:** whether Monday admins can reach a private board they aren't subscribed to. If
  so, the policy wording has to allow for them.
- **Activity log:** whether People's activity log still shows Windfall values after the columns are
  deleted. Report the result; it doesn't block step 6 (see Accepted limits).
- **Deleted columns:** whether a board member can restore them, and for how long. Report the result;
  it doesn't block step 6. (My call.)
- **Shared Drive:** who can open the backup snapshots. Report this to David, since it affects whether
  "need to know" is true.
- **Dashboards:** whether any Monday dashboard uses these columns. No Monday doc mentions Windfall or
  wealth screening. A dashboard search for "wealth" returned three copies of Development — weekly
  pulse, whose contents haven't been read. A dashboard using a column gets fixed before step 6. It
  doesn't stop the work.

## Left to the builder

- Column types and connect-column settings, within the limits above.
- The script's name and flags.
- Whether `transform/windfall.ts` and its Windfall extract fields are removed or kept unused.
