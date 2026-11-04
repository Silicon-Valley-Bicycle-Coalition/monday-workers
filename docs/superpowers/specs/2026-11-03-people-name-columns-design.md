# Separate first and last names on People — Design

**Date:** 2026-11-03
**Status:** Proposed. Not built.
**Touches:** People and People (Historical) boards, `salesforce-import`, `funraise-sync`,
`eventbrite-sync`, `dtd-sync`, and a one-off script in the private planning repo.

## Why

People stores a person's name only as the item Name. The import joined Salesforce's `FirstName` and
`LastName` (`salesforce-import/src/transform/people.ts:135`), and the two parts exist nowhere else
on Monday.

SVBC wants `{{First Name}}` to work in mail merges built from People. Today anyone merging from a
People export has to split Name by hand. `dtd-sync` has the same gap: it guesses, taking the last word
as the family name (`dtd-sync/src/monday/client.ts:87`), so "Mary Van Der Berg" reaches Double the
Donation with the family name "Berg".

Salesforce still holds the real split, read-only, for now. Its `SVBC Integration` user will be frozen
after the final backup delta (no date set), and the backfill needs that user. That's the one deadline
here: **the production backfill has to run before that freeze.**

**The merge lists staff will export are event attendees,** and those live on Event Registrations, not
People. On production on 2026-11-03, none of its 6,897 registrations had a First Name, all 6,897 had a
Salesforce ID, and 3,749 had no Attendee link to a person. So People names alone can't serve those
lists. Salesforce holds the first name on each registration record, so the backfill covers both
boards.

New class emails don't depend on this. The class email send page (separate branches, in progress)
fills `{{First Name}}` from Event Registrations' First Name column, which the attendee feed will fill
from Eventbrite for new registrations.

## Goals

* First Name and Last Name columns on People and People (Historical), filled from Salesforce for
  every person whose name hasn't changed since the import.
* First Name filled on existing Event Registrations from Salesforce, and shown in the views staff
  export attendee lists from.
* New People created by Workers get both columns whenever the source really provides them.
* `dtd-sync` sends the real values, and guesses only when they're blank.

## Non-goals

* **The Eventbrite attendee feed, the class email send page and the class reminder templates.** Other
  work owns these. Don't change them here.
* Filling the columns on a person a Worker matches rather than creates.
* Backfilling People with no Salesforce ID, such as those created in Monday since cutover.
* Using first names in `member-portal`'s donor emails and letters, or sending names to Mailchimp.
  Both could use these columns later.
* Changing how `benevity-import` matches people by name.

## Anti-goals

These would make this a failure even if everything else worked:

* **Overwriting anything a person typed.** A staff correction beats Salesforce, in both the new
  columns and Name.
* **Storing a guess.** A column holds a value that a source system or a person gave as that field, or
  it's blank. `splitName`'s guess stays a send-time fallback in `dtd-sync` and is never written back.
* **Changing Name.** Every lookup, view and report keeps reading it exactly as it does today.
* **Blocking the reclassification pass.** See "The columns".
* **Real names or addresses in a repo or a log.** The review list stays in a gitignored file, and
  console output is counts only.

## The columns

* Two **text** columns, titled **First Name** and **Last Name**, on all of these:
  * production People `18437909781` and People (Historical) `18437909784`
  * sandbox v4 People `18437342592` and People (Historical) `18437342607`, which `dtd-sync` and
    `people-reclassification` use
  * sandbox v3 People `18431577220` and People (Historical) `18431577228`, which `funraise-sync` and
    `eventbrite-sync` use
* Each pair is created together, before any value is written. `people-reclassification` matches
  columns between the two boards by title and type, and a value-bearing column on only one board
  blocks its whole pass (`people-reclassification/README.md`).
* **Staff can edit them, so they get no 🔒 or 📜 marker** and stay out of `MARKED_COLUMNS`.
* **Name stays the display name and nothing keeps it in step.** No code renames People today. If staff
  rename someone, they update these columns by hand. Add a short column description saying so.
* Add both to `PEOPLE_COLUMNS` in `salesforce-import/src/configure/spec.ts`, which both boards share.

`people-reclassification` and `monday-backup` pick up new columns on their own, so neither needs a
code change.

## The backfill

A one-off script in the private planning repo, `scripts/copy-people-names.mjs`, modeled on
`scripts/copy-household-greetings.mjs`, which ran on production on 2026-11-02 and matched all 16,391
people. Reuse its shape: read Contacts with `salesforce(org).queryAll`, match items on the Salesforce
ID column by 15-character key, write aliased batches of 25, dry run unless `--execute`, and keep the
planning logic in a tested pure function.

