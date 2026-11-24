# Pledges and invoices on the Donations board — design

**Status:** approved by David, 2026-11-24. Live on the sandbox and production 2026-11-24. Sandbox first, then production.
Extends `2026-11-11-manual-donation-entry-form-design.md`.

## Intent

A company pledges a donation. Martha enters it on **Enter a gift** with that day's other donations,
sends an invoice to the company's accounts payable address, then logs the payment when it arrives.
Today the form has no way to say "promised, not paid", and nothing on Donations records an invoice.

## Goals

- Enter a pledge once, in the form already used each day.
- See which pledges need an invoice and which invoices are unpaid.
- Log the payment on the same item, with no second entry.
- A pledge counts in no donor total or revenue figure until it is paid.

## Non-goals

- Creating, emailing or syncing invoices (`quickbooks-sync` stays postponed).
- Several invoices or part payments on one item.
- Changing Sponsorships, Grants & Contracts or Invoicing Tasks.
- Cleaning up the 40 existing `Pending` items.

## Anti-goals

- A pledge appears as money received, or gets a gift thank-you before it is paid.
- A paid pledge counts nowhere because its Date was left blank, and nobody notices.
- A pledge is entered a second time when the check arrives.

## Approaches

- **A. All on Donations (picked by David, 2026-11-24).** One item goes Pledged → invoiced →
  Received. Fits Martha's day; one invoice per item.
- **B. Pledge on Donations, invoice on Invoicing Tasks.** Several invoices per pledge and one queue
  for Deanna, but two boards per pledge. On production that board is empty and has no Invoiced
  status and no Donation link.
- **C. Pledge on Sponsorships.** Dropped: leaves the form, and doesn't fit other pledges.

## Design

Everything below is the author's call unless it says otherwise.

### Columns

| Board | Column | Type | Notes |
|---|---|---|---|
| Donations | Status: new label **Pledged** | status | Keep every existing label id. Don't use id 5, which Monday shows on empty cells. |
| Donations | Pledge Date | date | Set by the form. |
| Donations | Invoice Date | date | Filled when the invoice is sent. Blank means not invoiced. |
| Donations | Invoice Number | text | |
| Donations | Accounts Payable | mirror | From Organizations, through Donor. |
| Organizations | Accounts Payable | long text | Email, postal address or portal, as the company wants it. Kept for next year. |

### Form (Enter a gift)

- Status offers **Pledged**. Its description says what Pledged and Pending each mean: Pending stays
  "in hand, not yet deposited or cleared".
- Status = Pledged shows **Pledge date** (required, defaults to today).
- Any other Status shows **Date received** (required), Payment Method and Check/Reference Number.
- Invoice Date, Invoice Number and any question for Accounts Payable are hidden.
- **Must hold:** a hidden Date received submits blank, not today's default, and a hidden Payment
  Method doesn't submit `Cash/Check`. If Monday submits hidden defaults, drop those defaults. If a
  required question can't be conditional, stop and come back to David.

### Lifecycle

1. **Pledge:** form, Status Pledged. Date stays blank.
2. **Invoice:** Martha fills Invoice Date and Invoice Number from the to-invoice view.
3. **Payment:** on the same item, set Status to Received, Date to the deposit date, Payment Method
   and Check/Reference Number.
4. **Never paid:** Status Lost.

A pledge paid in parts is entered as one item per expected payment.

### Why Date stays blank

Read from the code, to be proved in the sandbox: `donation-rollups` counts only `Received`, and
`getDonationsByIds` skips an item with no Date, so a pledge shouldn't enter the gift ledger. The
year-end archive works from that ledger, so it shouldn't archive an unpaid pledge. Setting Date and
Status fires the column-change webhook, which picks the gift up. `classify` still fills Funding
Stream and Gift Size on a pledge, so those views need the filters below.

### A gift entered as Received that was really a pledge

**Delete the item and enter it again as Pledged.** Don't change Status and clear Date: an item with
no Date is skipped before the ledger is refreshed, so the old Received row stays in the ledger and
keeps counting in the gift history, membership, Organizational Giving and the roll call, though
Lifetime Giving drops. Deleting the item removes the row. Likewise, don't put an expected payment
date in Date. A Worker change (a cleared Date removes the ledger row) would lift this; it is not
part of this work unless David asks for it. (Found in review, read from the code, not run.)

### Views on Donations

New:

- **Pledges to invoice:** Pledged, Invoice Date blank; oldest Pledge Date first; shows Accounts Payable.
- **Pledges awaiting payment:** Pledged with an Invoice Date, **or** Received with a blank Date (the
  forgotten-date case); oldest Invoice Date first.

Changed (sandbox equivalents too, where they exist):

- Status = Received added to **Recent gifts**, **Revenue by funding stream**, **Major gifts to
  thank** and **Reconciliation: sponsorships**. The last two then match the dashboard tile and the
  other reconciliation views. These four also stop showing Pending, Failed and Refunded items.
- Pledged excluded from **By gift size**, **By fiscal quarter** and **Matching gifts**.

Record each changed view's item count before and after; explain every difference.

### Code and docs

- `scripts/lib/donation-form.mjs`: allow Pledge date, and check the show-if rules so a form that
  loses them fails. Tests beside it.
- `scripts/lib/donation-smoke.mjs`: a pledge scenario. No Date, Lifetime Giving doesn't move; then
  mark it Received with a Date, and it moves once.
