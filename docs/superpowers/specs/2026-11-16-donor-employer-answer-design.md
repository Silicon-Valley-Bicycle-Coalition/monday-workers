# Donor-supplied employer — Design

**Status:** Draft design, pre-implementation (2026-11-16). Issue #127.
**Worker:** `member-portal` (the portal and its writer, `svbc-member-portal-writer`). No new Worker.

## Why

The donor is the most direct source for their own employer. Double the Donation asks by email
and gets an answer for about 10% of gifts (DTD dashboard, 2026-11-16: 55% opened, 4% clicked), but
that answer stays in DTD: the Standard plan has no API. None of SVBC's own touchpoints ask. An
employer on file is what lets SVBC tell a donor "your employer matches" (the post-gift email
design, `2026-11-16-post-gift-match-email-design.md`, on its own branch) and lets
`benevity-import` match a Benevity disbursement to a person.

## Goals

1. A signed-in donor can say where they work, from the member portal.
2. When the answer names an Organization SVBC already has, it becomes that donor's **Current,
   Primary** employer affiliation with no staff step, and outranks every inferred source.
3. Staff see every answer on the Change Requests board, applied or not.
4. An answer that names no known Organization reaches staff as an ordinary change request.

## Non-goals

- Creating Organizations from donor text.
- Fuzzy matching. Matching is exact after normalising (below).
- Clearing an employer ("retired", "not employed") automatically. The donor can type that. It
  won't match an Organization, so it reaches staff as a change request.
- Asking at Eventbrite checkout (a separate question for `eventbrite-sync`).
- Building the post-gift email. That design changes as described in "Post-gift email" below, on
  its own branch.

## Anti-goals

- A donor's typed text written onto People → Employer Name directly. `benevity-import` matches
  people by exact name plus Employer text, so Employer Name should only ever hold an
  Organization's real name. `donation-rollups`' `employerSync` writes it from the affiliation.
- Two Primary affiliations for one person after an answer.
- An affiliation ended (set Former) without a staff step. The donor's answer moves Primary only.
- A duplicate affiliation (same person, same Organization) where one already exists.
- Donor PII on the matching-gifts page. Its README properties (sandboxed DTD iframe, zero donor PII
  on the page) stay as they are.
- The portal Worker itself writing to Monday. Only the writer writes.

## Approaches considered

1. **The writer applies it (chosen).** The portal files a `change_requests` row as today, with a
   new `employer` field. The writer resolves the name to an Organization and writes the
   affiliation, or files a staff change request when nothing matches. This reuses the dedupe, D1
   row, queue, write switch and DLQ, and keeps the logic in one Worker. Cost: the writer writes
   to Affiliations as well as Change Requests.
2. **`donation-rollups` applies it.** The portal only files a change request, and
   `donation-rollups` (which already has the affiliation code) watches Change Requests for
   Employer items. Rejected: the feature is split across two Workers, and a staff log board
   becomes a trigger for automated writes.
3. **Option 1 plus a match shown at submit.** The portal looks the Organization up when the
   donor submits and shows "We'll record you at Google." Rejected: it adds a Monday read per
   submit and tells any signed-in donor whether SVBC has a given company on file.

Unmatched names: **staff review** was chosen over creating an Organization, which would leave
near-duplicates ("Google" / "Google, LLC") that break exact-name matching.

The previous Primary affiliation: **only Primary moves** (chosen), over setting it Former unless it
carries SVBC Roles. Nothing is ended automatically; staff mark a stale affiliation Former from
the log item.

## Design

### Where the donor answers

An **Employer** option on the existing change-request page (`/:locale/portal/change-request`),
beside Address, Email and Phone. Old value: People → Employer Name, read through the portal's
read-only token like the other contact fields. The section gets an anchor
(`#employer`) so other pages and the post-gift email can link to it.

