# Privacy policy review: wealth screening and the donor portal

Issue #81, following item 6 of the [2026-10-28 workers review](2026-10-28-workers-review.md).
This compares the published policy with what the systems in this repo do. It isn't a legal
opinion, and the draft wording below needs the policy owner's review, and counsel's if SVBC wants
it.

**Reviewed:** `SVBC Privacy Policy.pdf` in Box (Protocols › Administrative protocols › Information
Technology › Tech Admin), last changed 2025-09-15. The website footer and the portal footer
(`member-portal/src/views.ts:35`) both link to this one file.

**Policy owner:** not named in the policy. The likely owner is the Deputy Director, who uploaded
and owns the Box file, with the Executive Director as the other candidate. The Donor Privacy Policy
sends questions to the Development Team. This needs confirming with them.

## Summary

The issue's two gaps are real, but the larger problem is that two promises in the policy no longer
match practice: third-party disclosure and need-to-know access. Adding a wealth-screening paragraph
alone would leave those two statements standing.

| # | Finding | Type | Fix |
|---|---|---|---|
| 1 | Purchased wealth data isn't disclosed | Missing | Policy text |
| 2 | Sensitive life-event flags are held on donors | Practice decision | Decide first, then policy text |
| 3 | "We do not otherwise disclose… to any third parties" omits service providers | Inaccurate | Policy text |
| 4 | "Those employees who need to know" is wider in practice | Inaccurate | Narrow access or change text |
| 5 | The donor portal isn't covered | Missing | Policy text |
| 6 | The advertising statement may not be true | To confirm | Confirm, then keep or cut |
| 7 | The policy says nothing on access, correction, or retention | Missing | Policy text, if a process exists |
| 8 | No effective date, and the file depends on one staff account | Housekeeping | Add a date, move the file |

## Findings

### 1. Purchased wealth data isn't disclosed

The Donor Privacy Policy says SVBC collects information "you share with us or that is available from
public sources". Its examples are all things a person gives SVBC directly. Windfall data is neither:
it's a vendor's modelled estimate, including net worth with low and high bounds, job and employer
details, and giving indicators. "Public sources" wouldn't lead a reader to expect that.

- 14,131 Salesforce Contacts carry a Windfall ID, and 6,585 of them were on People boards in the
  dry run (`salesforce-import/README.md`). The Windfall subscription has ended, so the data is frozen.
- The Monday `recent-gifts-wealth` digest emails Net Worth, Philanthropic Giver, Job Title and
  company for recent donors to staff (`report-digests/README.md`). Recipients are limited to the
  `bikesiliconvalley.org` domain.
- Sending names to a screening vendor is itself a disclosure (see finding 3). That SVBC sent records
  to Windfall is inferred from the integration; confirm what was sent with the staff who ran it.

### 2. Sensitive life-event flags are held on donors

`salesforce-import/src/transform/windfall.ts:31` copies these flags into each person's Windfall
Profile when true, among others: **Recently Divorced**, **Recent Death in Family**, Recent Mortgage,
Recent Mover, Recently Retired, Multi-property Owner and Trust Association. Political party and
donor fields were deliberately not migrated to Monday, but they remain in the retained Salesforce
org and its backups.

A policy update has to describe this honestly, and "we hold a flag that a death occurred in your
family" is a hard sentence to publish. **Recommendation:** decide whether to keep these flags before
writing the disclosure. Dropping the divorce and death flags from Monday would be simpler than
explaining them, and they're frozen and ageing anyway. The same question applies to the political
fields in Salesforce.

### 3. "We do not otherwise disclose" omits service providers

The policy says "we do not otherwise disclose your personal information to any third parties" and
"We will not trade, share or sell" except in listed cases. Those cases cover fundholders, Regional
Affiliates, legal requests, and fraud checks, but not the vendors that process donor data. Repo
evidence: Monday.com (system of record), Cloudflare (Workers, D1, email), Mailchimp, Funraise,
Eventbrite, QuickBooks, Benevity, Google (geocoding, Places, and backups), the US Census geocoder,
and Windfall.

SVBC not selling data can stay as it is. The fix is an added exception for service providers acting
on SVBC's behalf.

### 4. "Those employees who need to know" is wider in practice

The policy says SVBC "restricts access to personal information to those employees who need to know".
The access model documented in the migration plan is that CRM members can edit every CRM board and
other staff can view them, and the Windfall columns sit on the People boards. Production donor boards
were made private in the Monday UI (`README.md`, "Making the production donor boards private"), which
keeps out non-staff, but it doesn't limit access by role among staff.

Column permissions on the Windfall columns, or moving them to a restricted board, would make the
sentence true. Otherwise the text needs softening to something like "staff who need it for their work".