- This repo: CLAUDE.md's form paragraph and the 2026-11-11 spec, if they become wrong.
- `monday-migration`: `docs/06`, `protocols/monday/entering-payments.md` and
  `requesting-an-invoice.md` (Martha invoices these pledges; Invoicing Tasks stays for the rest).
  The Box copies are staff-facing, so ask before changing them.
- No Worker change is expected. If the sandbox shows one is needed, stop and say so.

## Constraints

- Sandbox board 18437342657 before production 18437909794.
- Production schema, form and view changes wait for David's go-ahead after the sandbox results.
- No test submission on production.
- Run `check-donation-form.mjs` on both forms after each change; Require login stays on.

## Done when

On the sandbox: a pledge submitted through the form has no Date, appears only in the pledge views,
moves no donor total, gains an invoice, then is paid and counts exactly once.

## Left to the builder

Question order and wording, label color, and whether the mirror and show-if rules are made by API or
in the Monday UI.

## Sandbox results

**Columns and labels (2026-11-24).** Status `color_mm8hshet`: Pledged id 7, Lost id 17 (new; the
sandbox had no Lost), ids 0–4 unchanged. Donations: Pledge Date `date_mm9d2ncc`, Invoice Date
`date_mm9dtepz`, Invoice Number `text_mm9d82jz`, Accounts Payable mirror `lookup_mm9d170t`.
Organizations: Accounts Payable `long_text_mm9dntrm`. The API created all of them, mirror included.

**Form.** New columns did not appear on the form by themselves; Pledge Date was added in the editor.

- A question can't depend on one below it ("Question cannot reference questions that come after
  it"), so Status moved above Date received. `form_questions_editor` can't move a question;
  `update_form` `updateQuestionOrder` can, and sets `page_block_id` (a question added in the editor
  lands outside the page). It needs every question id.
- Lost was hidden on the form with the option's own menu (Hide option).
- Rule JSON, read back at API 2026-07 as `showIfRules`:
  `{"operator":"OR","rules":[{"operator":"OR","conditions":[{"building_block_id":"color_mm8hshet","operator":"OR","values":["7"]}]}]}`.
  Date received, Payment Method and Check/Reference Number carry `["0","2","3","4"]`.

**Submissions.** Both made in Chrome on the live sandbox form, then deleted.

- Pledged, after switching Received and back so the hidden questions held their defaults: Pledge
  Date set; Date, Payment Method and Check/Reference Number blank; Tier Major. No default had to go.
- "Submit another", Received: Date received shown with today's date; saved with Date and
  Cash/Check, no Pledge Date.
- Accounts Payable typed on the organization showed on both items' mirror.
- Typing a Status and pressing Return does not select it; the option must be picked.

**Rollups.** `smoke-donation-entry.mjs --rollups` passed in both payment orders: the pledge moved
nothing when entered, nothing after only its Date or only its Status was set (60 s hold), and
counted once when both were. `donation-rollups` takes about 30 s to move a total.

**Views.** Pledges to invoice 293852958; Pledges awaiting payment 293852963 (nested groups, set
through `create_view_table`). Every other setting on the existing views read back unchanged, plus
the four new columns hidden.

| View | Before | After | Difference |
|---|---|---|---|
| Recent gifts | 4,125 | 3,825 | 300 Failed or Pending |
| Revenue by funding stream | 4,125 | 3,825 | 300 Failed or Pending |
| Major gifts to thank | 400 | 381 | 4 Failed, 15 Pending |
| By gift size, By fiscal quarter | 4,125 | 4,125 | none |
| Matching gifts | 366 | 366 | none |

Five test items (Pledged, invoiced, Received with no Date, Lost, no Donor) each showed only where
they should. Lost items still show in By gift size and By fiscal quarter, as Failed ones do. A
Received gift with no Date also shows in Recent gifts until it is dated. All were deleted.

## Production (2026-11-24)

Donations 18437909794, Organizations 18437909779. Status `color_mm8nspep`: Pledged id 7, every other
label unchanged. Pledge Date `date_mm9ddbhr`, Invoice Date `date_mm9deh91`, Invoice Number
`text_mm9drsq5`, Accounts Payable mirror `lookup_mm9dtyv3` (of Organizations `long_text_mm9dze8r`).
Views: Pledges to invoice 293856484, Pledges awaiting payment 293856489. The state before the change
is in `monday-migration/backup/pledges-production-before-2026-11-24/`.

- The form editor must be loaded after the label exists to hide its option. Setting the payment
  questions' rules at once closed the same gap (a Pledged submission could no longer carry a Date),
  so the option was never hidden. No gift was submitted during the change.
- `check-donation-form.mjs` passes on both forms; every question not named above read back unchanged.
  In Chrome, choosing Pledged and Received swapped the questions. **Nothing was submitted on
  production**, so the first real pledge is the first end-to-end run there.
- No automation or Sequence on the board emails or notifies about a gift.

| View | Before | After | Removed |
|---|---|---|---|
| Recent gifts, Revenue by funding stream | 4,284 | 3,966 | 318: 263 Failed, 40 Pending, 12 Refunded, 2 Lost, 1 blank |
| Major gifts to thank | 424 | 404 | 20: 15 Pending, 3 Failed, 1 Lost, 1 blank |
| Reconciliation: sponsorships | 57 | 51 | 6 |
| Every other table view | | | none |

The blank-Status item in Major gifts is 13576783744; it returns to that view once its Status is Received.
