# Pledges and invoices on Donations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff enter a pledge on the "Enter a gift" form, record its invoice, and log its payment on one Donations item.

**Architecture:** Monday configuration (a Status label, columns, conditional form questions, views) on the sandbox, then production. Two operator scripts change: the form checker learns conditional questions, and the smoke test runs a pledge to payment. No Worker changes.

**Tech Stack:** Monday (GraphQL, MCP, UI), Node 22.18+ ESM `.mjs`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-24-pledges-and-invoices-design.md`

## Global Constraints

- Sandbox first. Tasks 5 and 6 need David's go-ahead in chat, given after the sandbox results.
- No test submission or test item on production.
- No Worker change is expected. If one looks necessary, stop and say so.
- If a required form question can't be conditional, stop and come back to David.
- Never send `options` to `form_questions_editor` for Status: an option left out of the list is deleted.
- Keep every existing Status label id. The new label must not get id 5 (Monday shows it on empty cells).
- A view update replaces the whole filter and column settings. Save the view's JSON first, then send the full new value. `update_view_table` over GraphQL takes `filter: ItemsQueryGroup` with nested `groups`; the MCP tool's filter is flat.
- Match columns by `bareTitle`, never `c.title === title`.
- Require login stays on for both forms. In the form editor, never accept "Sync titles".
- Sandbox token: `.env.sandbox` in the primary checkout. Never print or commit it.
- Workspace check before every write: sandbox is 18210301, production 18201685.

| | Sandbox | Production |
|---|---|---|
| Donations board | 18437342657 | 18437909794 |
| Organizations board | 18437342579 | 18437909779 |
| Form token | `2325fd7745d3a2d425086d38358e4bd5` | `567223ac739c23567e56e9057d81dbf5` |
| Status | `color_mm8hshet` | `color_mm8nspep` |
| Date | `date_mm8hfsvm` | `date_mm8nty3x` |
| Payment Method | `text_mm8he3n8` | `text_mm8nhwxp` |
| Check/Reference Number | `text_mm8h3vgd` | `text_mm8n2n3c` |
| Gift Type (Matching Donation = id 1) | `color_mm9arcwx` | `color_mm9afjhr` |
| Status label ids today | Received 0, Historical 1, Failed 2, Pending 3, Refunded 4 | same 0–3, Lost 4, Refunded 17 |

## Review Focus

1. **A hidden question submits its default** (today's date, `Cash/Check`): a pledge must have a blank Date and Payment Method. Task 1, Step 6.
2. **"Submit another" after a pledge:** the next Received gift must show Date received, and not keep the pledge's answers. Task 1, Step 7.
3. **Payment logged Date first, Status second, or the reverse:** no total moves until both are set, then it moves once. Task 3.
4. **Marked Received with no Date:** it counts nowhere, so it must stay in Pledges awaiting payment. Task 4, Step 4.
5. **Pledge with no Donor, or marked Lost:** the first shows in Needs a donor; the second leaves both pledge views. Task 4, Step 4.

---

### Task 1: Sandbox columns and conditional form (the gate)

**Files:**
- Modify: `docs/superpowers/specs/2026-11-24-pledges-and-invoices-design.md` (add a "Sandbox results" section)

**Interfaces:**
- Produces: the sandbox ids of Pledge Date, Invoice Date, Invoice Number, Accounts Payable (both boards) and the Pledged label; the actual `showIfRules` JSON. All recorded in "Sandbox results".

- [ ] **Step 1:** Read back `boards(ids: [18437342657]) { name workspace_id }`. Expected: `Donations (sandbox v4)`, 18210301. Save the sandbox form JSON (`get_form`) to the session scratchpad.
- [ ] **Step 2:** With `update_column`, add Status labels **Pledged** and **Lost** (sandbox has no Lost), sending every existing label with its id. Read back: ids 0–4 unchanged, and neither new id is 5. If one is 5, delete that unused label and add it again with an explicit id through `update_status_column`.
- [ ] **Step 3:** Create on Donations: `Pledge Date` (date), `Invoice Date` (date), `Invoice Number` (text). On Organizations: `Accounts Payable` (long_text). Then on Donations a mirror titled `Accounts Payable`, through Donor, of that column; use the UI if the API can't.
- [ ] **Step 4:** On the form add the `Pledge Date` board column (UI: Add content → Board columns) as "Pledge date", inside Page 1: required, defaults to today. Hide Invoice Date, Invoice Number and Accounts Payable if they appear. Set Status's description to: "Received for a check or cash in hand. Pending if in hand but not yet deposited or cleared. Pledged if promised but not yet paid."
- [ ] **Step 5:** With `form_questions_editor` (`show_if_rules` only), show Pledge date when Status is Pledged. Show Date received, Payment Method and Check/Reference Number when Status is any other option visible on the form. Read the form back through GraphQL at `2026-07` (the field is `showIfRules`; it is `show_if_rules` from `2026-10`) and record the JSON.
- [ ] **Step 6:** In Chrome, submit on the sandbox form: "TEST pledge", $300, Pledged, Gift Type Donation, Donor = Organizations / Medtronic (13397809169). Read the item. Expected: Status Pledged; Pledge Date today; Date, Payment Method and Check/Reference Number blank; tier Major. If a hidden default was submitted, remove that default (`defaultCurrentDate`, `default_answer`) and repeat. If Date still isn't blank, or the form won't submit, stop and report to David.
- [ ] **Step 7:** Click **Submit another**, then submit "TEST received", $40, Received, Donation, same donor. Expected: Date received is shown before submitting; the item has a Date and no Pledge Date.
- [ ] **Step 8:** Set Medtronic's Accounts Payable to `ap@example.org`. Expected: it shows on the TEST pledge item's mirror. Clear it, then delete both TEST items by id after checking their names.
- [ ] **Step 9:** Record ids, rule JSON and results in the spec, then commit.

```bash
git add docs/superpowers/specs/2026-11-24-pledges-and-invoices-design.md docs/superpowers/plans/2026-11-24-pledges-and-invoices.md
git commit -m "docs(donations): pledge and invoice design, plan and sandbox form results"
```

### Task 2: The form checker understands conditional questions

**Files:**
- Modify: `scripts/lib/donation-form.mjs`, `scripts/check-donation-form.mjs` (the `fetchForm` query)
- Test: `scripts/lib/donation-form.test.mjs`

**Interfaces:**
- Consumes: Task 1's rule JSON. Expected shape: `{ operator, rules: [{ operator, conditions: [{ building_block_id, operator, values }] }] }`, where `values` hold option `value`s. If Task 1 recorded another shape, use that one in the fixtures.
- Produces: `export const PLEDGED = 'Pledged'`; `export const SHOWN_FOR`, mapping `'Pledge date'` to `'pledged'`, and `'Date received'`, `'Payment Method'`, `'Check/Reference Number'` to `'not-pledged'`; `export function shownForLabels(question, statusQuestion): Set<string> | null` (`null` = always shown). `checkForm(form)` keeps its signature. `EXPECTED_QUESTIONS` gains `'Pledge date': true`.

- [ ] **Step 1:** Update `goodForm()`: Status gets `id: 'status'` and options Received `0`, Failed `2`, Pending `3`, Pledged `6` visible and Lost `4` hidden; each `SHOWN_FOR` question gets a matching rule. Add tests:

```js
it('flags a conditional question whose rule was lost', () => {
  const form = goodForm();
  form.questions.find((q) => q.title === 'Date received').showIfRules = { operator: 'OR', rules: [] };
  assert.deepEqual(checkForm(form), ['"Date received" should be shown for Received, Failed, Pending; it is always shown']);
});
it('flags Pledge date shown for the wrong status', () => {
  const form = goodForm();
  form.questions.find((q) => q.title === 'Pledge date').showIfRules = rule(['0']);
  assert.deepEqual(checkForm(form), ['"Pledge date" should be shown for Pledged; it is shown for Received']);
});
it('flags a visible status that leaves Date received hidden', () => {
  const form = goodForm();
  form.questions.find((q) => q.title === 'Status').options.push({ label: 'Refunded', value: '17', visible: true });
  assert.ok(checkForm(form).some((p) => p.startsWith('"Date received" should be shown for Received, Failed, Pending, Refunded')));
});
it('flags Status without a visible Pledged option', () => {
  const form = goodForm();
  form.questions.find((q) => q.title === 'Status').options.find((o) => o.label === 'Pledged').visible = false;
  assert.ok(checkForm(form).includes('Status should offer "Pledged"'));
});
it('flags an unconditional question that gained a rule', () => {
  const form = goodForm();
  form.questions.find((q) => q.title === 'Donor').showIfRules = rule(['0']);
  assert.deepEqual(checkForm(form), ['"Donor" should always be shown; it is shown for Received']);
});
```

- [ ] **Step 2:** Run `node --test scripts/lib/donation-form.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. Labels list in Status option order, hidden options excluded. A rule on any question other than Status is reported as `"<title>" has a rule on a question other than Status`. Add `showIfRules options { label value visible }` to the `fetchForm` query, with a comment that the field becomes `show_if_rules` in API 2026-10.
- [ ] **Step 4:** Run `node --test "scripts/*.test.mjs" "scripts/lib/*.test.mjs"`. Expected: PASS.
- [ ] **Step 5:** Run `check-donation-form.mjs --form 2325fd7745d3a2d425086d38358e4bd5` with the sandbox token. Expected: `OK`. (Production fails until Task 5; that is correct.)
- [ ] **Step 6:** Commit: `feat(scripts): check the donation form's pledge questions`.