### 5. The donor portal isn't covered

The portal, `member.bikesiliconvalley.org`, has no production deploy recorded yet, so this can be
fixed before launch. The general statement covers "the Silicon Valley Bicycle Coalition website" and
mentions cookies, but only for statistics and advertising. Nothing describes:

| What | Detail | Source |
|---|---|---|
| Login emails | A one-time link, valid 15 minutes, sent by Cloudflare Email; letter links last 7 days | `member-portal/config/svbc.json` |
| `session` cookie | Essential, HttpOnly, 24 hours, server-side session in D1 | `member-portal/src/routes.ts:421` |
| `lang` cookie | Language preference, 1 year, readable by page scripts | `member-portal/src/routes.ts:249` |
| Login attempts | SHA-256 of the address, deleted after 24 hours, including for non-donors | `member-portal/README.md` |
| Change requests | Queued in D1, then applied to Monday, purged by a daily job | `member-portal/README.md` |
| Membership card | QR token stored in plaintext; active tokens aren't expired | `member-portal/README.md` |

The portal's own code sets no analytics or advertising cookies. The exception to check is the
matching-gifts page, which loads a third-party script from Double the Donation
(`member-portal/src/matchingGifts/matchingGiftViews.ts:26`), and production config has a key set for
it. That page renders no donor data, but the script can see the visitor's IP address and may set its
own cookies. A browser check of the widget is still pending, and should record what it sets before
the wording below is finalized.

### 6. The advertising statement may not be true

The Site Usage section says data is used "to deliver customized content and advertising to you when
your use of the internet indicates that you are interested in a particular subject area". Nothing in
this repo does that, but the website isn't in this repo. Confirm with whoever runs the site and
marketing tags, then keep or cut it. The same section's "analyze demographic information" needs the
same check.

### 7. Nothing on access, correction, or retention

The policy offers no way to see, correct, or remove information, and doesn't say how long it's kept.
This matters more now that the Salesforce org and its screening data are being retained after
cutover, and that Contacts with Windfall data who aren't on People survive only in extracts and
backups. Only promise what staff can actually do: removing someone's data means Monday, Salesforce,
and the backups, so the process should be agreed first.

### 8. Housekeeping

- The policy has no effective or last-updated date. "Will occasionally update" gives readers no way
  to tell whether it has changed.
- The public link points at a file owned by one staff account in a Tech Admin folder. If that account
  is removed or the file is re-shared, both footers break. A page on the website would be sturdier.
- The portal's policy URL is hardcoded in `views.ts`, while this repo's convention is to keep
  SVBC-specific values in `config/*.json`. Moving it would make a policy move, or a fork, a config
  change.

## Draft wording

Everything here depends on the decisions above; bracketed text marks what isn't settled.

**Add to Personal Information (Donor Privacy Policy):**

> We also hold information about some donors and prospective donors that we obtained from a
> commercial wealth-screening provider, including estimated net worth, employment details, and
> indicators of charitable giving [and property ownership]. These figures are estimates and may be
> wrong. We no longer buy this data, and what we hold has not been updated since [month year]. We use
> it only to plan our fundraising, and our staff can see it in our donor records and in internal
> reports. To ask about or remove information we hold about you, email svbc@bikesiliconvalley.org.

**Replace the third-party sentence in Use and Disclosure:**

> We don't sell or trade your personal information. We share it with service providers who work on our
> behalf, such as our donor database, email, payment, event registration, accounting, and hosting
> providers, and they may use it only to provide those services to us. Otherwise, we disclose it only
> as described in this policy or at the time we request it.

**Add a Member Portal section:**

> If you sign in to our member portal, we use your email address to look up your record and send a
> one-time sign-in link. We use two cookies: `session`, which keeps you signed in for up to 24 hours
> and is required to use the portal, and `lang`, which remembers your language for up to a year. We
> don't set advertising or analytics cookies. Our matching-gift search is provided by Double the
> Donation, which receives your search and [may set its own cookies, per the browser check]. We keep
> a scrambled record of each sign-in request for 24 hours to prevent abuse. Changes you request
> through the portal are recorded and applied to your donor record.

Add an effective date at the top.

## Open items for the owner

- [ ] Confirm who owns the policy
- [ ] Decide whether to keep the divorce, death, and other sensitive flags (finding 2), and the political fields retained in Salesforce
- [ ] Decide who should see Windfall data (finding 4)
- [ ] Confirm what was sent to Windfall and when the data was last synced
- [ ] Check the advertising and demographics statements against the website (finding 6)
- [ ] Agree a process for access and removal requests (finding 7)
- [ ] Record what the Double the Donation widget sets, from the pending browser check (finding 5)
- [ ] Publish the update before the portal's production deploy