**Don't copy its `columnIdsByTitle`.** It compares `c.title === t`, and `Salesforce ID` is now titled
`📜 Salesforce ID`, so it would throw. Compare through `bareTitle`, per the repo's column-marker rule.

For each person on both boards:

| Case | Action |
|---|---|
| No Salesforce ID, or the ID matches no Contact | Leave blank. Count as `unmatched`. |
| `[FirstName, LastName]` joined with a space equals the current Name, whitespace collapsed | Fill the blank cells with the trimmed Salesforce values. |
| Same, but a cell already holds a different value | Leave that cell. Count as `conflict`. |
| Name differs from Salesforce, even only in case or punctuation | Leave blank. Add to the review list. Count as `nameChanged`. |
| Salesforce `FirstName` is blank (a surname-only contact) | Fill Last Name only. First Name stays blank. |

A re-run must be a no-op apart from anything newly blank.

Values go in as Salesforce holds them, including middle names and joint first names like "Jane and
John". This design doesn't clean them up.

The review list is a CSV of item link, board, current Name, and the Salesforce first and last names,
written to a gitignored path. Nothing depends on anyone working through it: those people stay blank
and `dtd-sync` falls back to its guess.

**Bulk writes are safe for Mailchimp.** `mailchimp-sync`'s outbound webhook drops changes to columns
it doesn't read before enqueueing (`mailchimp-sync/src/webhook/outboundRoute.ts:71`). The Location
backfill relied on the same behavior.

**Run order:** dry run on sandbox v4, `--execute` there, check, create the empty columns on sandbox v3
(no backfill needed there), dry run on production, then
**stop and show the counts to David** before `--execute` on production. The script reads the live
`svbc` Salesforce org in both cases, read-only.

## Event Registrations

Production already has the `🔒 First Name` column (`text_mm8rrr6v`), so no new column is needed there.
It's empty because the import only wrote the joined `Attendee Name`
(`salesforce-import/src/transform/boards.ts:97,146`).

