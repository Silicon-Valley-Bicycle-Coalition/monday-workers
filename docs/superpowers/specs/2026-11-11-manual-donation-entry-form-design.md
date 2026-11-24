# Manual donation entry form — design

**Status:** built on the sandbox and production, 2026-11-11 (see the build sections below). Pledges,
and the questions that depend on Status, are in `2026-11-24-pledges-and-invoices-design.md`.

## Problem

Staff with a CRM seat (Martha, Deanna, Felicia, Clarrissa, …) log a check, cash, or other
non-Funraise gift by adding a raw item to the Donations board and filling ~6 columns by hand
(`monday-migration/docs/06-staff-process-guide.md`, "Log a manual donation"). Failure modes seen
or implied by the docs:

- Donor link left empty, so the gift counts for nobody (`donation-rollups` drops a gift with no
  Donor; it appears in the **Needs a donor** view).
- Status left at the board default instead of `Received`.
- Gift Type typed free-form (`Donation`, `donation`, `Check`, …); the column is plain text.
- Date and Amount in the wrong columns, or Amount typed with `$`/commas.
- Fiscal Year Ending left blank (see "What the form can't set").

A form gives one screen, required fields, and consistent values.

## Decision: a form view on the Donations board

Submissions must create items **on the Donations board itself** so the `create_item` webhook
reaches `donation-rollups` and the board's Acknowledgment Tier automations fire. Do not use a
separate intake board plus a copier — it adds a Worker and a failure mode for no gain.

**Constraint found:** the Monday MCP `create_form` tool always creates a *new backing board*;
it cannot attach to an existing one. So the form is created in the Monday UI (Donations board →
Views → **Form**), then its questions can be edited via `form_questions_editor` / the UI. This
needs verifying on the sandbox before production.

Build and test on the sandbox Donations board (v4, workspace 18210301) first. Production
afterward, same steps.

## Questions

| # | Question | Type | Required | Maps to | Notes |
|---|---|---|---|---|---|
| 1 | Anonymous gift? | Boolean | no | Anonymous Donor | Default unchecked. When checked, hides Q2. |
| 2 | Donor | ConnectedBoards | yes (unless Q1) | Donor | Must offer People, People (Historical) **and** Organizations. A connect column spanning three boards may only pick from one in the form UI — verify. Fallback: two questions (Person / Organization), exactly one required via show-if. |
| 3 | Amount | Number | yes | Amount | Description: "Dollars, no $ or commas." |
| 4 | Date received | Date | yes | Date | Default today. For a check, the date it was deposited/received, not written. |
| 5 | Gift type | SingleSelect | yes | Gift Type | Gift Type becomes a **Status** column (decided 2026-11-20; see "Gift Type as a Status column"), so the question is a single select of its labels. Default `Donation`. |
| 6 | Campaign | ConnectedBoards (Campaigns) | no | Campaign | |
| 7 | ~~Thank you already sent?~~ | Boolean | — | Thank You Sent | **Hidden (2026-11-12).** The form is only for entering checks and cash. Thank-yous are sent separately and recorded on the board, so the form doesn't set this column. |
| 8 | Payment method | ShortText | no | Payment Method | Default `Cash/Check`. Column already exists. |
| 9 | Check / reference number | ShortText | no | Check/Reference Number | Column already exists. |

Item name (required by Monday): a Name question "Name for this entry", prefilled and described as
"Donor name — $amount", or set by a board automation after creation. Prefer the automation.

## Values the form can't set directly

- **Status = Received.** Superseded by test results below: Status is a required form question.
  (Original idea was a board automation; hidden Status leaves it blank.)
