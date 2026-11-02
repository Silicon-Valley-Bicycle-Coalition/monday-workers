# Donor Roll Call board — design

**Date:** 2026-11-02 · **Status:** reviewed (builder check 2026-11-02), awaiting approval · **Worker:** `donation-rollups` (new custodian
duty) · **Background:** monday-migration `docs/40-donor-roll-call.md` and
`protocols/monday/donor-roll-call.md`

## 1. Intent

SVBC's Annual Impact Report lists donors by giving tier ($50,000+ … $100+) for one fiscal year
(July–June), with couples combined under one name and sponsors alongside individuals. Felicia
Ward (development) owns that list. Today it comes from a script David runs by hand
(`monday-migration/scripts/donor-roll-call.mjs`), which writes a review spreadsheet.

David shouldn't have to run anything, and Felicia shouldn't have to ask. This design makes the
roll call a **Monday board that keeps itself current**: one item per household or organization
per fiscal year, with the year's total and tier. Felicia filters to a year, reviews and exports it
whenever she likes.

### Goals

- Felicia gets the roll call for any year from FY2026 on, plus the year in progress, without
  asking anyone.
- Households are added together once: people sharing a **Household ID** on People are one row,
  named by their **Household Greeting**.
- Felicia's decisions **carry forward**: a name fix or "don't list this donor" is made once, on
  the donor's own record, and applies every year after (decided with David 2026-11-02).
- Closed years stay on the board permanently, so a past report can be reproduced. That removes
  the script's limit, which could only read the current and previous year because older gifts
  are archived on Donations.
- The board matches the script's output for FY2026. The script was reconciled against
  Salesforce: 1,204 of 1,431 households matched to the cent, and the rest are explained in
  monday-migration docs/40 §5.

### Non-goals

- Years before FY2026. The ledger has them back to FY2005, but nobody has asked. A one-off
  export can cover any request.
- Layout or design of the printed report. The board is the data; design takes an export.
- Grouping households automatically. People are grouped only by Household ID, which staff
  maintain; the board flags likely misses for review, as the script does.

### Anti-goals (failure even if it "works")

- **Overwriting a staff decision.** The board is entirely Worker output. Anything a person
  decides lives on People or Organizations, never on a board cell the Worker rewrites.
- **Double counting.** A household's gifts are never counted once per member, and a gift is
  credited to exactly one row.
- **Listing a payer who isn't a donor.** Contracts (payment for services) aren't gifts, and stay
  off by default.

## 2. Decided (with David, 2026-11-02)

- Self-serve board, not a yearly emailed spreadsheet.
- Decisions carry forward, stored on the donor's record:
  - **People** (both boards): the existing **Household Greeting** is the printed name. A new
    checkbox, **Don't List in Recognition**, keeps the person (and their household) off the
    printed list.
  - **Organizations:** a new **Recognition Name** text column (blank = Name) and the same
    **Don't List in Recognition** checkbox.
- History: **FY2026 onward**, plus the year in progress.

## 3. Rules (carried over from the script; see docs/40 §3)

The FY2026 script and this board must agree, so the rules are the script's:

- **Counted gifts:** Status Received or Received (Historical); fiscal year as the ledger records
  it; Gift Type not in a configured exclusion list (default `["Contracts"]`).
- **Credit:** a Matching Donation goes to its **Matched By** company. With no Matched By, the
  employee keeps it and the row's Review Note says how much. Every other gift goes to its Donor:
  a person, or an organization (an organization's gift through an affiliated person already has
  the organization as Donor). Soft credits count for nobody.
- **Anonymous:** gifts marked Anonymous Donor make one "Anonymous" row per year. **The flag wins
  over a Donor link** (my call): a known donor's gift marked anonymous goes on the Anonymous row,
  so the board never prints the name of someone who asked to stay anonymous. A matching gift goes
  to its Matched By company even when the employee is anonymous. Today's importers only check the
  box when there's no Donor (benevity-import `giftSplit.ts`, salesforce-import's placeholder), so
  FY2026 is unaffected.
- **Grouping:** people with the same Household ID are one household. Anyone else is a household
  of one. Each organization is its own row.
