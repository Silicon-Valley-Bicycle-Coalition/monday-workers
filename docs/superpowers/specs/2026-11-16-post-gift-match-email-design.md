# Post-gift matching-gift email — Design

**Status:** Draft design, pre-implementation (2026-11-16). Not approved; see "Decision this
replaces" and "Open questions".
**Worker:** `dtd-sync/` (a new `prompt` job, alongside `push`). No new Worker.

## Why

Donors who give outside Funraise (Eventbrite ticket orders and gifts staff enter by hand) get no
matching-gift prompt. Double the Donation (DTD) prompts only for gifts it knows about. Funraise sends
online gifts straight to DTD, and Salesforce used to send the rest until that feed stopped on
2026-10-23. `dtd-sync` was built to take over that feed (see its README), but its `push` and
`pull` jobs call DTD's custom API. SVBC's Standard plan doesn't include that API.

DTD has quoted an API add-on (2026-11-13, a yearly fee on top of the current subscription; the
figure is in the private planning repo). This design is the alternative: `dtd-sync` writes and
sends the prompt itself, for those same non-Funraise gifts, and no DTD API is called.

What DTD gives SVBC that this doesn't: a database of every US employer's matching rules, and its
own email sequence and reminders. What SVBC already has instead:

- **The employers that actually match SVBC gifts.** `benevity-import` writes a Matching Donation
  for every Benevity match, with the paying company in its **Matched By** column (connect →
  Organizations). Salesforce-era matches carry the company in the gift name
  (`<Company> - Employer Matching <Donor> <date>`). The 3,020 matches since 2013 name a short list of large local employers (Google, Apple, Netflix, Applied
  Materials, Microsoft, NVIDIA, Expedia, Varian, Intuitive and a few more).
- **Each donor's employer.** People → Employer (text), loaded from Salesforce's `Employer__c`
  (about 10,000 contacts), and updated by staff.
- **A way to tell if prompting works.** `dtd-sync`'s pairing job links each Matching Donation to
  the gift it matched, with no DTD key.

## Decision this replaces

The choice is between:

1. **Pay for DTD's API add-on** and deploy `dtd-sync` as built (push and pull). DTD sends its own
   emails; Monday gets DTD's match status and employer.
2. **This design.** No added fee. `dtd-sync` sends one email per eligible gift; no DTD status
   flows into Monday for non-Funraise gifts.
3. **Neither.** Non-Funraise donors stay unprompted; Benevity matches still arrive on their own.

Option 2 and option 1 aren't exclusive later: if the API is bought, `prompt` is switched off and
`push` switched on (one config flag, below).

## Goals

1. Every gift that `dtd-sync`'s push rules would send to DTD instead gets **one** email from SVBC,
   2–30 days after the gift, saying whether the donor's employer matches and how to request it.
2. A donor whose employer is a known matcher gets that employer's steps. A donor with no employer
   on file is asked "Where do you work?" (#127). A donor whose employer is on file but not a known
   matcher gets a short "many employers match; here's how to check" version, or nothing (open
   question 1).
3. Staff can see on the Donations item that a prompt went out, and when.
4. The Program Summary board shows prompted → matched for these gifts, per fiscal year.

## Non-goals

- Prompting for Funraise gifts. DTD keeps doing that under the current subscription.
- A follow-up or reminder sequence. One email per gift.
- An employer database beyond SVBC's own matchers. No lookup of employers SVBC has never seen.
- Writing back to DTD, or pulling DTD status. `pull` stays off without the API.

## Anti-goals

- Two prompts for one gift: one from DTD (via Funraise) and one from this job.
- Prompting a Do Not Solicit donor, an anonymous donor, or a gift that is itself a match,
  sponsorship, grant, contract or membership.
- An email that implies a match amount the employer won't honour (an Eventbrite order's full
  ticket price, say).
- A donor's email address in a log line.

## Design

### Where it runs