- **Fiscal Year Ending.** The column is computed text. `donation-rollups` falls back to deriving
  it from Date, so donor rollups are correct, but the cell stays blank on the board until
  something stamps it (README, "A blank Fiscal Year Ending cell…"). The nightly `classify` duty
  fills Gift Fiscal Year / Fiscal Quarter / Funding Stream / Gift Size. Options: (a) accept
  blank, (b) add a `change_column_value`-free board automation, (c) have `classify` also stamp
  Fiscal Year Ending. (c) is the real fix; out of scope here, log as a follow-up.
- **Acknowledgment Tier.** The board's own automations set it on create; the README notes they
  once missed creates (funraise-sync 2026-11-02) and `classify` backstops nightly. Verify the
  create trigger fires for form-created items.

## Schema check, sandbox v4 Donations board 18437342657 (2026-11-11, read-only)

- **No schema additions needed.** The board already has **Payment Method** (text,
  `text_mm8he3n8`; Salesforce values `Credit Card`, `Cash/Check or Stock`) and
  **Check/Reference Number** (text, `text_mm8h3vgd`, "for matching a gift to a deposit"). Replace
  question 8 with two: Payment Method (ShortText, default `Cash/Check`) and Check/Reference
  Number (ShortText, shown only for checks).
- **Donor** is one `board_relation` column over three boards (People 18437342592, People
  (Historical) 18437342607, Organizations 18437342579), so a single Donor question is at least
  structurally possible. Whether the form's picker searches all three is still unverified.
- **Status** label `Received` is id 0 / index 0. If the board's default for new items is that
  first label, no automation is needed; otherwise add the automation above. Verify with a test
  submission.
- The board currently has **no forms** (the API listed no views at all, though the UI shows
  seven tabs), so this form is net-new.

## UI check, sandbox v4 (2026-11-11)

I added a **Form** view to the sandbox Donations board (view 291635597) in the Monday UI.

- **A form view attaches to the existing board.** Board views → Form. Submissions will create
  items on the Donations board itself. (Settles the earlier open question; `create_form` over
  MCP still only makes new backing boards, so build in the UI.)
- **The default form exposes every column**, including the 🔒/📜 integration-owned ones
  (Funding Stream, Gift Size, DTD fields, Benevity ID…). **Most of them must be hidden or
  deleted from the form** or staff will overwrite what the Workers write. Keep only the
  questions in the table above.
- **Donor works.** Connect-boards questions render as two dropdowns: first pick the board
  (People / People (Historical) / Organizations), then the item. So the single Donor question
  covers all three boards; no Person/Organization split needed. They carry a **Beta / Trial**
  badge and a 🔒 **Restrict form** control, consistent with the login requirement below.
  Typing to search 4,000+ People in the Items dropdown is untested.
- **Name** is a question on the form by default; "Include name question in form" is a setting
  and can be turned off if an automation names items.

## Sandbox build and test results (2026-11-11)

The sandbox form (token `2325fd7745d3a2d425086d38358e4bd5`) is configured: 28 integration-owned
and legacy questions hidden; visible are Name, Amount\*, Date received\* (defaults to today),
Status\*, Gift Type\* (default `Donation`), Anonymous Donor, Payment Method (default
`Cash/Check`), Check/Reference Number, Donor, Campaign ("Thank you already sent?" was hidden on 2026-11-12). Login is
required (`requireLogin: enabled`). Configure through `form_questions_editor` (`visible`,
`required`, `description`, `settings.default_answer`, `defaultCurrentDate`); it works on a form
view created in the UI.

Three submissions (TEST form entry - person check / anonymous cash / org check) created items on
the Donations board with the right Donor link (People item; Organizations item; none with
Anonymous Donor checked), Amount, Date, Gift Type, Payment Method, and Check/Reference Number.

Findings:

- **Status has no board default.** The first submission, with Status hidden, landed with Status
  blank. So the form makes Status a **required** question (options Received / Failed / Pending;
  `Received (Historical)` hidden), instead of the board automation proposed above. Submissions
  2 and 3 landed `Received`.
