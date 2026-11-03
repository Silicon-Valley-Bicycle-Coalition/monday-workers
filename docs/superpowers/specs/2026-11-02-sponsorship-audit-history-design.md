# Sponsorship audit history on Organizations — design

Date: 2026-11-02. Status: draft for approval.

## Why

When a company that sponsored SVBC is audited, its auditors ask SVBC to confirm what the company
paid. Staff answer by email. Today the multi-year answer lives in a Google Sheet outside Monday
(the Salesforce sponsor-history export, `monday-migration` `docs/35` §3.2), and staff find that
awkward: they want everything in one app. Day to day they work only the current year's group on
the sponsorship pipeline boards; history matters for audits and reporting, which reach back seven
years.

The paid sponsorships are already in Monday as Donations gifts (Gift Type `Sponsorship`), but two
things stop Monday answering "what did Acme pay us, 2020–2026?":

1. **Gifts older than the previous fiscal year are archived** on Donations (`docs/20`), so views,
   filters and dashboards can't see them. The one place that still shows full history is the
   **Gift History** table `donation-rollups` writes into each owner item's description
   (`src/projections/giftHistory.ts`), and it has no event column, no totals, and nothing shaped
   for an email.

## What gets built

Staff answer an audit request by opening the company on **Organizations**, copying a
**Sponsorships** section from its card, and pasting it into their email reply.

### 1. Check that historical sponsorships belong to their company (read-only)

Checked 2026-11-02 against the production load artifacts
(`monday-migration/backup/salesforce-import-data-2026-10-31/transform/payloads.ndjson`): of 865
`Sponsorship` gifts with Status `Received`, **848 have the organization as Donor** (391 through
Acting for, 457 because the Opportunity had no Primary Contact and `giftDonorSfId` fell back to the
Account). 17 have a person as Donor, and none of their Accounts is on Organizations. 851 of the 865
carry a Sponsorship Cycle.

So no bulk correction is needed. (The user approved automatic attribution on 2026-11-02 on the
mistaken belief that most sponsorships were person-owned; with nothing to move, that approval
stands only for the case below.)

- Re-run the same count against live D1 (`gifts.owner_item_id`, `owner_board_id`, `gift_type`)
  after go-live to confirm nothing drifted.
- List the 17 person-owned sponsorships (item id, year, amount; no names in logs) for staff to
  check by hand. If staff find the company exists on Organizations under another record, attribute
  them the way an attributed org gift is (Donor = org, Acting for set) and recompute both owners.

### 2. Store the event and in-kind value on each gift

- New nullable D1 columns `gifts.sponsorship_event` (text) and `gifts.in_kind_value_cents`
  (integer). NULL means "not read yet", following the `term_start` precedent (migration 0009 and
  the membership custodian's `backfill-terms` phase).
- New optional Donations column ids in config (`sponsorshipCycle`, `inKindValue`, next to the
  optional term columns in `src/config.ts`), read by `getDonationsByIds` and written by
  `refreshFacts` with the same COALESCE rule as `gift_type`.
- **Event, decided: automatic.** Where the event comes from, in order:
  1. The gift's **Sponsorship Cycle** text, when set (Salesforce imports: 851 of 865 paid
     `Sponsorship` gifts have it).
  2. Otherwise the **sponsorship pipeline item the gift is connected to**. Each of the five
     pipeline boards has a two-way **Donations** connect (`monday-migration` `docs/29`), so the
     Donations item carries the reverse link. The label is the board's configured event name plus
     the item's group title, which is the year (for example `BTWD 2026`). Gifts entered after go-live
     depend on this, and they're the years auditors will ask about next.
  3. Otherwise blank, shown as `—`.
  Store the resolved label, and re-resolve when the gift changes (a later pipeline link should
  replace a blank). Reading the reverse link only works on active items (`docs/20` fact 3), which
  is fine: by the time a gift is archived its event has been stored.
- Backfill: a custodian phase that reads both values by item id for gifts with NULL, archived
  ones included (scalar values stay readable by id), in bounded batches with a cursor. Blank in
  Monday is stored as empty string / 0 so it isn't re-read.
- Only sponsorship and in-kind gifts need the values; reading them for every gift is fine if
  simpler.

### 3. The Sponsorships section