A new job, `prompt`, in `dtd-sync`'s hourly cron, after `pairing`. A config switch picks the mode:

```jsonc
"outreach": {
  "mode": "email",          // "email" → prompt runs, push and pull never run
                            // "dtd"   → push and pull run (needs DTD_PRIVATE_KEY), prompt never runs
  ...
}
```

`pairing` and `summary` run in both modes.

### Which gifts

Exactly `pushDecision()` in `src/mapping/eligibility.ts` (gift type, not Funraise, not Benevity,
not anonymous, Received, amount > 0, in the 30-day window, donor is a Person with an email,
sandbox allow-list), plus these rules for the email:

| Rule | Why |
|---|---|
| Gift date at least `outreach.delayDays` (2) old | A thank-you or receipt goes out first. |
| Donor's People → Do Not Solicit is unchecked | Same rule as fundraising sends in `mailchimp-sync`. |
| No prompt to this donor in the last `outreach.donorCooldownDays` (90) | Monthly Eventbrite regulars aren't emailed monthly. |
| Gift not already paired to a Matching Donation | The match already happened. |
| Gift Type `Event Ticket` excluded in v1 | The amount is the full order, not a matchable donation (open question 4). |

The send rule is a pure function beside `pushDecision()`, returning the same `{ send, reason }`
shape so dry runs log why each gift was skipped.

### Matching employers

A config list in `config/*.json` for v1, staff-editable on a board later if it changes often:

```jsonc
"matchingEmployers": [
  {
    "name": "Google",
    "aliases": ["Google LLC", "Google, LLC", "Alphabet"],
    "platform": "Benevity",
    "requestUrl": "https://...",         // the company's own giving portal, if public; else null
    "steps": "benevity-off-platform",    // which steps template to use
    "deadlineNote": "by the end of the following calendar year"
  }
]
```

The seed comes from a script (`scripts/seed-matching-employers.mjs`) that lists the Matched By
Organizations (or, for Salesforce-era items, the company parsed from the name) on Matching
Donations in the last three fiscal years with their gift counts. Staff review it, and
someone fills in the URLs and deadlines by hand. The script prints; it writes nothing to config.

A donor's Employer is compared after normalising both sides (lower case, strip punctuation and
`inc`/`llc`/`corp`), against `name` and every alias. Only an exact match after normalising counts.
That gives three cases: **known matcher**; **no employer on file** (People → Employer Name blank);
and **not a known matcher** (an Employer that matches no entry).

### The email

Sent through Cloudflare Email Sending from `mail.bikesiliconvalley.org`, set up as in
`member-portal` (`send_email` binding `EMAIL`; in sandbox, `allowed_destination_addresses`
holds `sandbox@bikesiliconvalley.org` only, and `config/split.test.ts` keeps the sinks apart).
Layout and colours come from `docs/design-system/tokens.json`. The HTML shell is adapted from
`member-portal/src/email/layout.ts`, as a copy in `dtd-sync`. Plain-text part included.

Known employer:

> **Subject:** Your gift to SVBC could go twice as far
>
> Hi {first name},
>
> Thank you for your ${amount} gift on {date}. **{Employer} matches employee donations**, so
> one form could double it.
>
> 1. Sign in to {Employer}'s giving portal and choose to request a match for a donation made
>    elsewhere.
> 2. Search for **Silicon Valley Bicycle Coalition** (EIN {ein}).
> 3. Enter ${amount}, dated {date}, and attach this email or your receipt.
>
> {Employer} accepts requests {deadline note}.
>
> [Request your match →]

