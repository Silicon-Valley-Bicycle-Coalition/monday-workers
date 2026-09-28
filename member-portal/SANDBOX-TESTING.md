# Testing the member portal — a guide for staff testers

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
- **Look at the membership status and any bike-shop discounts** — do they display clearly?
- **Open the digital membership card** — does it show and look right?
- **Submit a change** — try updating an address, email, or phone number through the portal and
  confirm you get a confirmation message.
- **Open a giving/tax letter** — it's expected to say **"SANDBOX TEST"** prominently on it. That's
  correct, not a bug — it's proof the safety check is working. If a letter does *not* say that,
  stop and report it right away (see below).
- **Try logging in with an email shared by two people in the same household**, if you have one on
  your test list — you should see both people listed separately by name, not merged together.
- **Try an email that isn't in the test records at all** — you should get the same generic
  "check your email" message either way, with no hint about whether it was recognized.

## What's not ready to test yet

These features aren't wired up to test data yet, so you'll see them missing rather than broken —
no need to report these as bugs:

- Setting communication preferences (opting out of email, text, or mail)
- Your preferred language being remembered automatically
- Volunteer history
- Event sign-ups/registrations
- Pledge tracking
- The "find your employer's matching-gift program" search tool

The giving letter (tax letter) *does* work in this test environment, but it's deliberately shown
with obvious "SANDBOX TEST" placeholder wording everywhere, since SVBC hasn't finalized the real
wording for that letter yet.

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
in [`DEPLOY.md`](DEPLOY.md) and the `run-member-portal` skill, not in this guide.*
