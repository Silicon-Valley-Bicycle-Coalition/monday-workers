# benevity-import

**Status:** Requirements only (drafted 2026-09-08). Not built.
**Priority:** Post-migration, non-blocking — staff can keep hand-entering matching gifts on the
Donations board in the meantime, exactly as they do in Salesforce today. Two small
`salesforce-import` changes it depends on (see Related changes) *are* pre-cutover.
**Owner:** Unassigned.
**Stack:** Hono + TypeScript + D1 + Cloudflare Queues (the shared stack, see `../README.md`).

## The ask

Employer matching gifts reach SVBC through [Benevity](https://benevity.com/nonprofits), the
workplace-giving platform most of its large local employers use (Google, Apple, Netflix, Applied
Materials, Microsoft, NVIDIA, Expedia, Varian, Intuitive). Benevity pays SVBC in periodic
disbursements and, for each one, publishes a report listing every donation and match it contains.
Today a staff member downloads that report and types each row into the CRM by hand — about 30 rows
a month, 3,020 since 2013, each named `<Company> - Employer Matching <Donor> <date>`. Nothing
stores Benevity's transaction id, so a row entered twice is invisible; and the CRM's one "donor"
link holds either the employee or the company, never both.

**There is no better feed than the CSV.** Benevity's [developer API](https://developer.benevity.org/)
serves corporate clients embedding giving into their own apps and has no endpoint for a cause to
pull the donations it received. Reports are downloads from the
[Causes Portal](https://causeshelp.benevity.org/hc/en-us/articles/115003003423-Where-do-I-find-my-reports)
(the [redesigned portal](https://causeshelp.benevity.org/hc/en-us/articles/47976276289684-New-Introducing-the-New-Causes-Portal-Experience)
can bundle many disbursements into one file). So this Worker's job is not to replace the download
— it is to replace the hand-keying: take the file, dedupe it, link each gift to the paying
**Organization** and, where Benevity disclosed one, to the employee **Person**, and put anything it
can't resolve on a worklist instead of guessing.

## Data flow

```
Benevity Causes Portal
  │  staff download the disbursement report (CSV), roughly monthly
  ▼
Monday "Benevity Uploads" board — staff drop the file in a file column          (see Trigger)
  │  Monday webhook on item create/file change
  ▼
Cloudflare Worker (webhook handler)
  │  1. fetch the asset via Monday's GraphQL API, parse rows, validate the header
  │  2. upsert each row into D1 `rows` keyed on Benevity Transaction ID
  │     (a re-upload of an overlapping file is a no-op for rows already written)
  │  3. enqueue one Cloudflare Queue message per row not yet written
  ▼
Cloudflare Queue → consumer Worker, per row
  │  1. resolve the paying company → Organizations item (exact name, then config aliases)
  │  2. resolve the employee → People item (email, then name + employer) or "anonymous"
  │  3. split the row: employee gift (if any) and company match (if any) → two Donations items
  │  4. write to Monday; stamp each item with the Transaction ID before marking the row done
  │  unresolved company or ambiguous person → write nothing, add a worklist item, mark
  │  the row `needs-review`; retries + DLQ on API failure as in every webhook Worker here
  ▼
Donations board (+ Matched By → Organizations, Donor → People)
Worklist: a group on the Benevity Uploads board, one item per row needing a human
```

Ingestion, resolution, and the Monday write are separate, independently testable steps, same
shape as `funraise-sync`. The D1 row status only advances to `written` after Monday confirms the
item exists with its Transaction ID set, so a crash between "create item" and "record success"
is caught on retry by the pre-create lookup (search Donations for the Transaction ID before
creating), never by a duplicate.

### Trigger

**Recommended: a file column on a small staff-facing "Benevity Uploads" board**, one item per
uploaded report, with a Monday webhook on the file column. Staff already live in Monday, the
board's own permissions gate who can upload, and the worklist lives on the same board next to the
upload that produced it. The Worker fetches the file through Monday's `assets` query (time-limited
`public_url`) — no separate login surface to build or secure.

Alternative if the asset fetch proves awkward: a Cloudflare-Access-protected upload page on the
Worker itself. Same parsing and downstream steps; only the first hop changes.

Not in scope: polling Benevity. Whether Benevity can email the report as an attachment or deliver
it by SFTP is an open question for their support team; if either exists, an inbound-email or
SFTP-pull front end can replace the manual drop later without touching the rest.

## Input format

The Benevity disbursement ("Donation") report is a CSV with a preamble block (charity name,
disbursement id, period, totals) above the column header row, then one row per donation or match.
**The column set below is from Benevity's current report as understood at drafting time — verify
it against a real export before building, and keep the header-to-field mapping in
`config/svbc.json` so a renamed column is a config change, not a code change.** Columns this
Worker cares about:

| Benevity column | Used for |
|---|---|
| Company | Organization resolution (paying company; may be a foundation name) |
| Donor First Name, Donor Last Name | Person resolution fallback; item name |
| Email | Person resolution, primary key when disclosed |
| Address / City / State / Postal Code | Not written to Monday (see PII); may inform a worklist proposal |
| Donation Date | Donations `Date` (not the disbursement date) |
| Transaction ID | Idempotency key → `Benevity Transaction ID` column |
| Donation Frequency | One-time vs recurring payroll giving — informational, written to item description |
| Currency | Must be USD; anything else goes to the worklist |
| Total Donation to be Acknowledged | Employee gift amount (gross) |
| Match Amount | Company match amount (gross) |
| Cause Support Fee, Merchant Fee | Not written to the CRM (finance/QuickBooks concern) |
| Comment / Reason / Source / Activity / Project | Written to the item's Updates or description if non-empty; never parsed |

**Anonymous rows.** Donors choose what to share; withheld fields read "Not shared by donor" (or
blank). Treat any of those in the name or email columns as *no person*: the row still produces its
Donations items, with Anonymous Donor checked and no Donor link. Roughly a third of SVBC's history
is like this and always will be. Some companies also elect to appear under an alias — that's still
the Company string, resolved through the alias table like any other.

## Splitting a row into gifts

A row can carry an employee donation, a company match, or both. Each non-zero amount becomes its
own Donations item:

| | Employee gift | Company match |
|---|---|---|
| Created when | `Total Donation to be Acknowledged` > 0 | `Match Amount` > 0 |
| Name | `<Donor> - Donation <date> (Benevity)` | `<Company> - Employer Matching <Donor or Anonymous> <date>` |
| Amount | employee amount, gross | match amount, gross |
| Date | Donation Date | Donation Date |
| Gift Type | `Donation` | `Matching Donation` |
| Status | `Received` | `Received` |
| Donor (connect → People) | the Person, if resolved | the Person, if resolved (the employee the match is credited to) |
| Matched By (connect → Organizations) | blank | the Organization |
| Anonymous Donor | checked if no Person | checked if no Person |
| Benevity Transaction ID | `<Transaction ID>` | `<Transaction ID>-match` |
| Fiscal Year Ending | computed from Date, SVBC's July–June year, same rule as `salesforce-import` | same |

`Gift Type` and `Status` labels must be exactly these strings: `donation-rollups` counts only
`Received`, and the Matching funding stream in the revenue dashboard is `Gift Type = Matching
Donation`. Do not set Thank You Sent — Benevity, not SVBC, receipts the donor for tax purposes;
whether SVBC sends its own stewardship thank-you is a staff decision made from the board, and the
`Amount ≥ $200 → Acknowledgment Tier: Major` automation applies to these items like any other.

## Resolution

### Company → Organizations item

1. Exact, case-insensitive match on the Organizations item name.
2. `config/svbc.json` alias table, e.g. `"Google, LLC": "Google"`, `"Applied Materials
   Foundation": "Applied Materials Foundation"` (kept distinct from `Applied Materials` — the CRM
   has both as separate payers, as it does `VMware` / `VMware Foundation`).
3. Otherwise: worklist. **Never auto-create an Organization.** Staff either pick the existing item
   (the Worker then learns the alias by appending it to a D1 `aliases` table read alongside the
   config) or create the Organization and re-run the row.

### Employee → People item

Only attempted when the row discloses a name or email.

1. **Email**, exact after normalization, against every address the CRM knows for a person: People
   `Personal Email` and `Household Email`, and `Work Email` on the Affiliations board (the
   person↔organization model decided 2026-09-08). One hit → resolved. Several hits (a shared
   household address) → worklist, listing all candidates.
2. **Name + employer**: exact first-and-last name against People where the person's Employer text
   or an Affiliation links to the resolved Organization. Exactly one → resolved. Otherwise →
   worklist with the candidates. Of last year's matched gifts with a known donor, the CRM's email
   for the donor was a personal address about twice as often as a work one, and Benevity may hand
   over either, so this fallback fires regularly.
3. **Never auto-create a Person from a name.** Same rule as the Eventbrite name-match proposal:
   propose, staff confirm. A worklist item carries the row's disclosed fields (name, email,
   company, amount, date) so staff can attach it to an existing Person or create one and re-run.

Resolving a person does **not** write the employer onto their People item or create an
Affiliation — that's `impact-attribution`'s job (or a human's), and a single match is weak evidence
of current employment (foundation payers, retirees' programs, spouse matches all exist).

## Idempotency and the migrated history

* D1 `rows` (Transaction ID, upload id, status: `ingested` / `written` / `needs-review` /
  `skipped`, Monday item ids, raw row) is the ledger. `uploads` records each file (Monday asset id,
  disbursement id from the preamble, row count, outcome counts).
* Every Donations item this Worker creates carries `Benevity Transaction ID`; the consumer looks
  it up before creating, so a retry after a lost status update adopts the existing item.
* **The migrated history has no Transaction IDs** — Salesforce never stored them — so the ledger
  can't tell a pre-cutover Benevity row from one the import already carried. Config
  `benevityImport.minDonationDate` (set to the migration data-freeze date) makes the Worker skip
  older rows as `skipped`, with a count in the upload summary. The first real upload must be the
  first disbursement after the freeze; do not backfill through this Worker.
* Rows with `Currency ≠ USD`, negative amounts (refund/clawback lines, if Benevity ever emits
  them), or a header that fails validation → `needs-review`, never silently dropped.

## PII

Benevity rows include the donor's postal address when shared. Do **not** write it to Monday from
here (People addresses come from the import and the donor portal), and purge `raw_row` from D1 on
the same retention schedule `funraise-sync` uses (`rawRowRetentionDays`, default 90, for written
rows; `unresolvedRowRetentionDays`, default 365, for the rest). The worklist item shows name,
email, company, amount, and date only.

## Monday targets

All ids in `config/svbc.json`, validated at startup, none hardcoded:

| Board / column | Purpose |
|---|---|
| Donations board | writes |
| Donations: Donor (connect → People), Matched By (connect → Organizations), Amount, Date, Fiscal Year Ending, Status, Gift Type, Anonymous Donor, Benevity Transaction ID | columns written |
| People board: Personal Email, Household Email, Employer | person resolution |
| Affiliations board: Person, Organization, Work Email | person resolution |
| Organizations board: name | company resolution |
| Benevity Uploads board: file column, worklist group | trigger + worklist |

Token: a dedicated staff-facing integration user with access to exactly these boards (see the
least-privilege note in `../README.md`); the same user `funraise-sync` writes as is acceptable,
never a staff member's personal token.

## Related changes elsewhere

* **`salesforce-import`, before cutover — built 2026-09-08 on `feat/si-benevity-columns`:** add
  `Matched By` and `Benevity Transaction ID` to the Donations board definition; fill `Matched By`
  from `AccountId` whenever `RecordType.Name = 'Matching Donation'` (today the Donor link takes the
  Primary Contact and the paying company is dropped for the 2,182 matched gifts that have one);
  map Opportunities whose Primary Contact is the placeholder Contact "Anonymous Person" to
  Anonymous Donor = checked with **no** Donor link instead of linking a Person by that name (235
  gifts). That branch also fixes `Employer Name` on People, which read the empty 360MatchPro
  lookup instead of `Employer__c` — the name-plus-employer fallback above depends on it.
* **`donation-rollups`:** decide whether a `Matching Donation` linked to a Person counts toward
  that person's Lifetime Giving. Salesforce's rollups counted it (the employee was Primary
  Contact), so the import's validated totals include matches; keep that unless staff want a
  separate "Matched giving" figure. Organizational Giving under the affiliation model should
  count `Matched By` items for the company.
* **Staff process guide (`docs/06`, private repo):** the Donations section gains "Benevity
  disbursements: drop the report on the Benevity Uploads board; work the review group" once this
  ships.

## Open questions

1. **Report delivery.** Ask Benevity support whether disbursement reports can be emailed as
   attachments or pulled by SFTP. Either removes the manual download; neither is required.
2. **Exact column names and preamble shape** of the current report — confirm against a real
   export before writing the parser; put the mapping in config.
3. **Gross vs net.** The CRM records the gross gift (what the donor gave and is acknowledged
   for); fees are finance's concern in QuickBooks. Confirm that matches how finance reconciles
   Benevity deposits today, so the CRM and the books agree on the same number per gift.
4. **Who is the Donor on a match** — this README says the employee (matches Salesforce, keeps
   rollups stable), with the company in Matched By. If staff would rather see the company as the
   Donor and the employee as a secondary link, that's a config-level swap, but decide before the
   import fills the column.

## Sources

* Plan section: Benevity (Integrations) — `migration-plan.md` (private planning repo), with the
  live Salesforce counts behind the numbers above (queried 2026-09-08).
* [Benevity for Nonprofits](https://benevity.com/nonprofits)
* [Benevity API documentation](https://developer.benevity.org/) — corporate-client API, no cause-side endpoints
* [Where do I find my reports? — Benevity Causes help](https://causeshelp.benevity.org/hc/en-us/articles/115003003423-Where-do-I-find-my-reports)
* [Understanding donor reports — Benevity Causes help](https://causeshelp.benevity.org/hc/en-us/articles/360056082831-Understanding-donor-reports)
* [How can I find the donor and company information on my report? — Benevity Causes help](https://causeshelp.benevity.org/hc/en-us/articles/360056954871-How-can-I-find-the-donor-and-company-information-on-my-report)
* [New Causes Portal experience — Benevity Causes help](https://causeshelp.benevity.org/hc/en-us/articles/47976276289684-New-Introducing-the-New-Causes-Portal-Experience)
* `../funraise-sync/README.md` — the webhook → D1 → Queue shape and donor-matching conventions this Worker reuses
