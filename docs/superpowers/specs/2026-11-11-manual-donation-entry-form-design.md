# Manual donation entry form — design

**Status:** draft, 2026-11-11. Nothing built in Monday yet.

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
| 5 | Gift type | SingleSelect | yes | Gift Type | **Gift Type is a text column**; a form select can't write to text. Options: either convert the column to Dropdown (touches `salesforce-import`, `donation-rollups` classify, `funraise-sync` reads — check first) or use ShortText with the allowed values listed in the description. Recommend: leave column as text, ShortText, default `Donation`. |
| 6 | Campaign | ConnectedBoards (Campaigns) | no | Campaign | |
| 7 | Thank you already sent? | Boolean | no | Thank You Sent | For gifts acknowledged at the counter. |
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
`Cash/Check`), Check/Reference Number, Donor, Campaign, "Thank you already sent?". Login is
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
  Production needs the same two, plus the existing on-Amount-change ones its README mentions.
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

## Open questions

1. (Resolved: yes, via a board dropdown then an item dropdown.)
2. (Resolved: the columns already exist.)
3. Is converting Gift Type to a dropdown acceptable, or keep text?
4. Who owns the form (David, or Martha)?
