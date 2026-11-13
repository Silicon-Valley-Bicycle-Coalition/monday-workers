# Class emails started from Monday, sent from Gmail — Design

**Date:** 2026-11-03
**Status:** Proposed. Not built.
**Worker:** `eventbrite-sync` (extends the attendee feed from
`2026-10-26-eventbrite-attendees-class-emails-design.md`, and replaces that design's follow-up job).
**Page:** a new Apps Script web app, kept beside `scripts/apps-script/mail-merge.gs` in the private
planning repo.
**Issue:** private planning repo #62 (Bike Education class emails).

## Why

Bike Education sends three emails for each class, as `learn@bikesiliconvalley.org`: a reminder
before class, a thank-you to people who checked in, and a missed-you to people who didn't. The
coordinator wants to start each send from Monday.

Monday can't send them. Mass email only offers connected mailboxes: on 2026-11-03, with `learn@` set
up as a Gmail "Send mail as" alias, its From list still showed only the signed-in user's own address.
`learn@` is a Google Group that SVBC uses for other things and wants to keep, and a real mailbox
would mean a paid seat and giving the group's address to it.

Gmail itself can send as `learn@`, so a click in Monday opens a small page that sends through the
clicker's own Gmail. A link is on demand, so there's no timer, and the page can show who will receive
the email before it goes.

## What the 2026-11-03 tests showed

| Tested (staff address only) | Result |
|---|---|
| Web app running as the visitor, access limited to SVBC accounts: sees the signed-in user, the `learn@` alias and the Gmail drafts | Yes |
| The same web app: `GmailApp.sendEmail` with `from` set to the alias | Delivered from `Bike Education <learn@bikesiliconvalley.org>`; raw headers not inspected |
| Mail merge Sheet, as a person using its menu: From in the raw message | `Bike Education <learn@bikesiliconvalley.org>`, no Unsubscribe link or `List-Unsubscribe` header, `{{First Name}}` filled in |
| Monday Mass email: From list | Connected mailbox only, no alias |
| Fresh Sheet copy: **Mail Merge** menu | Absent on one copy through two loads, present on another within about 20 seconds. **Cause unknown.** The send page doesn't use this menu. |

**Not tested:** a staff member's account, the first-run experience for a staff member, whether Monday's built-in logging picks up mail sent as `learn@`,
or anything below that isn't in this table.

## Goals

* The coordinator starts a class email from a link on the class's **Events** item.
* Before sending, the page shows the From address, the subject, the count and the recipients.
* It goes out through the sender's own Gmail as `learn@`, so replies reach the group and copies are
  in Sent.
* Monday records what was sent, by whom, to how many, and any failures.
* Nobody gets the same email for the same class twice.

## Non-goals

* A real `learn@` mailbox, or Monday Mass email and Sequences as the sender.
* Scheduling. A person always starts each send.
* Texts. The coordinator keeps sending those by hand from Zoom.
* Writing the wording on the page. Each email is still a Gmail draft, because each class needs its
  details typed in (start time, venue, event link).
* Program emails outside Bike Education (#87). They can adopt this later. The mail merge Sheet stays
  for them, and as the manual fallback.

## Anti-goals (failure even if it technically works)

* **A missed-you to a whole class that came.** If nobody was checked in, the send is refused.
* A duplicate send caused by a double click, a reload or a retry.
* An email to someone who cancelled.
* Personal data at rest in D1, or email addresses in logs.
* A Monday token in Apps Script.

## How it works

```
Coordinator: writes a Gmail draft, then clicks "Send class email" on the Events item
                                   │
                                   ▼
Send page (Apps Script, runs as the person who clicked)
     │  GET  /class-emails/:event             ──▶ eventbrite-sync reads Events and
     │       ◀── class, recipients per kind,      Event Registrations, and its D1 ledger
     │           refusals, earlier sends
     │  POST /class-emails/:event/claim       ──▶ records (event, kind, registration) in D1
     │       ◀── who may be sent to now
     │  sends with GmailApp, from the draft, one recipient at a time
     │  POST /class-emails/:event/result      ──▶ marks the ledger, posts an update on the item
```

There's one deployment, with "Execute as: User accessing the web app" and "Who has access: Anyone
within Silicon Valley Bicycle Coalition". Each sender authorizes it once. It holds no one's
credentials, and any sender with the alias uses the same link.

The Worker reads and writes Monday through its existing `SyncToken` binding. The script authenticates
to the Worker with a shared secret in Script Properties, which runs server-side and isn't visible to
someone only using the page.

### The coordinator's steps

1. In Gmail, write the draft: From `learn@`, the class's saved template, details typed in,
   `{{First Name}}` in the greeting. Mail merge off.
2. On the class's Events item, click **Send class email**.
3. On the page, choose **Reminder**, **Thank-you** or **Missed-you**, and pick the draft from a list of
   the coordinator's Gmail drafts.
4. Check the From, the subject and the recipients, then click **Send a test to me**.
5. After the test, click **Send to N people**.
6. The page shows the result, and an update on the item gives the kind, sender, count and failures.

### Who gets each email

Only **Role = Participant**, with an **Attendee Email**, on registrations linked to this Event.

| Kind | Attendance | Refused when |
|---|---|---|
| Reminder | Registered | The class has already started |
| Thank-you | Attended | The class hasn't ended, or no eligible person is Attended |
| Missed-you | Registered or No Show | The class hasn't ended, or no eligible person is Attended |

Canceled never receives anything. Every kind is refused unless the Eventbrite status is `live`,
`started`, `ended` or `completed`. That is an allowlist, so `draft`, no status at all and any status
Eventbrite adds later refuse, as `canceled` and `deleted` do. The page explains a refusal and offers
no send button.

The Attended check is the old Held guard. Only a Participant with an Attendee Email counts, so a
checked-in volunteer or a row with no address can't open a Missed-you to a class that came, or keep
someone from one. The page warns, without refusing, when a Thank-you or Missed-you is for a class
that ended more than 3 days ago. Partial check-in remains a known risk: anyone not scanned
gets a missed-you. The page reduces it by showing the list first, and the coordinator chooses when
check-in is finished.

### Safeguards

* **Preview, then test.** The send button stays off until a test has gone out from that draft in this
  page visit. It can't detect a draft edited after its test.
* **At most once.** The Worker records `(event, kind, registration)` before the script may send to
  them. A recorded recipient is never handed out again, so a double click or reload can't duplicate.
* **A crash never resends.** Recipients claimed but not confirmed show as "unconfirmed: check Sent
  mail" on the page and in the update. Only a person can release them, and the Worker refuses until
  10 minutes after the claim: Apps Script runs stop at about 6, so a younger claim may still be
  sending. A missed email is the better failure here.
* **A failed send is shown as failed.** Gmail refused it or the name was blank, so the run is over
  and it didn't go. It's listed apart from the unconfirmed, and a person can release it at any time.
* **Draft checks before anything sends.** The From must be the sender's address or alias, a Gmail mail
  merge "Unsubscribe" footer is refused, and a placeholder with no value is refused rather than sent
  as "Hello ,". The first two already exist in `mail-merge.gs`.
* **Write switch.** `eventbrite-sync:writes`: under anything but `on`, claims and releases are refused
  and the page says so. A result is still recorded in the ledger, because those emails already went,
  but its update, No Show and People link are skipped and not replayed.
* **Sandbox.** The sandbox config only returns recipients at the sandbox address, enforced in the
  Worker and checked by `config/split.test.ts`. It has its own deployment of the page.
* **D1 holds ids and statuses only.** Names and addresses pass through in responses and aren't logged.

## What changes

### `eventbrite-sync`

* `GET /class-emails/:event`, `POST /class-emails/:event/claim` and
  `POST /class-emails/:event/result`, authenticated with a new `CLASS_EMAIL_SECRET` compared in
  constant time, and rate-limited.
* D1 migration for `class_email_recipients` (event, kind, registration, status). The sender is recorded
  in the update on the item, not here.
* The attendee feed writes the **Send class email** link on each Eventbrite Events item it upserts.
* Retire the hourly follow-up job (`src/followups`) and the `Follow-up Email` column, whose only
  purpose was the Sequences. Its No Show marking needs a decision (see Open questions).
* Update the README's "Attendee feed and class emails" and mark `docs/class-emails-setup.md`
  superseded.

### Monday, on production Events

* **Send class email** (Link column), marked 🔒 through `MARKED_COLUMNS`, with the URL
  `<deployment>/exec?event=<item id>`.

Nothing else. No status column, and no Class Type, because the sender chooses the kind and the draft.

### The page (new Apps Script project)

* `doGet` serves the page; `google.script.run` calls the server functions.
* Reuses `templateFromDraft_`, `send_` and the checks from `mail-merge.gs`. These are copied, as Apps
  Script projects don't share code without a library. Mark each copy so a fix is applied to both.
* Adds no BCC. **Decided 2026-11-03:** every staff member gets a CRM seat, and Monday's built-in email logging keeps the record.
* Sends within Apps Script's execution limit. At about 3–26 recipients per send, this isn't close.

### Staff docs (private repo)

`docs/06`, `docs/36`, `docs/37` and the Box Program Email Sending Protocol all change to these steps.

## Order of work

1. **Attendee feed in production** (separate work, on the Class roster branch). Without it, Monday has
   no recipients.
2. Confirm whether Monday's built-in logging picks up one real send as `learn@`, to an outside address on a People record.
3. Worker endpoints, with tests, in the sandbox.
4. The page, tested in dwk@'s account against the sandbox Worker.
5. A staff account: the coordinator's alias, first-run authorization, one send to staff-only
   recipients.
6. Production, one real class, watched.

**Until step 6,** class emails go out from the Sheet by hand. That includes the E-Bike Basics reminder
due November 5–7.

## Risks

* **Google's first-run warning.** The test app showed "(Unverified)", and staff may see a further
  warning. Give the project a real name and walk the coordinator through it, or trust the app in Google
  Admin if that removes it. Not tested.
* **Who owns the project.** A personal owner leaving could take the deployment down. Decide where it
  lives before production.
* **Scope changes** make every sender authorize again.
* **Rosters reach anyone at SVBC with the link.** Staff can already view Event Registrations in Monday,
  so this exposes nothing new to that audience, but sends are limited only by having the alias.
* **The secret is shared.** Anyone with edit access to the project can read it. Keep editors to a
  minimum, and rotate it if that changes.
* **Links exist only for events the feed touches.** Events that arrived before the feed go live need
  the backfill or a link by hand.

## Open questions

1. **Should a Missed-you still mark people No Show?** The old job did. Recommended: yes, on a
   confirmed send, so Attendance stays useful for reports.
2. **Is Missed-you to Canceled wanted?** The protocol calls cancellations optional. Recommended: not
   in the first version.
3. **Which events get the link?** Recommended: every Eventbrite event with Program = Public. Staff
   running other kinds simply won't click it. There's no class marker on production.
   **Changed 2026-11-09:** every Eventbrite event, labelled *Send event email*, so the page serves
   any program's emails (the 2026 Bike Summit was the first non-class need). A volunteer event's
   emails go to its Volunteers; see the `eventbrite-sync` README.
4. **Who owns the Apps Script project?** Recommended: `SVBC Integration`, or a Shared Drive if the
   Workspace allows it.
