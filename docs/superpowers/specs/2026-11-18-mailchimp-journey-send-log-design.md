# Mailchimp Journey send log — design

Date: 2026-11-18 · Status: draft for approval · Worker: `mailchimp-sync`

## Intent

Felicia Ward (Development Director) wants donor stewardship email to go out as sequences, with
each email a donor receives visible on that donor's Monday People item. The sequences stay in
Mailchimp Customer Journeys: Funraise can't log its sends and has no API for its email campaigns.
`mailchimp-sync` already feeds the Journeys (MEMBSINCE, MEMBUNTIL, LASTGIFT, the `renewal-due` tag,
the Welcome Drip and Renewal Reminders interests). This adds the return path: **every Journey email
sent → one entry on the recipient's People item.**

## Answer: feasible, from the Marketing API, by polling

Checked against the live account on 2026-11-18, read-only GETs only. No member emails printed.

| Call | Result |
|---|---|
| `GET /customer-journeys/journeys` | Works (not in the reference's navigation, but served). Two journeys, both `draft`, 0 started, on the production audience `eab542a5df`: **111 "New member welcome series"**, **110 "Membership renewal reminders"**. The sandbox audience has none. |
| `GET /customer-journeys/journeys/{id}/steps` | Every `action-send_email` step carries `action_details.email`: a campaign `id`, `type: "automation-email"`, subject, `emails_sent`, archive URL. Welcome: `b020e6552e` "Welcome to SVBC!", `620591c2ce` "Have you checked out our website?" (20 days later). Renewal: `a73c2f5a4d`, `1d0017d1d6`, `700d0c0bbd` (2 weeks apart, behind if/else steps). |
| `GET /campaigns?type=automation-email` | Lists exactly those five. |
| `GET /reports` | **Doesn't** list them (1,549 reports, all `regular`/`variate`); `?type=automation-email` returns 0. Journey emails aren't discoverable from `/reports`. |
| `GET /reports/{id}`, `/reports/{id}/sent-to`, `/reports/{id}/email-activity` | All answer 200 for a Journey email id (`type: automation-email`, `total_items: 0`, since nothing has sent). |
| `sent-to` row (seen on a regular campaign) | `email_address`, `email_id` (the subscriber hash), `status` (`sent`/`hard`/`soft`), `open_count`, `last_open`, `merge_fields`. **No send time.** |
| `email-activity` row | `open`/`click`/`bounce` actions with timestamps. **No `sent` action.** |
| Audience webhooks | No per-recipient send event (subscribe, unsubscribe, profile, cleaned, upemail, campaign only). Polling is the only route. |

**Proven end to end in the sandbox, 2026-11-18** (see [Verification](#verification-done-2026-11-18)):
a Journey send shows up in `sent-to` within a minute, and the member's `/activity` gives its exact
send time.

## Data source

An hourly step in `mailchimp-sync`'s existing `5 * * * *` cron:

1. **Catalog.** `GET /customer-journeys/journeys`, keep those on `mailchimp.audienceId` (or the
   ids in `journeyLog.journeyIds`, if set), then `GET …/steps` for each. Collect the
   `action-send_email` steps: journey id and name, step id, campaign id, subject, archive URL, and
   position ("email 2 of 3"). That's 1 + one call per journey per hour. New journeys Felicia builds
   later are picked up with no config change.
2. **Recipients.** For each Journey email with `emails_sent` greater than what D1 has recorded for
   it, page `GET /reports/{id}/sent-to?count=1000` and diff against D1. Skip the email entirely
   when the counts match (most hours). `sent-to` has no `since` filter and no documented order, so
   each changed email is read in full. That's cheap at this volume: a few pages a year.
3. **Send time.** `sent-to` has none, so for each new row read
   `GET /lists/{list}/members/{email_id}/activity` and take the `sent` action's `timestamp` for this
   `campaign_id`. That's one call per new send, about 7 a day. It's keyed by the `email_id` that
   `sent-to` returns, so the address is never needed for it. Use the classic `/activity`, not
   `/activity-feed`: in the test, the feed showed only the signup, not the send. If no `sent`
   action is found, fall back to the time the poll first saw the row (at most an hour late).
   The report's own `send_time` is the email's *first* send only, so it's no use per recipient.

## Where the records land: the People item's timeline

**One `create_timeline_item` per send, as a custom activity "Mailchimp email" on the person's People
item.** It shows under **Emails & Activities**, beside the Gmail-logged email (staff guide §3). This
follows the precedent of `eventbrite-sync`'s class emails (`classEmails.timelineActivityId`,
`createTimelineItem` in `eventbrite-sync/src/monday/client.ts`).

- **Title:** the subject as sent, e.g. "Welcome to SVBC!". **Summary:** "New member welcome series
  · email 1 of 2". **Content:** the journey, the step, and the campaign archive link (`long_archive_url`),
  so staff can see what was sent. No body copy, and no merge-field values.
- **Bounces get an entry** (decided 2026-11-18): a `hard`/`soft` row is titled "Not delivered:
  <subject>", so staff see the stewardship email didn't arrive. The hourly consent sync still
  handles the cleaned address as it does today.
- **Matching:** the row's `email_address` against any of People's email columns (the consent sync
  covers the same Personal/Household/Work columns, in config). One match gets the entry. None or
  several: D1 status `unmatched`/`ambiguous`, no entry, and counts only in the log. **Never creates
  a person.**

### Two People columns, both 🔒

- **Last Journey Email** (Date, decided 2026-11-18): set in the same step as the timeline entry, to
  the entry's date, for a delivered send only (a bounce leaves it alone). It only moves forward. A
  later date already in the cell wins, so an out-of-order or retried row can't move it back. Staff
  can sort and filter on it ("not stewarded in 90 days"). The subject and the Journey are on the
  timeline entry, not in the column.
- **Mailchimp Profile** (Link): opens the person's contact page in Mailchimp. That's where every
  newsletter send, open and click lives. Newsletter (`regular`) sends are **not** logged in Monday
  (decided 2026-11-18): they go to ~23,000 contacts and would bury the stewardship history.
  The hourly consent sync already pages every audience member (`readMailchimpStatuses` in
  `src/consent/sources.ts`). Add `members.web_id` to its `fields`, and write the link as
  `https://<dc>.admin.mailchimp.com/lists/members/view?id=<web_id>` (`web_id` confirmed in the
  member resource, and the URL checked in a browser to open the contact profile, both on 2026-11-18).
  The link is for the address in People's primary **Email** column, falling back to the first other
  email column in the audience. It's written only when blank or different, so most hours write
  nothing. The first run fills about 800+ members. It's cleared when the address leaves the
  audience (deleted, not archived).

Both go in `scripts/mark-read-only-columns.mjs`'s `MARKED_COLUMNS`. Config names them as
`monday.columns.lastJourneyEmail` and `monday.columns.mailchimpProfile`; `null` turns either off.

### Alternatives considered

- **Activities (Logged) items, linked to the Person.** Rejected. The staff guide says to log only
  significant touches there ("Routine email stays in email"), and automated drips would make it
  mostly machine noise, around 2,500 items a year (below). The imported Activities board already hit
  its item limit (GL#92), and staff read Activities (Logged) as the record of real human touches.
- **A per-person column only.** It shows the latest send, not each send, so it doesn't meet the ask
  alone. It's added alongside the timeline instead (above).
- **Logging newsletter sends.** Mailchimp already records them. The Mailchimp Profile link takes
  staff there.
- **The Campaigns board connect column** (the inbound side, off in production). It shows which
  Journeys a person is *enrolled in*, not what they were *sent*, and it needs the audience webhook
  and Campaigns board built. It doesn't serve this ask and stays off.

## Cursor and idempotency

Cron-polled-Worker invariant: what the poll treats as done advances only after Monday confirms.

D1 table `journey_sends` (new migration):

```
campaign_id   TEXT    -- Journey email (automation-email) id
email_id      TEXT    -- Mailchimp subscriber hash; never the address
journey_id    INTEGER
step_id       INTEGER
delivery      TEXT    -- sent | hard | soft
status        TEXT    -- pending | logged | unmatched | ambiguous | dropped
people_item_id TEXT
sent_at       TEXT    -- the entry's timestamp: member /activity, else first seen
logged_at     TEXT
PRIMARY KEY (campaign_id, email_id)
```

plus `journey_email_counts(campaign_id PRIMARY KEY, emails_sent)`, the per-email "already read up
to" mark.

- A new `sent-to` row is inserted `pending` (`INSERT … ON CONFLICT DO NOTHING`). The poll then works
  every `pending` row: match, `create_timeline_item`, then `logged`. A row that fails stays
  `pending` and is retried next hour.
- `journey_email_counts` advances to the report's `emails_sent` only after every row from that read
  is in D1, so a crashed read is read again.
- **At-least-once, not at-most-once.** A timeline entry can't be looked up to dedupe, so a crash
  between Monday's create and the D1 `logged` write duplicates that one entry next hour. That's the
  repo's invariant: a rare duplicate entry, not a missing one. (`eventbrite-sync` chose the opposite
  for class emails because those are staff-triggered sends with a ledger of their own. Here, D1 is
  the only record.)
- **Write switch** (`mailchimp-sync:writes`): `on` logs. `off` reads, inserts rows as `dropped` and
  advances the counts, so those sends are never logged (the poller rule in `migration-hold.md`).
  `hold`/`unknown` skips the step, and the counts stay put. Counts-only logs, never an address
  (`check-log-safety`).
- **Backfill:** both Journeys are `draft` with 0 sent. **Deploy and turn this on before Felicia
  activates them**, so the first run has nothing to backfill. If a Journey is live first, the first run
  logs its history at the poll's time, which is wrong-dated. In that case, insert the existing rows
  `dropped` once (a `--baseline` option) rather than post them.

## Volume

- **Renewal reminders:** 663 active members (the 2026-11-17 seed), about 650 after
  `renewal-opt-out`/`recurring-donor` exclusions. Up to 3 emails each per term: **≤ ~2,000 a year**.
- **Welcome series:** 2 emails per new member. At a few hundred new members a year: **~500 a year**.
- **Total ≈ 2,500 timeline entries a year, ~7 a day.** Monday: one People lookup, one create and one
  Last Journey Email write per send, about 20 calls a day. Mailchimp Profile links: a one-time fill,
  then only changed addresses. Mailchimp: about 3 catalog calls an hour, plus a `sent-to` page when a count
  moves and one member `/activity` read per new send. Further stewardship Journeys add linearly.

## What staff see

On a donor's People item → **Emails & Activities**: a "Mailchimp email" entry for each Journey email,
dated the day it went out, with the subject, the Journey and the step, and a link to view the email
as sent. It sits beside Gmail-logged mail and class emails. A bounced send shows as "Not delivered".
On the item itself: **Last Journey Email** (the date of the latest delivered Journey email) and
**Mailchimp Profile** (a link to the contact in Mailchimp). Nothing appears on Activities (Logged), and
nothing is editable. Opens, clicks and newsletter sends stay in Mailchimp, one click away through
Mailchimp Profile.

## Config

`mailchimp.journeyLog` in `config/*.json`, `null` to turn the step off:

```json
"journeyLog": {
  "timelineActivityId": "<custom activity id>",
  "journeyIds": null
}
```

The "Mailchimp email" custom activity is created once in Monday (Emails & Activities → custom
activity), as `eventbrite-sync`'s "Logged email" was. The sandbox config points at the sandbox People
board, and the sandbox audience already has a paused test Journey, 112 (see Verification). The split test keeps the two configs
apart.

## Verification (done 2026-11-18)

In the **sandbox** audience `dfe12eec72`: a test contact (a staff plus-address, `web_id` 616612920)
and a one-email Journey, **112 "TEST journey send log (sandbox)"**, triggered on **Tag added:
journey-test**. Its email is campaign `6197876e9b`. The contact was tagged by API at 22:22:37 UTC,
and the reports were polled every 30 s:

| Time (UTC) | What the API showed |
|---|---|
| 22:22:37 | Tag added. Campaign `status: sending`, `emails_sent: 0`, Journey stats 0. |
| 22:27:28 | Journey `started: 1, in_progress: 1`. `sent-to` still empty. |
| 22:27:33 | The send (member `/activity`: `action: sent`, `campaign_id: 6197876e9b`, this timestamp; report `send_time` the same). |
| 22:28:00 | `emails_sent: 1`, Journey `completed: 1`. **`sent-to` has 1 row: `email_id` = the contact's hash, `status: sent`, `campaign_id`, `list_id`.** `email-activity` has the row with no actions. |
| 22:28:12 | `/activity-feed` still shows only `generic_signup`, no send. |

- **`sent-to` works for Journey emails.** The row appeared within 30 s of the send, about 5 minutes
  after the tag, Mailchimp's own trigger lag. `emails_sent` moved with it, so the poll can skip
  unchanged emails as designed.
- **The exact send time is available** from the member's classic `/activity` (Data source step 3).
  `/activity-feed` doesn't show it.
- **Mailchimp Profile link:** `https://us9.admin.mailchimp.com/lists/members/view?id=616612920`,
  opened signed in, redirected to `/audience/contact-profile?contact_id=…` and showed the test
  contact's profile. Signed out, it goes to Mailchimp's login and then back to the profile.
- **Building the Journey:** Customer Journeys can be read through the API but not created, so the
  test Journey was built in the web app. Its email needed real content before the flow would turn on
  (the template's placeholder text blocks activation). That was set with `PUT /campaigns/{id}/content`.
- **Cleanup:** Journey 112 is **paused** (kept for re-testing the Worker in the sandbox, re-tag a
  contact to send again) and the test contact is **archived**.

So the fallbacks considered earlier (a per-member feed poll, or Journey tag steps) aren't needed.

## Decisions (2026-11-18, dwk)

1. **Add Last Journey Email** as a 🔒 Date column on People, alongside the timeline entries.
2. **Bounces get a timeline entry** ("Not delivered: <subject>").
3. **Newsletter sends aren't logged in Monday.** They stay in Mailchimp, reached through a
   Mailchimp Profile link on the People item.
