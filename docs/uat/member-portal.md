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

## How to test it

1. Open a web browser and go to **https://member.sandbox.bikesiliconvalley.org**.
2. Enter an email address from the test list you were given for this round of testing. (If you
   weren't given one, ask whoever asked you to test this — the portal only sends a link for
   addresses that already exist in the test records.)
3. Check the shared test inbox, **`sandbox@bikesiliconvalley.org`**. You'll get an email with a
   subject like `[sandbox → the address you typed] Your SVBC member portal login link` — the
   bracketed part tells you which test address the email is "pretending" to be for.
4. Click the link in that email, then press **Continue to your portal** on the page it opens.
   You'll land on that person's test portal page, seeing their donation history, membership
   status, and discounts.
5. If nothing shows up after a minute or two, see [If something seems stuck](#if-something-seems-stuck)
   below before assuming it's broken.

## What to try while you're in there

- **Log in** and confirm you land on a page with donation history, membership status, and
  discounts — not an error or a blank page.
- **Look at the donation history** — does it look reasonable and readable?
- **Look for "Your 2025 impact" or "Your 2026 impact"** above the donation history. It lists
  what that person's giving helped do that year. It shows only for someone who gave in 2025 or
  2026, and it shows the most recent of those years. The statements say **"[Sample for
  testing]"** because the real ones haven't been written yet. Someone whose last gift was
  before 2025 should see no impact section at all.
- **Look at the membership status and any bike-shop discounts** — do they display clearly?
- **Open the digital membership card** — does it show and look right?
- **Submit a change** — try updating an address, email, or phone number through the portal and
  confirm you get a confirmation message. Then open the
  [Donor Portal Change Requests](https://bikesiliconvalley.monday.com/boards/18439574429) board
  in the CRM Sandbox: the request should be there as a new item with the donor, the field, and
  the old and new values. Staff apply changes from that board; the portal never edits a donor's
  record directly.
- **Tell the portal where you work** — on the change-request page, choose **Employer** (the
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
    item says "previous Primary: …, still Current".
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
