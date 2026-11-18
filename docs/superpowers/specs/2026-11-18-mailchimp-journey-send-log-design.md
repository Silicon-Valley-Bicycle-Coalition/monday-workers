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

**Not yet proven:** that `sent-to` fills in for an `automation-email` as a Journey sends. The
endpoints answer for these ids, but nothing has sent, so there are no rows to see. That's the first
build task (see Verification), and a fallback is below if it doesn't.

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
3. **Send time.** `sent-to` has none, so an entry's time is **when the poll first saw it**, at most
   an hour late. Journey sends are day-granular (`schedule_type: all_day`), so this is accurate
   enough for a donor history. Don't add the per-member `activity-feed` call for an exact time
   unless staff need it.

## Where the records land: the People item's timeline

**One `create_timeline_item` per send, as a custom activity "Mailchimp email" on the person's People
item.** It shows under **Emails & Activities**, beside the Gmail-logged email (staff guide §3). This
follows the precedent of `eventbrite-sync`'s class emails (`classEmails.timelineActivityId`,
`createTimelineItem` in `eventbrite-sync/src/monday/client.ts`).

- **Title:** the subject as sent, e.g. "Welcome to SVBC!". **Summary:** "New member welcome series
  · email 1 of 2". **Content:** the journey, the step, and the campaign archive link (`long_archive_url`),
  so staff can see what was sent. No body copy, and no merge-field values.
- **Bounces:** a `hard`/`soft` row gets an entry titled "Not delivered: <subject>".
  `mailchimp-sync`'s hourly consent sync already handles the cleaned address.
- **Matching:** the row's `email_address` against any of People's email columns (the consent sync
  covers the same Personal/Household/Work columns, in config). One match gets the entry. None or
  several: D1 status `unmatched`/`ambiguous`, no entry, and counts only in the log. **Never creates
  a person.**

### Alternatives considered

- **Activities (Logged) items, linked to the Person.** Rejected. The staff guide says to log only
  significant touches there ("Routine email stays in email"), and automated drips would make it
  mostly machine noise, around 2,500 items a year (below). The imported Activities board already hit
  its item limit (GL#92), and staff read Activities (Logged) as the record of real human touches.
- **A per-person column** ("Last Journey Email": date + subject). It shows only the latest send,
  not each send, so it doesn't meet the ask alone. It's worth adding **as well** only if Felicia wants
  a sortable or filterable "last stewarded" view. It's a cheap 🔒 column written in the same step. Open
  question 1.
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
first_seen_at TEXT    -- the entry's timestamp
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
- **Total ≈ 2,500 timeline entries a year, ~7 a day.** Monday: one People lookup and one create per
  send, about 15 calls a day. Mailchimp: about 3 catalog calls an hour, plus a `sent-to` page when a count
  moves. Further stewardship Journeys add linearly.

## What staff see

On a donor's People item → **Emails & Activities**: a "Mailchimp email" entry for each Journey email,
dated the day it went out, with the subject, the Journey and the step, and a link to view the email
as sent. It sits beside Gmail-logged mail and class emails. Nothing appears on Activities (Logged), and
nothing is editable. Not covered: who opened or clicked. Mailchimp's own contact profile stays the
place for that (`email-activity` could add it later). Neither is regular newsletter campaign
sends: those go to ~23,000 contacts and would bury the stewardship history.

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
board, and the sandbox audience needs its own Journey (below). The split test keeps the two configs
apart.

## Verification before building the rest

1. In the **sandbox** audience `dfe12eec72` (0 members today), add a staff test address and build a
   one-email Journey triggered on a tag. Tag the contact. This is a sandbox Mailchimp write, so it
   needs a go-ahead.
2. Confirm `GET /reports/{journey email id}/sent-to` returns that recipient with `status: sent`, and
   note how long it takes to appear.
3. If it **doesn't** appear: the fallback is `GET /lists/{list}/members/{hash}/activity-feed?activity_filters=sent`,
   per member, scoped to members who could be in a Journey: those tagged `active-member`/`renewal-due`
   or with a Journey interest. That's ~700 calls a poll, so daily rather than hourly, with the D1
   key unchanged. This is the expensive path. The cheaper one: Felicia adds a Journey "tag contact"
   step after each email (`journey-<id>-email-<n>`), and the poll reads tag membership through
   `GET /lists/{list}/segments`. Either way, the timeline landing above stands.

## Open questions

1. A "Last Journey Email" 🔒 column on People as well, for a view, or the timeline only?
2. Should bounces get an entry, or only the consent column change they already cause?
3. Should newsletter (`regular`) sends ever be logged? Recommendation: no, as above.