### Task 3: Smoke test runs a pledge to payment

**Files:**
- Modify: `scripts/lib/donation-smoke.mjs`, `scripts/smoke-donation-entry.mjs`
- Test: `scripts/lib/donation-smoke.test.mjs`

**Interfaces:**
- Produces: `SCENARIOS[2] = { name: 'SMOKE pledge', amount: 300, donor: true, anonymous: false, status: 'Pledged' }`; `export function paymentSteps(cols, { dateISO }): object[]`, the column values for two writes in order. `NEEDED_COLUMNS` gains `'Pledge Date'`. `columnValues` and `checkItem` keep their signatures.

- [ ] **Step 1:** Add tests:

```js
it('writes a pledge with a Pledge Date and no Date, method or reference', () => {
  const v = columnValues(cols, SCENARIOS[2], { donorItemId: '42', dateISO: '2026-11-24' });
  assert.deepEqual(v[cols.get('Status')], { label: 'Pledged' });
  assert.deepEqual(v[cols.get('Pledge Date')], { date: '2026-11-24' });
  for (const t of ['Date', 'Payment Method', 'Check/Reference Number']) assert.equal(cols.get(t) in v, false);
});
it('fails a pledge that has a Date', () => {
  const text = new Map([[cols.get('Acknowledgment Tier'), 'Major'], [cols.get('Status'), 'Pledged'], [cols.get('Date'), '2026-11-24']]);
  assert.deepEqual(checkItem(cols, SCENARIOS[2], { text, donorIds: ['42'] }), ['SMOKE pledge: Date is "2026-11-24", expected blank']);
});
it('pays a pledge Date first, then Status', () => {
  assert.deepEqual(paymentSteps(cols, { dateISO: '2026-11-25' }), [
    { [cols.get('Date')]: { date: '2026-11-25' } },
    { [cols.get('Status')]: { label: 'Received' } },
  ]);
});
```

