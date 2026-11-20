# Stewardship emails in monday CRM Sequences

The two welcome emails and three renewal reminders, sent by monday CRM Sequences from People.
`mailchimp-sync` sets the 🔒 **Stewardship Email** label each morning, and a Monday automation per
label enrolls the person in the Sequence of the same name. Which label goes to whom and when:
`mailchimp-sync/README.md`, "Stewardship emails (Monday Sequences)".

Copy: Felicia's Google Doc "2026 Donor Stewardship Email Sequences" (approved 2026-11-19). Photos:
Felicia's 2026-11-19 email (below). Neither is in this repo.

## Done

- [x] 🔒 Stewardship Email status column, labels at ids 0–4 (nothing at id 5):
  - Production People `18437909781`: `color_mm98qe1j`
  - Sandbox People `18437342592`: `color_mm98np52` (config filled)
- [x] Worker code, sandbox run on 2026-11-19: it read all 7,684 sandbox people and planned 63 labels. 62 were
      held (none of those addresses are in the 2-member sandbox audience) and one renewal label was cleared
      on a test item (`13594488756`).

## 1. Prerequisites (staff)

- [ ] **`membership@bikesiliconvalley.org` is a mailbox, connected in Monday, managed by Martha.**
      Every stewardship email is sent from `membership@` (Felicia, 2026-11-19), and Martha is the
      person who manages that inbox (Deanna, 2026-11-19). Sequences only send from a connected
      mailbox, and **a Google Group can't be connected** — that blocked `learn@` for class emails
      (`eventbrite-sync/docs/class-emails-setup.md`). A Gmail "Send mail as" alias is no substitute:
      tested 2026-11-19, a Sequence's **Send emails as** picker lists only connected accounts, not
      their send-as aliases. `membership@` is a Google Group today (Felicia and Martha). To convert
      it, after hours (mail to it bounces during the switch):
      1. Google Admin: rename the group (e.g. `membership-team@`), then create the user
         `membership@` in the **Staff** OU. Free: Google Workspace for Nonprofits, 42 of 300
         licenses assigned on 2026-11-19.
      2. Gmail settings for `membership@`: delegate it to Martha, and to Felicia as backup (mail
         delegation is on for the domain; delegating to a group is off, so add people one by one).
         Under **Sender information**, choose **Show this address only**, so donors don't see
         "sent by Martha". Optionally forward a copy to `membership-team@`.
      3. Monday → Emails & Activities: sign in as `membership@` and connect it.
- [ ] **Martha works replies in Monday.** A reply to a Sequence email lands in `membership@` and is
      logged on the person's People timeline, so the queue of replies needing an answer lives in
      Monday.
- [x] **People board can take a Sequence.** Checked 2026-11-19: the "Connect a board" picker offers
      production People (Donors & Contacts, `18201685`) and sandbox People.
- [x] Welcome #2 stays (Felicia, 2026-11-19).
- [ ] The accountant's word on a deductibility line for the renewal emails, which mention Donor Perks.
- [x] **🔒 Email Preferences on production People** (2026-11-20): `link_mm99tvcv`, with 🔒 Mailchimp
      Profile `link_mm99hxpv`, both marked read-only; `profileLinks` turned on in
      `mailchimp-sync/config/svbc.json`. The hourly run fills them over the first day (500 writes a
      run). Sandbox: `link_mm99ntk0`.

## 2. Five Sequences (UI)

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
where. The table is a suggestion she can change. Each photo is 940×788. Insert it at the top of
the body, full width.

For each:
- [ ] Subject and body from the doc. Keep bold, links and line breaks. Insert columns with the
      editor's **`{ } Columns`** picker (it shows as `{pulse.<column id>}`). Typed braces don't merge.
      - Welcome #1 "your generous gift of **XX**" → **Last Gift Amount**.
      - Renewal `*|MEMBUNTIL|*` (a Mailchimp tag) → **Member Until**. Check in the test send how
        Monday formats the date.
- [ ] Last line of the body, above Monday's unsubscribe footer: "Choose which emails you get from
      us, or unsubscribe from all of them: {Email Preferences}", with **Email Preferences** from the
      `{ } Columns` picker. That page is Mailchimp's, so an opt-out there stops newsletters and these
      emails alike. Monday's own unsubscribe link only stops Monday's emails (see "Mailchimp
      Journeys" below), so this is the one to point people at. If renewal reminders are all they
      want to stop, the page's **Renewal Reminders** box does that.
- [ ] Copy fixes:
  - [ ] Welcome #1's "Why Your Gift Matters" link: drop `?utm_source=chatgpt.com`.
  - [ ] Renewal day-of: "Sillicon" → "Silicon".
- [ ] "Renew Your Gift Today" and the welcome-email links as buttons if the editor has them, else
      bold links.
- [ ] **Sender: `membership@bikesiliconvalley.org`.** **Send window: Pacific**, the default 7:00 AM–5:00 PM. The Worker
      sets labels at 07:00 Pacific, so the emails go out that morning.
- [ ] **Unsubscribe link on, global unsubscribe list on.** These are fundraising emails. Keep
      removal on reply, bounce and auto-reply.
- [ ] Leave each Sequence **paused** until step 5.

## 3. Five automations (UI)

On People, one per label:

> **When 🔒 Stewardship Email changes to `<label>`, enroll item in `<label>`**

- [ ] Exactly one per label. Use the "changes to" a specific label trigger, not "changes" with a condition.
- [ ] Read them back with the monday MCP's `list_automations`. Don't trust the builder's summary.

## 4. Test on production with a staff address

- [ ] Use a staff-only People item with a staff Personal Email that is **subscribed** in Mailchimp.
      Set its label by hand to each value in turn, with that Sequence briefly active. Confirm the
      delivered email: photo, bold, links, Last Gift Amount and Member Until filled, unsubscribe link,
      and the Email Preferences link **clickable and opening the staff address's Mailchimp page**.
      If Monday prints the link's text without the link, or the raw URL, change the column's text
      in `LINK_TEXT` (`mailchimp-sync/src/profileLinks/run.ts`) or move the sentence; tell David.
      Then clear the label and pause the Sequences again.

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
       "catchUpDays": 2 },
     "renewalOptOutTag": "renewal-opt-out", "renewalInterest": "986d6c84bf", "welcomeInterest": null,
     "maxWritesPerRun": 200
   }
   ```
   `welcomeInterest` stays `null`. On 2026-11-19 no active member had Welcome Drip ticked, so
   requiring it would welcome nobody.
3. The first run only picks up people inside a window that day (within `catchUpDays`). Nobody whose
   membership already lapsed is emailed. Someone 10 days out at launch gets 1-week and day-of only,
   and someone who joined before launch gets no welcome email.
4. The next morning, check the Worker log line `stewardship-run` (counts) and the Sequences' enrolled
   counts.

**Turning it off:** pause the Sequences, which stops sends immediately. Then set `stewardship` back to
`null` and deploy, which stops labels being set. The write switch (`scripts/flags.mjs mailchimp-sync
writes hold`) also stops labels, but it holds every other part of mailchimp-sync as well.

## Mailchimp Journeys

The Journey plan is dropped. The renewal-due tag and the Welcome Drip / Renewal Reminders interests
keep being maintained, so renewals keep using the interest as the opt-out preference. Monday's
unsubscribe list doesn't reach Mailchimp, and Monday has no API or automation for it (checked
2026-11-20), so someone who uses Monday's unsubscribe link still gets the Mailchimp newsletter
until they unsubscribe there too. The Email Preferences link in each email is the way around that:
it opts out in Mailchimp. Mailchimp unsubscribes are honoured before every Monday send.
