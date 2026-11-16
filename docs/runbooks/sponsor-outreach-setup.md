# Sponsor Outreach: one-time setup

Prepares Monday for the Sponsor Outreach board
([design](../superpowers/specs/2026-11-09-sponsor-outreach-board-design.md),
[plan](../superpowers/plans/2026-11-09-sponsor-outreach-setup.md)). It covers these steps:

1. Add four columns.
2. Link Martha's Sponsorships board to Organizations.
3. Mark sponsor prospects.
4. Mark sponsor contacts.
5. Check the event-name table.
6. Produce the review lists Martha checks before the board itself is built.

Everything runs from the repo root with David's own Monday token, never a Worker's.

## Ground rules

* **Dry run by default.** Each command reports what it would do and changes nothing. Add `--apply`
  to write. Re-running is safe:
  * a link or tick already in place is left alone
  * nothing is ever unticked
  * each `--apply` records the ids it wrote in `applied-<command>.json`, beside `--out`. A later
    `--apply` never writes those ids again, so a tick or link Martha removes by hand stays removed.
    Keep these files with the review files, and don't delete them.
  * `prospects` fills an empty Prospect Notes on a company that's already ticked, so re-running
    with a better export carries Martha's notes over. It warns when every Notes cell in the input
    is blank.
* **Review files live under `data/`.** They hold names and emails, and the script refuses to write
  them anywhere else. `data/` is gitignored, so never commit or email them. They go to Martha's
  restricted Box folder.
* **The console shows counts and ids only.**
* **Exit codes:**
  * 0: nothing left to do or review.
  * 1: there are review rows, or a check failed. Read the review file.
  * 2: usage or Monday error. The Monday message is withheld, because it can echo a value.
* **History comes from the Gift Ledger.** Most Donations items are archived in place, and
  `items_page` never returns those. The script reads sponsorship history from each Organization's
  🔒 Gift Ledger (JSON), plus `items(ids:)`. Links from archived items read empty.

```sh
export MONDAY_API_TOKEN=...   # David's token
B="--organizations 18437909779 --affiliations 18437909787 --people 18437909781 \
   --historical 18437909784 --donations 18437909794 --sponsorships 18391037433"
D=data/sponsor-outreach
```

Pass only the flags each command takes, as listed below.

## Inputs

| File | How to make it |
|---|---|
| `$D/sheet/<tab>.csv` | Each tab of "2027 Sponsor List": File → Download → Comma-separated values. One file per tab, named after the tab. **Use Download, not a gviz/export URL.** The gviz export dropped every Notes cell. |
| `$D/sf-primary-contacts.csv` | `sf data query -o svbc --result-format csv -q "SELECT npsp__Primary_Contact__c, AccountId FROM Opportunity WHERE RecordType.Name='Sponsorship' AND StageName IN ('Pledged','Posted') AND npsp__Primary_Contact__c != null"` |
| `$D/sf-fundraise-opt-out.csv` | `sf data query -o svbc --result-format csv -q "SELECT Id FROM Contact WHERE Fundraise_Opt_Out__c = true AND Id IN (SELECT npsp__Primary_Contact__c FROM Opportunity WHERE RecordType.Name='Sponsorship')"` |

## Order

### 1. `columns`

```sh
node scripts/sponsor-outreach-setup.mjs columns --organizations 18437909779 \
  --affiliations 18437909787 --sponsorships 18391037433 [--apply]
```

This creates four columns, staff-editable, none marked 🔒:
* **Sponsor Prospect** (checkbox) and **Prospect Notes** (text) on Organizations
* **Sponsor Contact** (checkbox) on Affiliations
* **Organization** (connect → Organizations) on Sponsorships

If a title already exists with the wrong type, it creates nothing and exits 1.

### 2. `cycles`: check the event-name table

```sh
node scripts/sponsor-outreach-setup.mjs cycles --organizations 18437909779 \
  --donations 18437909794 --sponsorships 18391037433 --out $D/cycles.csv
```

Read-only. It lists every event name found in Sponsorship Cycle values on ledgered sponsorship
gifts, with the Sponsorships Event label it maps to through
[`sponsor-outreach/config/event-names.json`](../../sponsor-outreach/config/event-names.json).
Combined values are split, for example "2016 Dinner / 2017 BTWD" or a `;` multi-select. It exits 1
while any name is unmapped.

