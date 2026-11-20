# UAT script: the donor portal

**Status 2026-09-30: testable now** at the test address below. The sandbox has been live since
2026-09-22.

Thanks for helping test the new member portal! This is where donors and members will eventually
log in to see their giving history, membership status, and bike-shop discounts. Before it goes
live, we need real people (not just engineers) to click through it and tell us what's confusing,
broken, or missing.

**You cannot break anything by testing this**, and you cannot accidentally contact a real donor.
Read on for why, then jump to [How to test it](#how-to-test-it).

## Is this connected to real donor information?

Two things worth knowing before you start:

- **This is a test copy, not the real thing.** It looks and works exactly like the real portal
  will, but everything it shows you — donation histories, membership records, discounts — is test
  data in a practice version of our records, kept completely separate from anything real.
- **SVBC's actual donor records still live in a different system today (Salesforce)**, not in
  this new one yet. This project is building what will eventually replace it, but that switch
  hasn't happened. So nothing you do here can touch what SVBC is actually using day to day.

## The most important thing: no real person will ever be emailed

While testing, you'll be typing in email addresses — possibly real donors' — to see what they'd
see. **No matter whose email you type in, the actual test email always lands in one shared inbox
that only staff can see** (`sandbox@bikesiliconvalley.org`), never at the real person's address.

This is guaranteed two separate ways at once, so that even if one of them failed, the other would
still catch it. That's a deliberate, tested safety design — not a "please be careful" request. You
can safely use any real donor's email address while testing.

## Test accounts: sign in instantly

For a quick look, or to see what a particular kind of member sees when you're helping one, use
one of these addresses. They sign you straight in, with no email and no waiting, and always show
the same made-up person (every name ends in "(test)"). They never show anything from the test
records, and nothing you submit as one of them is saved.

| Address | Who it shows |
| --- | --- |
| `test-active@example.org` | Active member: card on the home page; gifts with an employer match under Giving, volunteer shifts under Activity |
| `test-renewing@example.org` | Active member whose membership ends in about two weeks: the home page asks them to renew |
| `test-lifetime@example.org` | Lifetime member: no end date on the card, never asked to renew |
| `test-lapsed@example.org` | Lapsed member: membership ended about three months ago; greyed-out card, asked to renew |
| `test-donor@example.org` | Gave but never joined: "Not a member yet" and no membership card |
| `test-household@example.org` | Two people sharing one inbox (one active, one lapsed); Your info shows that address under each |
| `test-spanish@example.org` | Member who joined about three weeks ago and prefers Spanish: the new-member welcome, in Spanish |
| `test-orgrep@example.org` | Member who can also see a business's giving: their own pages plus "You manage: Example Bikes Inc. (test)", with last year's statement |
| `test-orgrep-work@example.org` | The same person's work address: the business's giving and statement only, none of their own pages |

Dates move with today's date, so "ends in about two weeks" stays true. A request to change your
details shows the normal confirmation, but nothing is sent to staff and you can repeat it. These
addresses work only in the test copy, never on the real portal.

## How to test it

To test the real sign-in (the emailed link), use the test records instead:

1. Open a web browser and go to **https://member.sandbox.bikesiliconvalley.org**.
2. Enter an email address from the test list you were given for this round of testing. (If you
   weren't given one, ask whoever asked you to test this — the portal only sends a link for
   addresses that already exist in the test records.)
3. Check the shared test inbox, **`sandbox@bikesiliconvalley.org`**. You'll get an email with a
   subject like `[sandbox → the address you typed] Your SVBC member portal login link` — the
   bracketed part tells you which test address the email is "pretending" to be for.
4. Click the link in that email, then press **Continue to your portal** on the page it opens.
   You'll land on that person's portal home page: a short status line, their membership card,
   and a list of pages to open (see below).
5. **Sign in with the code instead.** Go back to the sign-in page and enter the address again.
   The email now also shows a 6-digit code. In the same browser tab that asked for it, type
   the code into the **Got a code? Enter it here** box and press **Sign in**. You should land
   on the same portal page, with no extra confirmation step. Then try a wrong code: you should
   see "That code didn't work" and the box again. (The code only works in the browser that
   asked for it, and only once; using the link spends the code, and the other way round.)
6. **Sign in with a Household Email.** Ask for a test address that is only listed as someone's
   Household Email (not their own email), if you were given one. You should get the email and
   sign in as for any other address; if several people share that address, the portal shows
   each of them under their own name.
7. If nothing shows up after a minute or two, see [If something seems stuck](#if-something-seems-stuck)
   below before assuming it's broken.

## What to try while you're in there

### The home page

After signing in you land on the home page. It shows one status line with one gold button
(besides Donate), the membership card, then a list of pages ("doors"). What the status line says
depends on the person's record, so try people in different situations if your test list has them:

- **Tax letter season (January 1 to April 15):** someone who gave last year sees their letter
  ("Your 2025 letter is ready", with the number of gifts and the total) and a button to the
  tax letters page. This outranks everything below.
- **Time to renew:** someone whose membership has ended, ends within 30 days, or who has never
  been a member sees a renew (or join) message and a button that opens the giving form. A
  Lifetime member never sees this. An ended membership also greys out the card and shows when it
  ended.
- **New member:** someone whose Member Type is New and whose Member Since date is within the
  last 60 days sees a welcome and a button to their card and discounts.
- **Everyone else:** a plain greeting and their card, with no extra button.
- **A household** (one sign-in covering two or more people) sees everyone's cards, in order,
  and one status line for the most urgent person: for example "Sam's membership ended …".

There should be no tabs anywhere. Each door opens a page that starts with **‹ Home**, which goes
back to the home page.

### The doors

- **Card & discounts:** each person's card with its QR code and a **Get a new code** button,
  then the list of bike-shop discounts.
- **Your giving:** donation history and total, "Your 2025 impact" or "Your 2026 impact" (below),
  and links to manage a recurring gift, renew, see pledges and employer matching gifts.
- **Tax letters:** a list of letter years for each person. Open one to see the letter.
- **Rides, events & volunteering:** event sign-ups, volunteer hours and the Get involved links.
- **Your info & emails:** the form to request a change to your details, your email and mail
  preferences, and **your email addresses**, each with a label in words:
  - **Verified**: you've signed in with it.
  - **Subscribed**: it gets SVBC's email news.
  - **On file**: SVBC has it, but it isn't subscribed.
  - **Bounced**: email to it comes back, so the member should send a new one.

  Which addresses you see depends on how you signed in. Signed in with your own (personal)
  email, you see it and your Household Email. Signed in with a Household Email, you see only
  that address, whether the sign-in covers one person or several: under each person who has it,
  and you **must not** see anyone's own personal email. A household that signed in with one
  person's own email sees only that person's addresses, under that person. Anyone who arrived
  from a "your tax letter is ready" email, one person or a household, sees no addresses, just a
  note to sign in with an email address. If you ever see another person's personal email, or a
  personal email you didn't sign in with, stop and report it.

A page that still uses an old link, such as a bookmark to the change-request page or the
"Add your employer" link in an older letter email, should open the right door. Signing out and
opening a door's link should take you to sign in, then straight back to that door.

### Things to check in detail

- **Look at the donation history** on the giving door: does it look reasonable and readable?
- **Look for "Your 2025 impact" or "Your 2026 impact"** under the donation history. It lists
  what that person's giving helped do that year. It shows only for someone who gave in 2025 or
  2026, and it shows the most recent of those years. The statements say **"[Sample for
  testing]"** because the real ones haven't been written yet. Someone whose last gift was
  before 2025 should see no impact section at all.
- **Look at the membership card and any bike-shop discounts** on the card door: do they display
  clearly?
- **Submit a change** on the info door: try updating an address, email, or phone number and
  confirm you get a confirmation message with a link back to **Your info & emails**. Then open the
  [Donor Portal Change Requests](https://bikesiliconvalley.monday.com/boards/18439574429) board
  in the CRM Sandbox: the request should be there as a new item with the donor, the field, and
  the old and new values. Staff apply changes from that board; the portal never edits a donor's
  record directly.
- **Tell the portal where you work** — on the info door, choose **Employer** (the
  matching-gifts page's "Add your employer" link opens it with Employer already chosen). Try
  three answers, one at a time:
  - the exact name of an organization on
    [Organizations (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342579) (or that
    name with "Inc." or "LLC" added or removed): the person's affiliation to it should become
    **Current** and **Primary**, and their **Employer Name** should update a moment later.
  - a made-up company: nothing changes on the person, and staff get a Change Requests item
    marked **Employer (needs an Organization)**.
  - a different real organization, for a person who already has a Primary employer: the new one
    becomes Primary, and the old one stays **Current** with Primary unticked. The Change Requests
    item says "previous Primary: … (Current)".
  Every answer should appear on the Change Requests board.
- **Check a partner discount end to end** — on
  [Organizations (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342579), set
  **Discount Offered** and tick **Discount Active** on a bike shop, then log in as a current
  member and confirm the discount shows.
- **Open a giving/tax letter** — it's expected to say **"SANDBOX TEST"** prominently on it. That's
  correct, not a bug — it's proof the safety check is working. If a letter does *not* say that,
  stop and report it right away (see below).
- **Try logging in with an email shared by two people in the same household**, if you have one on
  your test list — you should see both people listed separately by name, not merged together.
- **Try an email that isn't in the test records at all** — you should get the same generic
  "check your email" message either way, with no hint about whether it was recognized.

## What's not ready to test yet

These features aren't wired up to test data yet, so you'll see them missing rather than broken —
no need to report these as bugs. (Volunteer history and the employer matching-gift search
*are* wired up: volunteer history shows for anyone with shifts on the Volunteers board, and the
matching-gifts page shows the employer search.)

- Setting communication preferences (opting out of email, text, or mail)
- Your preferred language being remembered automatically
- Event sign-ups/registrations
- Pledge tracking

The giving letter (tax letter) *does* work in this test environment, but it's deliberately shown
with obvious "SANDBOX TEST" placeholder wording everywhere, since SVBC hasn't finalized the real
wording for that letter yet.

To check how it treats different gifts, look at a letter for a person who has, in the same year:

- **A gift with Gift Type `Donor Advised Fund`:** it should appear in its own table below the
  total, and its amount should not be in the total.
- **A gift with Gift Type `Event Ticket`, `Sponsorship`, `In Kind Donation / Sponsorship`,
  `Matching Donation`, `Grants` or `Contracts`:** it should not appear on the letter at all, but
  should still appear in their giving history.

A person with only Donor Advised Fund gifts that year should get a letter with just that table,
and no total. A person with only those other types should have no letter for that year.

## Give a rep portal access

Some people act for an organization (a sponsor, an employer) and should see what that
organization has given. To let someone in:

1. In Monday, open the person's **Current** Affiliation (the one linking them to the
   organization) and tick **Portal access**.
2. They sign in at the portal with their Personal Email, or with that Affiliation's **Work
   Email**. A Work Email opens only that organization, nothing personal.
3. To end access, untick **Portal access** or mark the Affiliation **Former**. It stops on the
   next organization page they open. The organization may still be listed on their home page for
   up to 24 hours, but opening it shows "not found".

In January, each rep also gets an email that a statement for last year is ready. If a rep didn't
get one (for example, you added their Work Email after the system had already skipped them for
having no email), ask an engineer to reset that row; the next daily run will send it.

## Organization reps (sandbox)

Run these in the sandbox, with the test accounts from your list. Ask for a test person with a
Current Affiliation to a test organization, and a test Work Email for it.

1. **Grant.** Tick **Portal access** on that person's Current Affiliation (sandbox Affiliations
   board). Sign in with their Personal Email. You should see the organization on the home page, and
   opening it shows its page and a statement for each year with activity.
2. **Work Email.** Sign in with the Affiliation's Work Email. The home page should list only that
   organization, with no personal giving, card or letters.
3. **Revoke.** Untick **Portal access** (or mark the Affiliation Former), then reload the
   organization page. You should get "not found". The home list may still show it for up to 24 hours.
4. **Statement.** Open the statement for an organization that has a Sponsorship and an employee
   matching gift. Both should be listed, along with its donations, grants, contracts, in-kind gifts
   and event tickets. No employee names should appear, and donation item names should not be shown.
5. **Volunteering.** With fewer than 3 people having volunteered for the organization, the
   volunteering section should be hidden. With 3 or more, it shows as a total only. The line counts people affiliated with the organization today, not
   whoever was affiliated when they volunteered.
6. **January email.** The letter run is skipped entirely under `hold` and `off` (it stops at the
   write switch before reading Monday), so there is nothing to see in a dry run. An engineer sets
   the switch to `on` in the sandbox and triggers the letter run; each rep gets one statement
   email, and sandbox mail only reaches the sandbox sink.

The acknowledgment section of the statement is switched off until the accountant approves its
wording; don't report it missing. The nine non-English translations of the organization pages are
drafts, so wording problems there are expected until a native speaker checks them.

## If something seems stuck

- **No email after a couple of minutes?** Wait about 15 minutes and try again. The system limits
  how many login attempts one email address can make in a short window, as an anti-abuse
  measure — if you hit that limit, it looks identical to a normal "check your email" response,
  with no error shown.
- **Logged in, but the homepage shows the login screen again?** That's expected — the homepage
  always shows the login form, even if you're already logged in elsewhere. It doesn't mean you
  got logged out.
- **Landed on an unexpected language?** That's driven by test-data settings, not anything you
  chose — not a bug worth reporting on its own.

## Sign-off needed: tax-letter wording

The portal's year-end giving letters double as IRS donation acknowledgments, so they stay
switched off until SVBC approves the exact wording. That is gated in code, not just a process
step. **Raised 2026-08-24; owner: Executive Director plus SVBC's accountant.** Sign off directly
in this document: check each box and add your initials and the date beside it. All six are
needed before letters go live. Four are already drafted and just need review as written; two are
genuinely blank and need real input.

**Already drafted, review and approve as written or send back changes:**

- [ ] **Identity block**: legal name "Silicon Valley Bicycle Coalition", EIN 77-0338658, office
      address "95 S Market St, Suite 648, San José, CA 95113", mailing address "PO Box 1927, San
      José, CA 95109", signed by "Clarrissa Cabansagan", "Executive Director".
- [ ] **Standard statement** (non-member donors): *"No goods or services were provided in
      exchange for these contributions."*
- [ ] **Donor-advised fund gifts.** These are listed below the total, in their own table, without
      the statement above, under this wording: *"Gifts from a donor-advised fund, listed for your
      records only. They are not counted as contributions in this letter."* A donor whose only
      gifts that year came through a fund gets a letter with just this table. Approve the wording
      and that these gifts are listed at all.
- [ ] **Gifts left off the letter.** Event Ticket, Sponsorship, In Kind Donation / Sponsorship,
      Matching Donation, Grants and Contracts don't appear, and a donor with only those gets no
      letter for that year. Confirm this, including for event tickets, which may instead need a
      statement of what the ticket's value was, and for in-kind gifts, which may need their own
      acknowledgment. An employer's matching gift no longer appears on the employee's letter, and
      this feature sends the company no letter for it.

**Still blank, need real answers:**

- [ ] **Member-benefits variant.** Members receive real benefits (bike-shop discounts), so their
      letter must either state those benefits were insubstantial or disclose their estimated
      fair-market value. Which applies is an accountant's question, not a technical one. Write
      the exact sentence to use once decided.
- [ ] **Covered tiers.** Which membership tiers get the member-benefits statement instead of the
      plain one. Monday has two tier values today, **Member** and **Lifetime**; decide whether
      both get it (both have the same bike-shop discount access today) or just one.

Donors won't see any letters until all six boxes are checked, the approved wording is entered
into the portal's configuration (`member-portal/config/svbc.json`, the `taxLetter` block), and
the portal is redeployed. Once that lands, "resend my tax receipt" requests become "log into the
portal."

## Reporting what you find

For anything that looks wrong (other than the known gaps above), note down:

1. What you did (which page, which button, which email address)
2. What you expected to happen
3. What actually happened — include a screenshot if you can
4. The date/time, so it's easier to find in logs

Report it on SVBC's [IT Requests board](https://bikesiliconvalley.monday.com/boards/8846215481)
on Monday.com, or send it to whoever asked you to test this round.

---

*For engineers: deployment steps, technical architecture, and local-development instructions live
in [`member-portal/DEPLOY.md`](../../member-portal/DEPLOY.md),
[`member-portal/README.md`](../../member-portal/README.md), and the `run-member-portal` skill,
not in this guide.*