Rendered by `donation-rollups` into the same description write as Gift History, placed **above**
the existing `## Gift History` section, **on Organizations items only** (my call: the in-kind Gift
Type also covers individuals' in-kind donations, and audits are of companies), for an organization
with at least one qualifying gift in the window. No qualifying gifts: no section.

- Qualifying gift: status equal to `receivedStatusLabel` (`Received`), not removed, and Gift Type
  in either configured list:
  - cash sponsorship types (SVBC: `Sponsorship`), valued at Amount;
  - in-kind types (SVBC: `In Kind Donation / Sponsorship`, decided: included), valued at In-Kind
    Value, falling back to Amount when In-Kind Value is blank (119 received in-kind gifts have only
    Amount) — my call.
  Pledges, pending, failed and `Received (Historical)` are out.
- In-kind rows are marked: the Amount cell reads `$1,200.00 (in-kind)`.
- Totals per year and overall show cash and in-kind separately (`$7,500.00 cash · $1,200.00
  in-kind`) — my call, since auditors confirming payments care about cash.
- Window: the configured number of years ending with the current year, current year included
  (seven years: this year plus the six before).
- Year: calendar or fiscal, from config. Fiscal uses the existing `fiscalYear.startMonth` and
  labels years the way the rest of the repo does (`FY26` for July 2025–June 2026).
- Layout, newest year first:

  ```markdown
  ## Sponsorships

  | Year | Date | Event | Amount |
  | --- | --- | --- | --- |
  | 2026 | [2026-04-12](…) | 2026 BTWD | $5,000.00 |
  | 2026 | [2026-01-30](…) | 2026 Summit | $2,500.00 |
  | **2026 total** | | | **$7,500.00** |
  | 2025 | … | … | … |
  | **Total, 2020–2026** | | | **$31,000.00** |

  _Paid and in-kind sponsorships, last 7 calendar years. Maintained automatically by donation-rollups — edits here are overwritten._
  ```

  Date links to the gift, like Gift History. Event is the stored cycle; blank shows `—`. A year
  with no sponsorships gets no rows.
- Must paste cleanly into Gmail as a table. Verify by hand on the sandbox before production.
- The description's size budget is shared with Gift History; the section is small (tens of rows
  at most), but the existing truncation behaviour must not cut it off.

### 4. Config

A new `donationRollups.sponsorships` block, alongside `membership`, `donorLevel` and `rollCall`,
in `config/svbc.json` and `config/sandbox.json`, validated at startup:

- `giftTypes`: cash sponsorship labels. SVBC: `["Sponsorship"]`.
- `inKindGiftTypes`: in-kind labels. SVBC: `["In Kind Donation / Sponsorship"]`.
- `pipelineBoards`: the sponsorship pipeline boards and each one's event name, e.g.
  `{ "18391037433": "BTWD", "18390869107": "Advocacy Summit", "18390883634": "Fundraising Ride",
  "18391037577": "Misc.", "18423176514": "Annual Gala" }` (production ids; sandbox has its own or
  none), plus the Donations-side reverse connect column id.
- `yearBasis`: `"calendar"` or `"fiscal"`. SVBC: `"calendar"` (the people asking are sponsors'
  auditors) — my call; switch to `"fiscal"` if SVBC prefers.
- `windowYears`: SVBC `7`.

Absent block: no section rendered, no behaviour change (keeps forks unaffected).

### 5. Production readiness

- Confirm the **Item description** widget is on the production Organizations item view (UI only;
  `donation-rollups` README). Without it the description write fails silently and nothing shows.
- After deploy, backfill and the attribution correction: run the custodian sweep
  (`POST /custodian/run/sweep`, repeated until done) so every owner's description is rewritten.
- Spot-check three companies with long sponsorship histories against the sponsor history sheet.

### 6. Staff guidance

- Add a "Answering a sponsor's audit request" part to the Box Note *Reporting on Grants and
  Sponsorships in Monday* (`monday-migration` `protocols/monday/reporting-grants-and-sponsorships.md`,
  then the note by hand) and point the five pipeline board descriptions' "earlier years" line at
  the company card instead of the sheet. The sheet stays as the complete archive (it also holds
  the lost pitches).
- New sponsorship gifts must be entered with the company as Donor and connected to their pipeline
  item (that link is where the event comes from). Check the donor data entry, entering payments
  and sponsorship protocols say so; fix the wording if not.

## Goals

- Seven years of a company's paid and in-kind sponsorships, with event and yearly totals, visible on its
  Organizations card and copyable into an email.
- Confirm every historical sponsorship is owned by the company it came from (it nearly all is).

## Non-goals

- Lost pitches, prospects and withdrawn sponsorships (they stay in the sheet).
- Grants, individual gifts, memberships.
- Pipeline-board history groups, a new board, or a dashboard.
- Emailing auditors automatically.

## Anti-goals

- Moving money between owners in a way that breaks rollups (Lifetime vs Organizational Giving)
  or double-counts a gift.
- A section that silently omits sponsorships (for example, archived ones) — an incomplete answer
  to an auditor is worse than none.
- Hardcoding SVBC values in source.

## Constraints

- Repo conventions in `CLAUDE.md`: config not hardcoding, byte-identical `graphql.ts` and
  `flags.ts` copies, write switch, sandbox env and split test, log safety (no email addresses in
  logs), `npm run typecheck`.
## Left to the builder

- Refreshing the section when the calendar or fiscal year rolls over (the window moves even if no
  gift changes).
- Whether the cycle is read for all gifts or sponsorships only.
- Markdown details beyond the shape above.
