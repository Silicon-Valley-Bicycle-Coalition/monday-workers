# Stewardship emails in monday CRM Sequences

The two welcome emails and three renewal reminders, sent by monday CRM Sequences from People.
`mailchimp-sync` sets the 🔒 **Stewardship Email** label each morning, and a Monday automation per
label enrolls the person in the Sequence of the same name. Which label goes to whom and when:
`mailchimp-sync/README.md`, "Stewardship emails (Monday Sequences)".

Copy: Felicia's Google Doc "2026 Donor Stewardship Email Sequences" (approved 2026-11-19). The emails
as built are `docs/email-branding/stewardship/*.html`, written by `scripts/build-stewardship-emails.mjs`.
Photos: Felicia's 2026-11-19 email (below), cropped and hosted; the files aren't in this repo.

## Done

- [x] 🔒 Stewardship Email status column, labels at ids 0–4 (nothing at id 5):
  - Production People `18437909781`: `color_mm98qe1j`
  - Production People (Historical) `18437909784`: `color_mm9dtn3c`, added 2026-11-24 so people can move
    between the boards (`people-reclassification`)
  - Sandbox People `18437342592`: `color_mm98np52` (config filled)
- [x] Worker code, sandbox run on 2026-11-19: it read all 7,684 sandbox people and planned 63 labels. 62 were
      held (none of those addresses are in the 2-member sandbox audience) and one renewal label was cleared
      on a test item (`13594488756`).

## 1. Prerequisites (staff)

- [x] **`membership@bikesiliconvalley.org` is a mailbox, connected in Monday** (2026-11-24). Every
      stewardship email is sent from `membership@` (Felicia, 2026-11-19), and Martha is the person who
      manages that inbox (Deanna, 2026-11-19). Sequences only send from a connected mailbox: a Google
      Group can't be connected, and a Gmail "Send mail as" alias isn't offered in **Send emails as**.
      How it was converted:
      1. Google Admin: the group's address became `membership-team@` (in Group information; "Rename
         group" changes only the display name). Google keeps the old address as an alias of the group,
         so mail keeps arriving until that alias is deleted. Delete it right before adding the user.
      2. The user `membership@` ("SVBC Membership") in the **Staff** OU.
      3. Monday → Emails & Activities → settings → **New connection** → Gmail, from a staff member's own
         login, choosing `membership@` at Google's prompt. Signing in to Monday *as* `membership@` only
         makes a Viewer login, which connects nothing. Google's prompt must open as a pop-up.
- [ ] **Share the mailbox.** In those settings, give Martha **Read & Write** on `membership@`. In Gmail,
      delegate it to Martha, and to Felicia as backup (delegating to a group is off, so add people one
      by one). Under **Sender information**, choose **Show this address only**. Check that outside mail
      to `membership@` arrives.
- [ ] **Martha works replies in Monday.** A reply to a Sequence email lands in `membership@` and is
      logged on the person's People timeline, so the queue of replies needing an answer lives in
      Monday.
- [x] **People board can take a Sequence.** Checked 2026-11-19: the "Connect a board" picker offers
      production People (Donors & Contacts, `18201685`) and sandbox People.
- [x] Welcome #2 stays (Felicia, 2026-11-19).
- [x] Donor Perks are discounts at retailers with a $0 value (David, 2026-11-24), so the renewal emails
      wait on no deductibility answer. Receipts for event tickets are a separate question.
- [x] **🔒 Email Preferences on production People** (2026-11-20): `link_mm99tvcv`, with 🔒 Mailchimp
      Profile `link_mm99hxpv`, both marked read-only; `profileLinks` turned on in
      `mailchimp-sync/config/svbc.json`. The hourly run fills them over the first day (500 writes a
      run). Sandbox: `link_mm99ntk0`.

## 2. Five Sequences

Built on production People on 2026-11-24, all inactive. Ids: `Welcome: day after`
`516ca255-174a-4ff4-8755-3fc586a51c16`, `Welcome: 3 weeks` `60b6b24d-5950-44fc-a6e5-748584b6b14e`,
`Renewal: 3 weeks before` `216deab4-e0b2-423a-958b-d50d1c6d6a9e`, `Renewal: 1 week before`
`987f243f-20f8-41ce-bc11-057fc10636b0`, `Renewal: day of` `0aea0374-9e61-4e7b-978c-6ac60819312b`.

How the editor behaves, for the next edit or rebuild:

- The monday MCP's `create-sequence` makes the Sequence, its subject and its body (bold, links and
  lists survive). It leaves the **time zone blank** and **removal on reply, bounce and auto-reply off**,
  and drops paragraph spacing: sent paragraphs have no margin. A blank time zone is read as **UTC**, so
  set Pacific or nothing sends in SVBC's afternoon.