**Backfill:** a second one-off script in the planning repo, `scripts/copy-registration-first-names.mjs`,
with the same shape, safeguards and run order as the People one. It matches on the board's `📜
Salesforce ID` and reads two objects, because the board's rows came from both:

| Salesforce object | First name | Last name |
|---|---|---|
| `eb4sf__Eventbrite_Attendee__c` | `eb4sf__First_Name__c` | `eb4sf__Last_Name__c` |
| `funraise__Fundraising_Event_Registration__c` | `funraise__First_Name__c` | `funraise__Last_Name__c` |

It reads these values directly, not through People, so the 3,749 registrations with no Attendee link
are covered. It uses the same safeguards: fill blank cells only, and only when first and last joined
equal the current `Attendee Name`, whitespace collapsed. Anything else goes on a gitignored review
list. Funraise rows whose Salesforce record has a blank name stay blank. Those rows are the 86 orphans
and similar; don't look them up through People.

The sandbox v4 Event Registrations board (`18437342649`) is the rehearsal target. Check that it has a
First Name column first, and create it there if it's missing.

**Going forward:** nothing changes. The attendee feed writes First Name on new registrations and is
out of scope here. A later feed update may overwrite a backfilled value with Eventbrite's, which is
fine, because the column is Worker-owned (🔒).

**Views:** `By event` and `Attended` on production show neither First Name nor Attendee Email. Add both
as visible columns with `update_view_table`, then send a test export from each to confirm they come
through, because this design assumes rather than knows that Monday's export follows the view. Also add
them to those views in `salesforce-import/src/configure/spec.ts`, since `configure` won't change a
view that already exists. Leave `Class roster` alone: it belongs to the feed work.

**People views don't change.** Staff who merge from a People list can add the column themselves.

**Staff docs:** add "emailing past attendees" to the merge section of
`docs/06-staff-process-guide.md`, naming these two views as the source.

## New People from Workers

Fill the columns only when a Worker creates a person, only from fields the source gives separately,
and omit any that are blank.

**A name problem must never hold up a gift or order.** Monday can reject a whole `create_item` over
one bad column, and these columns are unlocked, so staff could delete one. A rejected create would
send a real gift into queue retries and then the dead-letter queue. So in the Worker paths:

1. Leave the existing `create_item` exactly as it is.
2. Then write the names in a separate `change_multiple_column_values`, inside a `try`/`catch` that
   logs the item id and error, never the name, and carries on. It isn't retried.

A person whose name write failed stays blank, which is the same as a person with no split. Add a test
that a failed name write still returns the created person. `salesforce-import` has no live gift
waiting on it, so it can simply add both columns to its `columns` payload.

Each Worker gets its new column ids and any field names through `config/svbc.json` and
`config/sandbox.json`, covered by its `config/split.test.ts`.

| Worker | Path | Source | Notes |
|---|---|---|---|
| `salesforce-import` | `transform/people.ts` | `FirstName`, `LastName` | Add to the `columns` payload. Name is unchanged. |
| `eventbrite-sync` | `matching/people.ts`, orders | `order.first_name`, `order.last_name` | Add optional parts to `PersonKey`. The order path can't write in the sandbox (`orderIdColumn` is a placeholder), so it's covered by tests, then checked on the first real order that creates a person. |
| `funraise-sync` | `matching/donors.ts` | `supporter.firstName`, `supporter.lastName` | **Unconfirmed.** Only a test fixture shows these fields. Check a real sandbox payload first. If they aren't sent, leave this path blank and say so in the MR. |

**Attendee paths are out of scope.** `eventbrite-sync/src/consumer/processAttendee.ts:113` doesn't pass
name parts, so People it creates stay blank. The attendee feed's owners can pass them later through
`PersonKey`'s optional parts. `eventbrite-sync/src/followups/run.ts:140` has only a joined name, and
the send page branch deletes that file.

Staff creating a person by hand fill in the columns themselves. Update "Add a new person" in
`docs/06-staff-process-guide.md`.

## `dtd-sync`

* Add `firstName` and `lastName` to `config.people` and read them in the People query
  (`src/monday/client.ts`).
* If First Name has a value, send First Name and Last Name as they are.
* If First Name is blank, fall back to `splitName(item.name)`, even when Last Name has a value. Nobody
  has confirmed Double the Donation accepts a blank `donor_first_name`, and a rejected push means that
  donor gets no matching-gift prompt. This way a surname-only contact goes out exactly as it does
  today.
* Keep `splitName`, and update its comment, which says People has no such columns.
* The `people` type in `docs/superpowers/plans/2026-11-03-dtd-sync.md` already names these keys; the
  shipped config doesn't have them yet.

## How we'll know it worked

* On both production boards, every person in the dry run's `matched` count has values, except those
  counted as `nameChanged` or `conflict`.
* The stats add up: `unmatched + nameChanged + filled + already-filled + conflict` equals the total.
* A spot check of names with particles, suffixes and surname-only contacts reads correctly.
* Event Registrations: the count with First Name filled matches the dry run, and a test export from
  `Attended` has First Name and Attendee Email columns that work in a test merge to a staff address.
* A `people-reclassification` production dry run passes afterwards.
* A `dtd-sync` test shows "Mary Van Der Berg" with stored columns going out as "Mary" and "Van Der
  Berg", and a person with a blank First Name still going out through the guess.
* `monday-backup`'s next run includes the columns.

## Decided by the author, not yet reviewed by David

* Titles are First Name and Last Name, not Given and Family, to match the merge templates' `{{First
  Name}}`, Salesforce, and Event Registrations' column. Non-Western name order is stored as Salesforce
  held it.
* A Name differing only in case or punctuation still goes to the review list, rather than being
  treated as a match.
* Worker-created People with no Salesforce ID aren't backfilled, even where a source could supply it.
* The columns are staff-editable and not synced with Name.
* Worker name writes are a separate best-effort step after the create, not part of `create_item`.
* `dtd-sync` guesses whenever First Name is blank, instead of sending a blank.
* Sandbox v3 gets empty columns so the Workers on it can be tested; neither Worker moves to v4.
* People created by the attendee feed stay blank until that feed's owners pass the parts.
* "Event attendees" is read as past and present attendee lists exported from Event Registrations'
  `By event` and `Attended` views, with registration names backfilled from Salesforce's registration
  records rather than through People.

## Left to the builder

* Whether the planning repo's script imports a `bareTitle` copy or carries a small one.
* Exact review list path, as long as it's gitignored.
* Whether new config keys are required or optional per Worker's validator, as long as the production
  config can't deploy pointing at a column that doesn't exist. Create the columns first.
* MR splitting. One Worker per MR is fine; none of them depends on another, only on the columns.

## Other work in the same files

Open or in-progress branches also change these files. Base on the latest `main` and rebase as they
land:

* `feat/class-email-send-page`: `salesforce-import/src/configure/spec.ts`,
  `scripts/mark-read-only-columns.mjs`, `eventbrite-sync/src/matching/people.test.ts`,
  `eventbrite-sync/src/test/testConfig.ts` and `eventbrite-sync/src/types.ts`

!332 (the production feed config and `Class roster`) merged while this was being written.
