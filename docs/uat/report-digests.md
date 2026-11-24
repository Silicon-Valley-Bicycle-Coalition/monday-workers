# UAT script: Scheduled report emails (report digests)

**Status 2026-11-24: the board views are testable now; the emails wait on one check.** The sandbox
copy builds all five emails correctly. Its sends bounced at the shared
`sandbox@bikesiliconvalley.org` inbox on 2026-10-26, but that inbox took a test email on 2026-11-24.
Until a digest has arrived there too, try step 1 below and skip step 2.

## What it does

In Salesforce, some of you got report emails on a schedule: unmatched Funraise gifts, renewals
coming up, recent gifts of $400 and up, this fiscal year by gift size, and
last week's donations. Those subscriptions stop being useful at cutover, because Salesforce's
numbers freeze. This integration replaces them with five emails built from the Monday boards:

| Email | When (Pacific) | Goes to | Replaces |
|---|---|---|---|
| **Gifts with no donor** | Mondays 1 pm, **only if there are any** | Felicia | Funraise Opps with no Account |
| **Renewals this month and next** | 1st and 15th, 9 am | Felicia | Renewals for Current and Next Month |
| **Recent gifts of $400 and up** | Mondays 8 am | Clarrissa | $400+ Donations + Windfall Last 60 Days (without the Windfall columns) |
| **This fiscal year by gift size** | Mondays 8 am | Clarrissa, Deanna | Current FY Opps (no contacts) |
| **Last week's gifts** | Mondays 8 am | Felicia | Donations Made in the Last Week |

Each email lists what the matching board view shows and links to that view, so the email and
the view always agree:

| Email | Board view it links to |
|---|---|
| Gifts with no donor | Donations › **Needs a donor** |
| Renewals this month and next | People › **Renewals this month and next** |
| Recent gifts of $400 and up | Donations › **Gifts, last 60 days** |
| This fiscal year by gift size | Donations › **By gift size** |
| Last week's gifts | Donations › **Gifts, last 7 days** |

It only reads Monday; it never changes a board.

In the sandbox every email goes to the shared `sandbox@bikesiliconvalley.org` inbox, whoever it
is addressed to, with the intended recipient noted in it.

## Try it

1. **The views first.** On
   [Donations (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342657) and
   [People (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342592), open each
   view in the second table above. Is it the list you'd want each week? Is anything you relied on
   in the Salesforce report missing (a column, a filter)?
2. **The emails.** After a scheduled send (or ask for one on IT Requests, naming the email),
   open it in the sandbox inbox. For the email you used to get from Salesforce:
   - Does it have what you used to look for? Compare it with the last Salesforce copy you got.
   - The subject line carries the count (and the total, where there is one). Does it look right
     against the linked view?
   - Does the link open the right view?
3. **Recent gifts of $400 and up** (Clarrissa): each gift row should show the donor's Lifetime
   Giving and Donor Level, and no wealth-screening columns. Is the $400 floor the one you want?
4. **Renewals** (Felicia): it covers Member Until dates from the 1st of this month to the end of
   next month, so someone who lapsed earlier this month is still on it. Is that the window you
   want?
5. **Gifts with no donor:** on a Monday with nothing to list, no email should come at all.

## Don't report these

- **Long lists stop at 150 rows** with a link to the view for the rest.
- **A pledge dated in the future isn't listed yet.** Each date window ends today.
- **Missed sends aren't caught up.** If an email didn't come because the system was paused, ask
  for a resend on IT Requests rather than waiting for the next one.
- **The recipients are a decision, not a bug.** If someone else should get an email, or you
  shouldn't, say so on IT Requests as a Feature Request.

---

*Engineers: [`report-digests/README.md`](../../report-digests/README.md) has the schedules, the
recipient domain guard, the write switch, and the operator route
(`POST /digests/run?key=<key>`) for sending one digest on request.*