- **The `<>` HTML editor** replaces the whole email. It opens empty the first time and with the saved HTML
  after that. It strips `<head>` and `<style>` (so no dark mode) and turns off the column picker, but a typed
  `{pulse.<column id>}` still merges. An image must be hosted: there is no upload.
- **The unsubscribe link** works in HTML as `<a class="crm-composer-unsubscribe-link-anchor-element" href="#"
  data-unsubscribe="true" data-read-only-link="true">`, with any text; Monday fills in the address when it
  sends. The insert menu doesn't recognise it and still offers **Add unsubscribe link**: don't add a second.
- **Outside the send window** an enrollment waits for the next one. **Deactivating a Sequence ends the runs
  still waiting**, so deactivate only once they show completed. Change the window under Rules &
  notifications, and put it back.
- **Email tracking** is a tick box on each email step, off in all five. The links in a delivered email
  still go through `trackingservice.monday.com` (checked in a received message's source, 2026-11-24);
  the UTM tags are inside, so the redirect should still carry them. No mailbox setting turns it off.
- **Last Gift Amount** prints without a dollar sign, so the copy has `$` before it. **Member Until**
  prints like "August 12th 2023".
- Monday's unsubscribe link carries a token that expires 30 days after sending.

One per label, **named exactly like the label**, connected to People with **Personal Email** as the
recipient. Each is **a single automatic email sent on enrollment**: no waits, no follow-up steps.
The Worker does the timing.

| Sequence / label | Doc section | Photo |
|---|---|---|
| `Welcome: day after` | Email #1, New Donor | `cmpgn_2_what_we_do` |
| `Welcome: 3 weeks` | Email #2, New Donor | `cmpgn_2_what_we_do` |
| `Renewal: 3 weeks before` | Renewal Email #3 (3 weeks before) | `cmpgn_1_kids_safety_a` |
| `Renewal: 1 week before` | Renewal Email #2 (one week before) | `cmpgn_1_kids_safety_e` |
| `Renewal: day of` | Renewal Email #1 (day of) | `cmpgn_3_bike_lanes_b` |

Felicia named the kids-safety and bike-lanes photos for the renewals but didn't say which goes
where. The table is a suggestion she can change, and which kids photo went to which of the first two
renewals was a guess. The photos come from events where people signed waivers (David, 2026-11-24).

Since 2026-11-24 the emails are HTML in the `docs/design-system` email layout: black header, photo, gold
band, white card, centered footer. The photos' own gold panels (with a second logo) are cropped off and
their words are text in the band. The crops are only 548–616 px wide; larger originals would look sharper.
They are served from `https://images.bikesiliconvalley.org/email/`, the R2 bucket `svbc-email-images` in
SVBC's Cloudflare account (`r2.dev` off). Names end in a hash of the file and are cached for a year, so a new
photo gets a new name; a name already in a sent email must keep working.

To change an email: edit `scripts/build-stewardship-emails.mjs`, run it, open the Sequence, choose **Edit
sequence**, open the step, and replace the HTML with the file's under **`<>`**. Save both the HTML and the
Sequence, then test it (step 4).

For each:
- [x] Subject and body from the doc. Merged: **First Name** (`text_mm8scaqj`) in the greeting, **Last Gift
      Amount** (`numeric_mm8pd89h`) in Welcome #1, **Member Until** (`date_mm8n6xgb`) in the renewals.
- [ ] **No blank First Name.** The greeting is "Hi {First Name},". On 2026-11-24, 84 of 8,412 people on
      People had none and would read "Hi ,".
- [x] Copy fixes: the "Why Your Gift Matters" link's `utm_source=chatgpt.com`, and "Sillicon".
- [x] **Renewal date wording** (option chosen 2026-11-24; Felicia's approval pending). Reminders go out a
      month before Member Until (`renewalMonthsEarly`), so they no longer say support is set to expire.
      They say: "Your annual support of SVBC is due for renewal. Your membership stays active through
      {Member Until}."
- [x] **One opt-out, in the footer** (David, 2026-11-24): "Unsubscribe from member emails", Monday's own link,
      under SVBC's name and address. There is no choice of emails, so the "Choose which emails you get from us"
      line and its Email Preferences link are gone. Monday's list doesn't reach Mailchimp, so this link doesn't
      stop the newsletter.
- [x] **Unsubscribe link and global unsubscribe list stay on.** These are fundraising emails, not receipts:
      they carry no gift date or goods-or-services statement, and the Worker skips anyone Mailchimp lists
      as unsubscribed, so a receipt could never depend on them.
- [x] Links tagged `utm_source=monday`, `utm_medium=email` and `utm_campaign=` `new-member-welcome-1`,
      `new-member-welcome-2`, `membership-renewal-3wk`, `membership-renewal-1wk`,
      `membership-renewal-dayof`. They point at final pages, since a redirect can drop the tags.
- [x] Sender `membership@`; Pacific, 7:00 AM–5:00 PM, every day. Removal on reply and bounce on; auto-reply
      was turned on but not read back.
- [x] "Renew Your Gift Today" is the gold button, before the perks box. The welcome emails have no button.
- [x] Welcome #1's "sign up for our biweekly volunteer newsletter" links to the Volunteer with SVBC page, which
      has the mailing list form.
- [ ] Felicia approves the date wording, photos, greeting, layout and footer (asked 2026-11-24).
- [ ] Each Sequence stays **inactive** until step 5.

## 3. Five automations (UI)

On People, one per label:

> **When 🔒 Stewardship Email changes to `<label>`, enroll item in `<label>`**

- [ ] Exactly one per label. Use the "changes to" a specific label trigger, not "changes" with a condition.
- [ ] Read them back with the monday MCP's `list_automations`. Don't trust the builder's summary.

## 4. Test on production with a staff address

To test, turn the Sequence on, enroll the staff member's People item (the MCP's `enroll-item-in-sequence`,
no label or automation needed), wait for the run to show completed, and turn the Sequence off.

- [x] The HTML emails went to one staff record and then to Felicia, Clarrissa and Martha on 2026-11-24. In
      Monday's copies the photos, links, campaign tags and unsubscribe link were right. Only Felicia's record
      and the first had a gift and a Member Until; without them the email reads "gift of $" and "active
      through .", which the Worker's rules should never select.
- [ ] Look at all five in an inbox, on a phone as well.
- [ ] Set the label by hand on a staff item once the automations exist (step 3), to test the enrollment.
      Then clear the label and pause the Sequences again.

Don't click the unsubscribe link in a test: it's live.

## 5. Go live

1. Turn all five Sequences on.
2. Add this to `mailchimp-sync/config/svbc.json`, then PR, merge and deploy (`npm run deploy`):
   ```json
   "stewardship": {
     "boardId": 18437909781,
     "columns": { "email": "email_mm8nx6qg", "label": "color_mm98qe1j",
       "membershipStatus": "color_mm8ng6nw", "membershipTier": "color_mm8n5hh8",
       "memberType": "color_mm8pz9ry", "memberSince": "date_mm8nemca", "memberUntil": "date_mm8n6xgb",
       "hasActiveRecurringGift": "boolean_mm8nmjs9", "doNotSolicit": "boolean_mm8nf0wq" },
     "plan": { "labels": { "welcomeDayAfter": "Welcome: day after", "welcome3Weeks": "Welcome: 3 weeks",
         "renewal3Weeks": "Renewal: 3 weeks before", "renewal1Week": "Renewal: 1 week before",
         "renewalDayOf": "Renewal: day of" },
       "activeStatusValue": "Active", "lifetimeTierValue": "Lifetime", "newMemberTypeValue": "New",
       "catchUpDays": 2, "renewalMonthsEarly": 1 },
     "renewalOptOutTag": "renewal-opt-out", "renewalInterest": "986d6c84bf", "welcomeInterest": null,
     "maxWritesPerRun": 200
   }
   ```
   `welcomeInterest` stays `null`. On 2026-11-19 no active member had Welcome Drip ticked, so
   requiring it would welcome nobody. **Before merging, decide `renewalInterest` and `renewalOptOutTag`:**
   they are renewal-only opt-outs, and the emails now offer one opt-out for everything. Count who has used
   either first, since dropping them would send those people renewals.
3. The first run only picks up people inside a window that day (within `catchUpDays`). Nobody whose
   membership already lapsed is emailed. Days count to the reminder date, a month before Member
   Until: someone 10 days out at launch gets 1-week and day-of only, and someone already past it gets
   no reminder this cycle (98 eligible members if launched 2026-11-24, before Mailchimp opt-outs).
   Someone who joined before launch gets no welcome email.
4. The next morning, check the Worker log line `stewardship-run` (counts) and the Sequences' enrolled
   counts.

**Turning it off:** pause the Sequences, which stops sends immediately. Then set `stewardship` back to
`null` and deploy, which stops labels being set. The write switch (`scripts/flags.mjs mailchimp-sync
writes hold`) also stops labels, but it holds every other part of mailchimp-sync as well.

## Mailchimp Journeys

The Journey plan is dropped. The renewal-due tag and the Welcome Drip / Renewal Reminders interests
keep being maintained, and the config above still reads the interest as a renewal opt-out (see step 5).
Monday's unsubscribe list doesn't reach Mailchimp, and Monday has no API or automation for it (checked
2026-11-20), so someone who uses Monday's unsubscribe link still gets the Mailchimp newsletter
until they unsubscribe there too. Mailchimp unsubscribes are honoured before every Monday send. The
🔒 Email Preferences column (`profileLinks`) is still filled, but no email links to it now.