- [ ] **Step 2:** Run `node --test scripts/lib/donation-smoke.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. Expected Status in `checkItem` becomes `scenario.status ?? 'Received'`.
- [ ] **Step 4:** Extend `--rollups`, in this order, each a reported check:
  1. Lifetime Giving reaches +250 and is still +250 after another 20 s (the pledge doesn't count).
  2. Write `paymentSteps[0]`, wait 30 s: still +250.
  3. Write `paymentSteps[1]`: reaches +550 within `--wait`, and is still +550 after another 20 s.

  Put the reverse order (Status first, then Date) behind `--pay-status-first`, with a `parseArgs` test: `payStatusFirst` defaults to `false`.
- [ ] **Step 5:** Run `node --test "scripts/*.test.mjs" "scripts/lib/*.test.mjs"` and `node scripts/check-log-safety.mjs`. Expected: PASS.
- [ ] **Step 6:** Live, sandbox only: confirm `node scripts/flags.mjs status --env sandbox` shows `donation-rollups writes=on`. Run the smoke with `--board 18437342657 --donor 13397907956 --rollups`, then again with `--pay-status-first`. Expected: `PASS` twice, every created item deleted. If +250 doesn't hold, or the pledge counts early or twice, stop and report.
- [ ] **Step 7:** Commit: `feat(scripts): smoke-test a pledge from entry to payment`.

### Task 4: Sandbox views and this repo's docs

**Files:**
- Modify: `CLAUDE.md` (form paragraph), `docs/superpowers/specs/2026-11-11-manual-donation-entry-form-design.md` (Status answers; pointer to the new spec), `docs/manual/07-operations.md` (two script rows), the new spec's "Sandbox results"

**Interfaces:**
- Consumes: Task 1's column and label ids.
- Produces: exact filters, recorded in the spec for Task 5.

- [ ] **Step 1:** Save the JSON and item count of every sandbox table view to the scratchpad.
- [ ] **Step 2:** Add an ANDed rule to these views, keeping their other rules, grouping and sort:
  - Status `any_of` Received: Recent gifts 289082647, Revenue by funding stream 289082676, Major gifts to thank 289082701. (The sandbox has no Reconciliation: sponsorships.)
  - Status `not_any_of` Pledged: By gift size 289082690, By fiscal quarter 289082694, Matching gifts 289082714.

  In every other existing table view, hide the four new Donations columns if they show.
- [ ] **Step 3:** Create, showing Donor, Amount, Gift Type, Status, Pledge Date, Accounts Payable, Invoice Date, Invoice Number, Date, Payment Method, Check/Reference Number:
  - **Pledges to invoice:** Status Pledged AND Invoice Date empty; Pledge Date ascending.
  - **Pledges awaiting payment:** (Status Pledged AND Invoice Date not empty) OR (Status Received AND Date empty); Invoice Date ascending. Nested groups, so GraphQL or the UI.
- [ ] **Step 4:** Create five sandbox items named `TEST view …` and check where each shows:

| Item | Must show in | Must not show in |
|---|---|---|
| Pledged, no invoice | Pledges to invoice | Recent gifts, Major gifts to thank |
| Pledged, invoiced | Pledges awaiting payment | Pledges to invoice |
| Received, no Date | Pledges awaiting payment | Pledges to invoice |
| Lost, no Date | neither pledge view | Major gifts to thank |
| Pledged, no Donor | Needs a donor | Revenue by funding stream |

  Delete the five by id after checking their names.
- [ ] **Step 5:** Compare each changed view's count with Step 1. Every difference must be a Pending, Failed, Refunded, Historical or blank-Status item. Record the counts.
- [ ] **Step 6:** Update the docs listed above. Run `node scripts/check-manual.mjs`. Expected: PASS.
- [ ] **Step 7:** Commit: `docs(donations): pledge views and form notes`. Report the sandbox results to David and ask for the production go-ahead.

### Task 5: Production (only after David's go-ahead)

**Files:**
- Modify: the new spec (a "Production" section: ids, counts, date; Status line)

- [ ] **Step 1:** Save the production form JSON, the Status column settings, and every table view's JSON and count to `monday-migration/backup/` (gitignored there; check with `git check-ignore` first). Count the items each Received rule will remove, by Status. Tell David, because it also removes Received (Historical), Lost and blank-Status items.
- [ ] **Step 2:** Configure in this order. It is a live form, so agree a time with Martha when nobody is entering gifts, and finish Steps 2–5 in one sitting. Read back after each:
  1. List the board's automations and Sequences. None may email or notify about a gift on item created, Status or Tier. If one does, stop and ask David.
  2. Create the columns as in Task 1 Step 3. They don't appear on the form by themselves.
  3. Reorder with `update_form` `updateQuestionOrder` (every question id, each with its `page_block_id`) so Status is above Date received. Monday refuses a rule on a later question.
  4. Add the **Pledged** label, resending every other label exactly as read back (2026-11-24: Received 0, Received (Historical) 1, Failed 2, Pending 3, Lost 4, Refunded 17). It must not get id 5. **At once**, hide its form option with the option's own Hide option menu.
  5. Add Pledge Date to the form **not required**, set its rule (Pledged only), place it after Status with `updateQuestionOrder`, then make it required with today as default. Set Status's description.
  6. Set the rules on Date received, Payment Method and Check/Reference Number to Received, Failed and Pending.
  7. Read all four rules back, then unhide Pledged.
- [ ] **Step 3:** Repeat Task 4 Steps 2–3 with production ids. Received rule: Recent gifts 289689143, Revenue by funding stream 289689146, Major gifts to thank 289689150, Reconciliation: sponsorships 291648183. Exclude Pledged: By gift size 289689147, By fiscal quarter 289689149, Matching gifts 289689153.
- [ ] **Step 4:** Run `check-donation-form.mjs` on both form tokens with the matching environment's token. Expected: `OK` for each.
- [ ] **Step 5:** Open the production form in Chrome **without submitting**. Expected: choosing Pledged swaps the questions; choosing Received swaps them back.
- [ ] **Step 6:** Compare view counts as in Task 4 Step 5. Record everything in the spec. Commit: `docs(donations): pledges live on production`.

### Task 6: Staff docs (monday-migration)

**Files:** in a new worktree `../monday-migration-pledges` on branch `docs/pledges-and-invoices`
- Modify: `docs/06-staff-process-guide.md`, `protocols/monday/entering-payments.md`, `protocols/monday/requesting-an-invoice.md`

- [ ] **Step 1:** `docs/06`: in "Log a manual donation", add Pledged, the two pledge views, and the payment steps (Status **and** Date). Remove its "Thank you already sent?" sentence, which the form has hidden since 2026-11-12.
- [ ] **Step 2:** `entering-payments.md`: a section "Steps: a pledge" with the four lifecycle steps, and a warning before "Steps: a sponsorship…" to look for an open pledge first and not add a second item. Connect the gift on Sponsorships or Grants & Contracts only once it is Received: staff work out the balance from the connected items. To fix a gift entered as Received by mistake, set Status to Pledged, fill in Pledge Date, and clear Date and Fiscal Year Ending (since #115; before it, delete and re-enter). Never put an expected payment date in Date.
- [ ] **Step 3:** `requesting-an-invoice.md`: Martha invoices company pledges entered on Donations and records Invoice Date and Number there; everything else still goes through Invoicing Tasks. In "First, make sure the gift exists", say the item is entered as Pledged, with Date blank.
- [ ] **Step 4:** Commit: `docs(donations): pledges and invoices for staff`. Ask David before pushing, opening a PR, or changing the Box copies.