- **Acknowledgment Tier is blank on creation**, as is Fiscal Year Ending and the four
  classification labels. Nothing fires on a form-created item; the nightly `classify` duty fills
  them in (README), so a $1,200 gift is not in **Major gifts to thank** until the next morning.
  Fix options: a board automation (item created → set Tier by Amount), or have `classify` run
  sooner. Open.
- **Tier automations (sandbox, 2026-11-11).** The sandbox board has no Tier automations (only the
  five `donation-rollups` webhooks). Added via `create_automation`: *item created, Amount ≥ 200 →
  Acknowledgment Tier = Major* (7926591169) and *item created, Amount < 200 → Standard*
  (7926591113). **Check the generated threshold:** the first attempt (7926591097) compared Amount to
  the item's own Amount, i.e. always true; it was deleted. **Verified:** a $250 and a $40 form
  submission landed as Major and Standard within ~3 seconds. Always read back the generated
  threshold (a literal `200`, not an `item.<column>` reference) after `create_automation`.
  **Production already has them** (checked 2026-11-11): four board automations, on item created
  and on Amount change, each with a Major rule at >= 200 and a Standard rule at <= 199.99, so only
  the sandbox needed these two.
  The other blank fields (Fiscal Year Ending, Funding Stream, Gift Size, quarter/year labels) are
  still filled only by the nightly `classify`.
- **The Donor picker is multi-select** (the chosen name appears as a removable chip and the
  list stays open). Staff could link two donors to one gift; only the first counts for
  rollups? Unverified; describe as "pick one" in the question text.
- **Donor search is type-ahead** and works for People and Organizations. It needed a
  keyboard Enter or arrow-and-Enter to select reliably in automation; a mouse click should work
  for staff.
- Not tested: the `donation-rollups` webhook on these three items (donor Lifetime Giving /
  This Year), and the three test items are still on the sandbox board.
- Gift Type and Payment Method are both text, so neither can be a form dropdown without
  converting the column.

## Gift Type as a Status column (decided 2026-11-20)

Free text had drifted on production (`Grant` beside `Grants`, `Contract` beside `Contracts`), and a
form select can only write to a select column. Status rather than Dropdown: a gift has exactly
one type, Status is single-select, Workers already write it as a plain label string, and
`contains_text` filters keep working (`dtd-sync` relies on that).

**Labels.** Salesforce's Opportunity record types (counts from the `svbc` org), plus the labels
Workers and staff write that Salesforce never had:

| Label | Salesforce records | Written by |
|---|---|---|
| Donation | 24,950 | `funraise-sync`, `benevity-import`, staff |
| Membership | 15,003 | historical |
| Sponsorship | 3,617 | staff |
| Matching Donation | 3,067 | `benevity-import`, staff |
| In Kind Donation / Sponsorship | 1,109 | staff |
| Contracts | 479 | staff |
| Grants | 125 | staff |
| Commute Workshop | 65 | staff |
| Driver Training | 21 | staff |
| Event Ticket | — | `funraise-sync`, `eventbrite-sync` |
| Donor Advised Fund | — | staff (`donation-rollups` counts it toward membership) |
| Click & Pledge (historical) | — | `salesforce-import` |

`Major Gift` (one Salesforce record) is left out. Existing `Grant` and `Contract` cells are
relabeled `Grants` and `Contracts`, the spelling every Worker config uses.

**Conversion.** The Monday API cannot change a column's type (`update_column` requires the
existing type), so it is done in the board UI: Gift Type column menu → **Change column type** →
Status. Monday does **not** convert in place: it adds a new Status column titled Gift Type (new
id), copies every value into it as a label (a few seconds per thousand items), and leaves the
text column beside it with the same title. So every config that holds the column id changes.

Sandbox, done 2026-11-20: new column `color_mm9arcwx`, all 4,125 items copied label-for-label
(checked by grouping both columns). Then:

1. Rename the old column `Gift Type (old text)` at once (`change_column_title`): two columns
   titled Gift Type break every lookup by title (`impact-attribution`, `report-digests`,
   `bareTitle` scripts).
2. Set the labels and order above with `update_column` (keeps existing label ids; the copy made
   none of Monday's `Working on it` / `Done` / `Stuck` defaults). Copy the description.
3. Repoint views that filter the old column. Sandbox had one, **Matching gifts**
   (`contains_text` "Matching Donation" → `any_of` the Matching Donation label; 366 items before
   and after). `contains_text` still works on a Status column, so `dtd-sync`'s query is fine.
4. Form: a new column is **not** added to the form by itself. In the form editor, Add content →
   Board columns → Gift Type, then (API) make it required, Dropdown, Custom order, with Event
   Ticket and Click & Pledge (historical) hidden (Workers write those, staff don't); hide the
   old text question. Dismiss the editor's "Question title out of sync" dialog with ✕: **Sync
   titles** would overwrite the form's own wording ("Date received", …). The new question lands
   outside the page block; drag it into Page 1 in the outline. `check-donation-form.mjs` now
   fails if the visible Gift Type question isn't a SingleSelect.
5. Point the Worker configs at the new id and deploy. Writes are plain label strings, which a
   Status column takes as label names (verified: create and change both land; an unknown label
   fails with `missingLabel`).
6. After the deploys, copy over any Gift Type written to the old column in the meantime (items
   whose new cell is empty), then delete the old column.

**Production, done 2026-11-20:** new column `color_mm9afjhr` on board 18437909794 (old
`text_mm8nyftg`). The one `Grant` and one `Contract` cell became `Grants` / `Contracts` first;
all 4,265 values then copied label-for-label (one item was blank in both). Label ids match the
sandbox's (Donor Advised Fund 12, Click & Pledge (historical) 17, Driver Training 151, Commute
Workshop 160). Four views filtered the old column and were repointed with the same meaning,
counts unchanged: Matching gifts and Reconciliation: matching gifts (`any_of` Matching
Donation, 381), Reconciliation: sponsorships (`any_of` Sponsorship, In Kind Donation /
Sponsorship, 59: the old `contains_text` "Sponsorship" matched both), Reconciliation: individual
gifts (`not_any_of` the eight non-individual labels, 3,229). On the form, adding the column from
the "+" under the old Gift Type question places it right after Status, inside the page.

**Code.** Readers take the cell's text, which is the label for a Status column, so only
`impact-attribution`'s column-type check changed (it accepts `status` or `text`). `dtd-sync`'s
`excludeGiftTypes` now names `Grants` / `Contracts`. A writer that sends a label that doesn't
exist fails the item write, so add the label to the column before configuring a new value.

## Access and safety

- Form **must require a Monday login** (not public / not "anyone with the link"): it writes
  donor financial records and links to donor PII.
- Share only with the CRM members. Everyone else on staff is view-only on CRM boards by the
  2026-10-26 decision, and a form must not become a back door around that.
- Submissions are attributed to the submitter, which gives an audit trail for free.

## Duplicates

No uniqueness check exists for hand entry. Mitigation for v1: a board view **Manual entries
this week** (filter: Funraise ID empty, Benevity Transaction ID empty, created last 7 days)
so Martha can eyeball before moving on. A duplicate guard (same Donor + Amount + Date) would be
a Worker; not justified yet.

## Rollout

1. Build the form on the sandbox v4 Donations board; add the Status automation.
2. Submit three test gifts (check from a person, cash anonymous, org check). Confirm: donor
   rollups update (Lifetime Giving, This Year), Tier set, gift absent from **Needs a donor**,
   Status Received.
3. Have Martha run it in sandbox UAT; add a section to `docs/uat/` if kept.
4. Repeat on production Donations board; update `docs/06-staff-process-guide.md` "How to" in
   `monday-migration` to point at the form.

## Production build (2026-11-11)

Form view added to the production **Donations** board (18437909794, workspace Donors & Contacts),
view 291640300, token `567223ac739c23567e56e9057d81dbf5`. Same configuration as the sandbox, with
the production column ids, plus:

- **Require login was OFF by default on this form** ("public and available to anyone with the
  link"), unlike the sandbox one. It was turned on before anything else was configured. Check this
  on every new form view.
- Production has one extra question to hide (Benevity Disbursement Date) and two extra Status
  options hidden (Refunded, Lost); Status offers Received, Failed, Pending.
- Tier automations already exist (above); no new automations were added.
- **No test submission was made** (it would write a real gift). The form was verified by loading
  it and reading its questions.
- The form is login-required but not otherwise shared. The view tab is named **Enter a gift**
  (renamed from `Form`) and is visible to anyone who can see the board. Tell Martha where it is.

## New donors (2026-11-11)

The Donor question only links an existing People, People (Historical) or Organizations item, so a
check from someone not yet in the CRM needs the donor added first. Decision: **no companion
intake form**. Adding a person is already a documented step (staff guide §1, "Add a new person":
a new item on People, after checking People (Historical); Box protocol "Adding People and
Organizations in Monday"), and a People form could not search for an existing record, so it would
create duplicates; staff also cannot merge duplicates themselves. Instead the Donor question says:
"Not found? Check People (Historical) too. If they are really new, add them on the People or
Organizations board first, then come back." Applied to the sandbox and production forms. Revisit
if Martha reports that new donors are common enough to want the form.

## Duplicate check (2026-11-11)

Nothing stops the same check being entered twice. Decision: a board view, not a Worker (a check on
donor, amount and date would be more code than the risk justifies; revisit if duplicates show up).
View **Manual entries, last 14 days** on the Donations board (production 291654705, sandbox v4
291654528), tagged worklist:

- Filter: Funraise ID, Benevity Transaction ID, Eventbrite Order ID **and Salesforce ID** all
  empty, and created within the last 14 days. The Salesforce ID rule is what keeps migrated history
  out; the date alone is not enough in the first two weeks after a load.
- Sorted by Donor, then Amount (descending), with Date received, Status, Payment Method, check
  number, Anonymous Donor, Thank You Sent and Tier shown, so two entries for the same donor and
  amount sit next to each other.
- Verified on the sandbox with two deliberately duplicated test gifts (deleted afterward): only
  they appeared, adjacent. Production shows no results until a manual gift is entered.
- Limits: it relies on a person looking. A manual gift whose Donor is blank (anonymous) sorts
  first and duplicates there are only visible by amount and date.

## Batch entry (2026-11-11)

A deposit is often 10 to 30 checks, entered one form at a time. What the form can and cannot do,
tested on the sandbox form (a production form carries the same two settings):

- **Submit another: on.** The thank-you page shows a "Submit another" button that reopens the
  form without a reload, titled "Gift saved". It resets **every** field, including the date.
- **URL prefill works for Payment Method only.** `?method=Credit%20Card` on the form link fills
  Payment Method (question setting `prefill`, source `QueryParam`, lookup `method`). Useful for a
  bookmark of the form link per payment type.
- **URL prefill does not work for Date received.** The date question ignores `?date=...` in both
  `2026-11-05` and `2026/11/05` forms (with "default to today" on or off), so a deposit dated
  before today needs the date picked on each entry. Left as default-to-today, the right default
  for a single gift.
- Not tried: Status or Donor prefill (Donor is a connected-boards question).
- For a deposit of many checks, a bulk path (a board-level import) would be the real fix, but it
  bypasses the form's required fields and the donor link; not built.

## Open questions

1. (Resolved: yes, via a board dropdown then an item dropdown.)
2. (Resolved: the columns already exist.)
3. (Resolved 2026-11-20: convert Gift Type to a Status column; see "Gift Type as a Status column".)
4. Who owns the form (David, or Martha)?