**For Martha** (`cycles.csv`, with the JSON). These mappings were my calls:
* Dinner → Annual Gala
* Advocacy Summit → Bike Summit
* Fundraising Ride → Bike to the Future Ride
* Combined (2012–13), Jersey and Winter Party → Miscellaneous

On 2026-11-09, 315 of 3,937 sponsorship gifts had no year in Sponsorship Cycle. They count toward
no event.

### 3. `link-pipeline`

```sh
node scripts/sponsor-outreach-setup.mjs link-pipeline --organizations 18437909779 \
  --sponsorships 18391037433 --out $D/link-pipeline-review.csv [--apply]
```

It links each Sponsorships item to one Organization:
* It matches on the item name first, then on its Employer text.
* Names are compared after ignoring case, punctuation, a leading "The" and endings like Inc or LLC.
* Nothing is fuzzy-matched.
* An item already linked is left alone.

**Review file:** one row per item that didn't match exactly once.
* `unmatched`: link it by hand, or create the Organization.
* `ambiguous`: two Organizations share the name, and the candidates are listed. That's probably a
  duplicate Organization to merge.

Run this before `contacts`, which uses these links to place the board's contact emails.

### 4. `prospects`

```sh
node scripts/sponsor-outreach-setup.mjs prospects --organizations 18437909779 \
  --input "$D/sheet/Prospects.csv" --out $D/prospects-review.csv [--apply]
```

It ticks Sponsor Prospect for each company on the Prospects tab, and copies the tab's notes into
Prospect Notes where those are empty.

**Review file:** rows Martha marked "Remove", which are not ticked, plus unmatched and ambiguous
companies.

### 5. `contacts`

```sh
node scripts/sponsor-outreach-setup.mjs contacts --organizations 18437909779 \
  --affiliations 18437909787 --people 18437909781 --historical 18437909784 \
  --sponsorships 18391037433 --dir $D --out $D/contacts-review.csv [--apply]
```

It ticks Sponsor Contact on **Current** affiliations found from three sources:
* Salesforce sponsorship primary contacts, matched by 📜 Salesforce ID on the person and the
  Organization.
* Every email column on the sheet tabs. Headers are matched in any case. Each tab prints a line
  with its address count, or "skipped, no email column". A missing `sheet/` directory stops the
  run.
* The Sponsorships board's Email column.

An email matches an affiliation's Work Email first. Failing that, it matches a People email, but
only at the company the row names.

**Review reasons:**

| Reason | Meaning |
|---|---|
| `no person` | Nobody in Monday has that Salesforce ID or address |
| `no organization` | The row's company didn't match an Organization, or the Sponsorships item isn't linked yet |
| `former only` | The only affiliation found is Former |
| `no current affiliation` | The person has no affiliation at that company |
| `several people share this email` | Two or more People share the address, or it's the Work Email on more than one person's Current affiliation (such as `info@`), so it's never ticked twice |

It also writes **`fundraise-opt-out.csv`**: the sponsor contacts Salesforce marked Fundraise Opt
Out, which weren't migrated. Each row has its People item and whether Do Not Solicit is already
set. **The script never sets Do Not Solicit.** Martha decides each one.

On 2026-11-09 the dry run, without the sheet tabs and before link-pipeline had been applied,
found:
* 141 affiliations to tick
* 862 review rows, 731 of them "no organization" from the unlinked board
* 14 Fundraise Opt Out contacts, none with Do Not Solicit

## Hand-off

1. With David's go-ahead, apply in this order: `columns`, `link-pipeline`, `prospects`, `contacts`.
2. Re-run each as a dry run. Each should report 0 to write.
3. Put the review files and `cycles.csv` in Martha's restricted Box folder, along with the
   decisions she needs to make:
   * the event table
   * the unmatched companies
   * the unresolved contacts
   * which Fundraise Opt Out contacts get Do Not Solicit
4. Her answers feed the second plan: the board, the Worker and the send page. That plan also waits
   on the `mailchimp-sync` Work Email Consent work.
