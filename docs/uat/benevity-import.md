# UAT script: Benevity import

**Status 2026-09-30: blocked.** The sandbox copy still writes gifts to the `(sandbox v2)`
Donations board and looks up companies on the v2 Organizations board, both deleted on
2026-09-20. An upload today fails rather than creating anything. The fix is tracked separately;
read this now and come back once it lands.

## What it does

Benevity (the workplace-giving platform Apple, Google, and others use) sends SVBC a disbursement
report each period: employee gifts plus the employer's matching gifts. Today someone keys each
row into Salesforce by hand. Here, you drop the report file on a board and the gifts create
themselves: one **Donation** item for the employee's gift and one **Matching Donation** item for
the company's match, linked to the right People and Organizations items. Anything it can't match
with confidence becomes a row on a worklist for a person to resolve, rather than a wrong guess.

It only writes to Monday.

## Try it (once the remap lands)

1. Open
   [Benevity Uploads (sandbox v2)](https://bikesiliconvalley.monday.com/boards/18431270204).
   Create a new item named for the report (for example "Benevity Sep 2026") and attach the
   report CSV to its **Report** file column. Use a real report if you have one; only rows with a
   Donation Date of **2026-09-16 or later** are taken, older rows are skipped.
2. Within a few seconds, on
   [Donations (sandbox v3)](https://bikesiliconvalley.monday.com/boards/18431577310), look for
   pairs of new items: `<Donor> - Donation <date> (Benevity)` with Gift Type Donation, and
   `<Company> - Employer Matching …` with Gift Type Matching Donation and **Matched By** set to the
   company's Organizations item. Both carry Status Received, Fiscal Year Ending, the Benevity
   Transaction ID, and **Anonymous Donor** checked where the employee withheld their name.
3. Back on the Uploads board, rows the import couldn't place appear as items in the worklist
   group with a **Reason**: no matching person or company, a currency other than USD, or a
   report whose totals don't add up. Read the reasons: are they clear enough to act on?
4. Upload the same file again. Nothing new should appear; rows already imported are recognised by
   their transaction ID.
5. Open the donor on People. Their totals reflect the gift (see
   [donation rollups](donation-rollups.md)), and by next morning the gift's Funding Stream reads
   **Matching Donations** for the match and **Individual Giving** for the employee's gift.

## Don't report these

- **Thank You Sent** is deliberately left unchecked on Benevity gifts; Benevity's own receipt is
  not SVBC's acknowledgment.
- Benevity's comment, cause, and project text isn't carried onto the item.
- A company name that matches under a different spelling isn't learned for next time; each upload
  matches afresh.

## Not testable yet

- The worklist **Retry** flow (fix a row, tick Retry, watch it import) isn't switched on in the
  sandbox.
- Everything above until the v2 board remap lands.

---

*Engineers: [`benevity-import/README.md`](../../benevity-import/README.md) has the report
format, the matching rules, and the two `salesforce-import` column changes needed before
cutover.*