- **Name:** a household's Household Greeting (or the person's Name when blank); an
  organization's Recognition Name (or Name).
- **Tier:** $50,000+, $25,000+, $10,000+, $5,000+, $2,500+, $1,000+, $500+, $100+, Under $100.
- **Review Note**, one line per finding:
  - a member has **Do Not Solicit** checked (the old Salesforce report left them out);
  - employer matching with no Matched By company, and how much;
  - two rows share a Household Email (same household?);
  - members' Household Greetings differ.

## 4. The board

**Donor Roll Call**, in the Donors & Contacts workspace (sandbox: the CRM Sandbox v4 workspace).
One group per fiscal year, newest first, titled e.g. "FY2027 (in progress)" and "FY2026". When
the year closes, the title loses "(in progress)".

| Column | Type | Content |
|---|---|---|
| Name | name | the Recognition Name |
| Fiscal Year | text | "2026" (text so it never renders "2,026"; matches Donations' Fiscal Year Ending) |
| Tier | status | the tier label, so views and charts can group by it |
| Type | status | Household, Individual, Organization, Anonymous |
| Listed | status | **Listed**, or **Don't list** when any member (or the organization) has Don't List in Recognition checked |
| Total | numbers ($) | the year's total |
| Gifts | numbers | gift count |
| People | connect → People, People (Historical) | every household member |
| Organization | connect → Organizations | for an Organization row |
| Review Note | long text | §3's notes, blank when there's nothing to check |
| Row Key | text | identity the Worker matches on: `2026|household:<Household ID>`, `2026|item:<itemId>`, `2026|anonymous` |

Rows marked Don't list stay on the board, so the year's totals still add up and Felicia can see
who was left off. The saved views leave them out.

**Saved views** (Total, largest first):
- **This year so far:** the in-progress year, Listed, Under $100 hidden.
- **Last closed year:** the most recently closed year, Listed, $100+. This is the one to export.
- **Needs review:** Review Note isn't empty.

**Item description** on each board item (via `set_item_description_content`, best-effort like
the gift-history projection) can list the counted gifts with deep links. That's a nice-to-have;
leave it out unless it's nearly free.

## 5. How it runs

A new custodian duty, **`rollcall`**, nightly (and `POST /custodian/run/rollcall` on demand),
modeled on the `recurring` duty: a full read each night, only differing cells written, writes
capped per run with `remaining` reported.

1. **Read the ledger:** D1 `gifts` for fiscal years `rollCall.firstFiscalYear` (2026) through
   the current one, not removed, counted per §3. Archived gifts are in the ledger, so closed
   years recompute without touching Donations. A gift that also has a `roll_call_credits` row
   (§6) is credited by that row instead. Each gift counts once.
2. **Refresh `roll_call_credits`** from active Donations items (§6).
3. **Read the donors:** People and People (Historical): Name, Household ID, Household Greeting,
   Household Email, Do Not Solicit, Don't List in Recognition. Organizations: Name, Recognition
   Name, Don't List in Recognition.
4. **Compute** rows per §3 (pure functions, unit-tested, ported from the script's
   `creditFor` / `buildRollCall`).
5. **Diff** against the board's items by Row Key. Create missing rows, update rows whose cells
   differ, and delete rows whose key no longer exists (e.g. two people were joined into one
   household). **Never delete a row of a closed year whose gifts are all archived** unless the
   computation positively produces a different key for them, since a closed year should only
   change when its facts change. Move a row to its year's group when it's in the wrong one. Create a year's group
   when it doesn't exist yet.

Closed years recompute nightly too (my call). A late correction to an FY2026 gift should show
on the board. After the report is printed, a reprint from the board may then differ slightly
from print. The protocol says to keep the exported file with the report.

Up to a day stale is fine: the list is used a few times a year. Webhooks don't trigger it.

**Write switch:** the duty writes through the same `donation-rollups:writes` gate as every
other write in this Worker.

## 6. Data the ledger lacks today

The ledger can't credit three kinds of gift, and the builder check confirmed it from the code:

- **Matched By** isn't stored in D1 `gifts`.
- **Gifts with no Donor never reach the ledger.** Bootstrap skipped them
  (`scripts/bootstrap-gifts-lib.mjs:31`; 17 anonymous gifts). The consumer finds a gift only
  through its Donor link and detaches one with an empty link (`src/consumer/processBatch.ts:209`,
  `217-221`), and `owner_item_id` is NOT NULL. That covers anonymous gifts and, more importantly,
  anonymous employees' **company matches**. benevity-import writes those with Matched By set,
  Anonymous Donor checked and no Donor (`benevity-import/README.md:146-168`), about a third of
  Benevity history.
- **The Anonymous Donor flag** isn't stored either.

**Decision (my call): a side table the duty owns, not a ledger change.** Making `owner_item_id`
nullable touches every owner-keyed query in `src/db/gifts.ts` and the consumer's detach path,
which risks the rollups for a feature that doesn't need them. Instead:

- New migration: `roll_call_credits` (`gift_item_id` PK, `fiscal_year`, `amount_cents`, `status`,
  `gift_type`, `credit` = `item:<companyId>` or `anonymous`, `unmatched_match` flag, `archived_at`,
  `updated_at`).
- Each night the duty pages **active** Donations items and upserts a row for every gift whose
  credit isn't simply its Donor: a Matching Donation with Matched By, anything with Anonymous
  Donor checked, or no Donor at all. When an active gift no longer qualifies, or is deleted, its
  row goes. An employer match with no Matched By and a Donor stays in the ledger and gets
  `unmatched_match` noted from this same pass.
- When a gift archives, its row is **kept, never rewritten**: mark `archived_at` the first night
  the item stops appearing among active items while it still exists. An archived item's connect
  columns read back empty, which is why `gifts.ts:122` / `161-165` already protect acting-for on
  archived gifts. So closed years stay reproducible, Anonymous and donor-less company matches
  included.
- First run: FY2026 and FY2027 gifts are all active today, so the first night fills the table
  for every year the board covers. No separate backfill is needed.

A Matched By or Anonymous edit reaches the board the next night through this pass. No consumer
change is needed.
- **In-kind value.** The script counted In-Kind Value when Amount was blank. The ledger stores
  Amount only. My call: count Amount only. FY2026 has one in-kind gift and it has an Amount.
  Revisit if Felicia finds in-kind donors missing.

## 7. Setup

A script like `setup-annual-summary-board.mjs` (`scripts/setup-roll-call-board.mjs`), idempotent:
- creates the board, its columns and the current year's group;
- adds **Don't List in Recognition** to both People boards and Organizations, and **Recognition
  Name** to Organizations;
- prints the column ids for `config/{svbc,sandbox}.json` (`donationRollups.rollCall`: board id,
  column ids, the People and Organizations column ids it reads, `firstFiscalYear`,
  `excludedGiftTypes`, `writesPerRun`).

Saved views: by API if `create_view` can set the filter and sort; otherwise by hand, listed in
the README's setup steps.

`config.ts` validates the new block. `rollCall: null` turns the duty off, as with
`recurringGifts`.

## 8. Done means

- Sandbox first, then production, in that order. On production, the FY2026 group matches the
  script's FY2026 CSV row for row: same keys, totals to the cent. Any difference is explained.
- A name fix on People (Household Greeting) or a Don't List checkbox shows on the board after
  the next nightly run.
- monday-migration: `protocols/monday/donor-roll-call.md` (and its Box Note, edited by hand)
  says "open the Donor Roll Call board" instead of "ask David", and explains the two new
  columns. `docs/40` points at the board. The script stays as a cross-check until production
  matches, then is deleted.
- README: the duty, the board, the setup steps, the config block.

## 9. Left to the builder

- Read and write batching, slice sizes, and whether one night's run fits a single invocation
  (16k people and about 1,400 rows a year; the account is on Workers Paid).
- How the duty tells "archived" from "deleted" when an item drops out of the active read
  (`items(ids:)` returns archived items with their `state`).
- Group titling and moving rows between groups at the year boundary.