No employer on file (decided by #127: ask instead of skipping): the middle becomes "Many Bay Area
employers match their employees' gifts. Where do you work? Tell us, and we'll let you know if
yours matches," with a link to the member portal's Employer field,
`{portalBaseUrl}/{locale}/portal/change-request?field=employer` (the portal's
`employerAnswerEnabled` must be on; the donor signs in first). The answer reaches the CRM through
`member-portal-writer`: an exact Organization match becomes the donor's Current, Primary
affiliation, and anything else goes to staff on the Change Requests board (spec
`2026-11-16-donor-employer-answer-design.md`). The next gift's prompt then has an employer to
work with.

Not a known matcher (if sent at all; open question 1): the middle becomes "Many Bay Area
employers match their employees' gifts. Ask HR, or search your company's giving portal for
Silicon Valley Bicycle Coalition," with a link to the member portal's matching-gifts page.

Footer: SVBC's address, why they got it ("you gave to SVBC on {date}"), and a link to stop
matching-gift emails (open question 2).

Wording, EIN and from-address are config strings shipped as `REPLACE_AFTER_SIGNOFF`, like the
member portal's tax letter. The config validator rejects them, so nothing sends until they're
signed off.

### Order of writes

Same guard pattern as `push`:

1. Insert a D1 row in a new `prompts` table (`monday_item_id` primary key, `donor_item_id`,
   `variant` known/ask/unknown, `state` pending/sent/failed, `attempts`, `sent_at`). An existing row
   means skip.
2. Send the email.
3. Mark the row `sent`, then write the Donations item: **Match Status** → `Prompted` (a new
   label) and a new **Match Prompt Sent** date column. **Sent to DTD** is left alone: it keeps
   meaning "DTD has this gift", so a later switch to `dtd` mode still pushes these gifts. The new
   column goes on `MARKED_COLUMNS` (🔒) and is hidden on the staff gift-entry form.

A send that fails stays `failed` and is retried on the next run, up to 3 attempts. A Monday write
that fails after a send leaves the D1 row as the guard; the next run repairs the column. The
donor cooldown reads D1 (`donor_item_id`, `sent_at`), not Monday.

### Write switch

The same `dtd-sync:writes` key every Worker reads:

- `off`: compute and log each decision (`dtd-sync: prompt item <id> would-send known|unknown` or
  `skip <reason>`), send nothing, write no D1 row. A gift skipped under `off` that's still in the
  window is considered again after a flip to `on`.
- `hold` / `unknown`: skip the job.
- `on`: send.

### Measuring it

`summary` adds three numbers per fiscal year to the Matching Gift Program board: gifts
prompted, prompted gifts later paired to a Matching Donation, and matched dollars from them.
Compare against the same numbers for Funraise gifts (DTD-prompted) to see if a short email
from SVBC does about as well as DTD's sequence.

## Testing

- Unit: the send rule (every skip reason), employer normalising and matching, every email
  body (snapshot, plain text and HTML), including the ask variant's Employer-field link, D1
  ledger states, write switch.
- Config split test: sandbox and production share no `send_email` destination and no board id.
- Sandbox: allow-list one staff address, enter a hand gift for a People item with Employer
  "Google", run with writes `off`, then `on`, and confirm one email arrives and the second run
  sends nothing.

## Open questions

1. **An employer on file that isn't a known matcher: send or skip?** *(Narrowed 2026-11-16.)* A
   blank employer is no longer open: #127 decided those donors get the "Where do you work?"
   version. For an employer SVBC hasn't seen match, sending reaches donors whose employer may
   match anyway, and skipping keeps the email rare and always specific. Recommendation: skip in
   v1, measure, revisit.
2. **Opt-out.** Do Not Solicit is honoured either way. Should the email also carry its own
   unsubscribe link (which would need a route and a People column)? Recommendation: link to
   reply-to-unsubscribe for v1, and have staff tick Do Not Solicit.
3. **Sign-off.** Wording, the EIN line and the from-address need the development team's approval.
4. **Event Tickets.** eventbrite-sync writes the full order amount, which includes the ticket's
   fair-market value. Prompting needs the donation portion; until Donations carries it, tickets
   are excluded.
5. **Employer list upkeep.** Config for v1 means a deploy per change. If staff edit it more than
   a few times a year, move it to a small Monday board.