The matching-gifts page gets a short line and link ("Tell us where you work, so we can let you
know if your employer matches your gift") to that anchor. It shows no employer value of its own,
which keeps the page free of donor PII. *(Builder's call recorded here: the issue suggested the
matching-gifts page itself; the PII property pushes the form to the change-request page.)*

Copy after submit: the existing "Thanks — we've received your change" message. The donor isn't
told whether it matched (approach 3, rejected).

All new strings go through `src/i18n/locales/*.ts` in every locale.

### Submit (portal, unchanged path)

`submitChangeRequest` accepts `employer` as a `ChangeRequestField` (`FIELD_LABELS.employer =
'Employer'`), free text up to `MAX_NEW_VALUE_LENGTH`. Same session check, dedupe hash, D1 row and
queue message. No D1 migration: `change_requests.field` is unconstrained text.

### Apply (writer)

`processOne` branches on `row.field === 'employer'`:

1. **Normalise** the typed name: lower case, remove punctuation, collapse spaces, and drop a
   trailing corporate suffix (`inc`, `incorporated`, `llc`, `ltd`, `corp`, `corporation`, `co`,
   `company`).
2. **Find candidates** on Organizations by name with one `items_page_by_column_values` query
   on `name`, `any_of` a generated list: the typed name, the suffix-stripped stem, and the stem
   with each common suffix spelling (`<stem>, LLC`, `<stem> LLC`, `<stem>, Inc.`, `<stem> Inc.`,
   `<stem> Inc`, `<stem>, Inc`, `<stem> Corp`, `<stem> Corporation`, `<stem> Ltd`, `<stem> Co`).
   Keep candidates whose normalised name equals the normalised input. Monday's `any_of` on `name`
   only returns exact names, so the variants are what let "Google" find "Google, LLC". *(Builder's
   call: a bounded variant list over reading the whole Organizations board. `benevity-import`'s
   learned aliases live in its own D1 and aren't shared; not used here.)*
3. **Exactly one candidate → apply.** Read the person's affiliations (Person, Organization, Status,
   Primary):
   - If one already links to this Organization, set it to Current and Primary. Otherwise create
     an affiliation (name: `<person> — <organization>`, Person, Organization, Current, Primary).
   - Every *other* affiliation of that person with Primary on: set Primary off. **Status is never
     changed** on another affiliation. Primary on imported data is NPSP's general "primary
     affiliation" flag, not "employer" (Salesforce brought in Organizations like "SVBC Volunteer"),
     and `contact-roles` reads only Current affiliations, so ending one automatically could drop a
     person's SVBC Roles from the pipeline boards. `employerSync` picks Primary first, so Employer
     Name still follows the donor's answer.
   - Then create a Change Requests item as today, with field `Employer (applied)`, old and new
     values, so staff see it. When a Primary was moved off another affiliation, the new value
     adds `(previous Primary: <organization>, still Current)` so staff can mark it Former if the
     donor has left.
   - If the matched affiliation was already Current and Primary, write nothing to Affiliations
     and still log the item, with field `Employer (no change)`.
4. **Zero or several candidates → staff.** Create a Change Requests item as today with field
   `Employer (needs an Organization)` and, for several, the candidate names in the new value
   (`"Acme" — 2 Organizations match: Acme Corp, ACME Inc`).

`employerSync` in `donation-rollups` then updates People → Employer Name from the new Current,
Primary affiliation, through the Affiliations webhooks it already subscribes to.

**Order and idempotency.** The affiliation writes come before the Change Requests item, and the
row is marked `written` only after the item. A retry after a partial run is safe because every
affiliation step reads current state first: the second pass finds the affiliation already
Current and Primary, finds no other Primary to demote, and logs the item (adopting it by name,
as today, if the first create landed). The log item's field then reads `no change` on a retry
where the first pass applied. Accepted; the old value still shows what changed.

**Write switch.** Unchanged semantics. The dry-run proxies (`dryRunChangeDeps`) must cover the
new Monday client methods so `off` logs the affiliation writes it would make and makes none.

### Config

`config/*.json` gains, under `changeRequests`:

```jsonc
"employer": {
  "affiliationsBoardId": 18437342615,
  "affiliationColumns": {
    "personLink": "...", "organizationLink": "...", "status": "...", "primary": "..."
  },
  "currentStatusLabel": "Current",
  "personAffiliationsLink": "..."   // People → Affiliations connect column
}
```

plus `monday.columns.donorEmployer` (People → Employer Name) for the old value. The writer reads a
person's affiliations through People's Affiliations link column, as `donation-rollups` does. `organizationsBoardId`
already exists. Absent `employer` block → the Employer option isn't shown (same gating as the
other fields). `config/split.test.ts` covers the new board ids. Column ids are the ones
`donation-rollups` already uses (sandbox and production).

### Access

The writer's Staff Sync identity needs write access to the Affiliations board, and read access
to Organizations and Affiliations. The integration user already has it (one user, #18), so this is
a statement of fact for the README, not a setup step.

### Post-gift email

The post-gift design's open question 1 ("unknown employer: send or skip?") is answered by this
issue: when People → Employer Name is blank, send the short version asking "Where do you work?"
with a link to `/:locale/portal/change-request#employer`. That edit belongs on the post-gift
design's own branch. This design doesn't change it.

## Testing

- Unit: normalising (suffixes, punctuation, case), candidate filtering (0, 1, several), each
  affiliation case (new; existing Former → Current; already Current and Primary; another Primary
  loses Primary but keeps its Status; non-Primary affiliations untouched), the log item's field
  and new value per case, retry after a partial run, and dry run under `off`.
- Routes and views: Employer option renders only when configured; the matching-gifts page link
  renders and the page still contains no donor value.
- Sandbox: a test person with a Current, Primary affiliation at org A submits org B's exact name,
  then a made-up name. Expect B Current and Primary, A still Current with Primary off, Employer
  Name updated by `employerSync`, and two Change Requests items (`applied` naming A as previous
  Primary, `needs an Organization`).

## Left to the builder

- Copy wording and translations.
- **Decided in the build:** the link is `/:locale/portal/change-request?field=employer`, not an
  `#employer` anchor. The form is one `<select>`, so the query parameter preselects Employer,
  which is what the anchor was for. The post-gift email links there.
- Whether the login flow preserves `?field=employer` (the magic-link flow lands on the portal home
  today; a link that loses it is acceptable for v1).
