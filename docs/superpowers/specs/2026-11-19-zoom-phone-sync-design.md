# Zoom Phone call and text log — design

Date: 2026-11-19 · Status: **design decided 2026-11-19 (see [Decisions](#decisions-2026-11-19-dwk)),
not built** · Worker: `zoom-phone-sync` (new)

## Intent

SVBC staff call and text supporters from Zoom Phone. None of it reaches Monday, so a donor's
People item shows their gifts, their Gmail-logged email and their Mailchimp Journey emails, but not
the call last week or the texts before a ride. This adds **every Zoom Phone call or text with a
known person → one entry on that person's People timeline**, plus a 🔒 **Last Phone Contact** date.

Nothing off the shelf does this. Monday CRM's own Zoom integration covers meetings only
([monday CRM Zoom integration](https://support.monday.com/hc/en-us/articles/19273496497042-monday-CRM-Zoom-integration));
Zapier has Zoom Phone triggers, but SVBC is retiring Zapier; phone systems with native Monday
logging (Aircall, JustCall, CloudTalk) would mean leaving Zoom Phone.

## Data source: Zoom Phone webhooks

A Server-to-Server OAuth app on SVBC's Zoom account, subscribed to four events
([events reference](https://developers.zoom.us/docs/api/phone/events/)):

| Event | Gives |
|---|---|
| `phone.caller_call_element_completed` | A call a staff member placed, once it ends |
| `phone.callee_call_element_completed` | A call a staff member received (answered, missed or to voicemail) |
| `phone.sms_sent` | A text a staff member sent |
| `phone.sms_received` | A text a staff member received |

The legacy `phone.*_call_log_completed` events were retired in May 2026
([migration note](https://developers.zoom.us/docs/phone/webhook-migrate/)); build on call elements only.

**Fields used.** Each call element carries `call_element_id`, `call_id`, `direction`
(inbound/outbound), `connect_type` (internal/external), `result`, `start_time`, `talk_time`,
and caller/callee `name`, `email`, `ext_number` and `did_number` (E.164). An SMS event carries
`message_id`, `session_id`, `date_time`, `sender.phone_number`, `to_members[].phone_number`,
`owner`, `message_type` and `message` (the text, which is a required field: Zoom offers no way to
leave it out, so the Worker discards it at ingest). **The SMS payload fields are from a summary of
the reference, not read directly; confirm them against a real delivery in the sandbox before
building.**

**Not subscribed, deliberately:** recordings, voicemail, transcripts and AI call summaries
(`phone.recording_*`, `phone.voicemail_*`, `phone.recording_transcript_completed`). The Worker
also drops `recording_id` and `voicemail_id` from what it stores. Scopes: only the granular
read scopes for call elements and SMS messages.

**Why webhooks, not polling.** The account-level call-history and SMS REST endpoints weren't
confirmed in Zoom's reference during this design (the page is too large to read in one pass), and
webhooks fit the repo's reference shape (`funraise-sync`). See [Delivery risk](#delivery-risk) for
what that costs.

## Flow

The standard webhook shape (root `CLAUDE.md`, Architecture):

1. **`POST /webhooks/zoom`** on the Worker's `workers.dev` host (outside the
   `bikesiliconvalley.org` zone, so no Super Bot Fight Mode skip rule is needed; a custom domain
   would need one).
   - Answers `endpoint.url_validation` with `{plainToken, encryptedToken}`, where
     `encryptedToken = HMAC-SHA256(secret, plainToken)` hex. Zoom revalidates every 72 hours.
   - Verifies `x-zm-signature` = `v0=` + `HMAC-SHA256(secret, "v0:{x-zm-request-timestamp}:{raw body}")`
     in constant time, and rejects timestamps more than 5 minutes off. 401 otherwise.
   - Must answer within 3 seconds
     ([webhooks](https://developers.zoom.us/docs/api/webhooks/)): it only filters, writes D1 and
     enqueues.
2. **Filter at ingest** (nothing past this point stores what's dropped):
   - Calls with `connect_type: internal` (staff to staff).
   - Events whose staff party is in config `zoom.excludeUsers`. It's empty in production: every
     staff line is logged, including the main number and call queues (decision 4). The sandbox
     sets `zoom.includeUsers` to its one test line instead.
   - Anything without an external phone number (blocked or anonymous callers).
   - The SMS `message` field, always: no message text goes past ingest (decision 1).
3. **D1 dedupe** on `call_element_id` / `message_id`, then **enqueue**. D1 status here means
   "ingested", as in every webhook Worker.
4. **Queue consumer:** match, write the timeline entry, advance Last Phone Contact, mark `logged`.
   Outage retry policy, breaker (`src/monday/outage.ts`) and DLQ as every queue Worker.

### Matching

People has one **Phone** column (production `phone_mm8n5szp`; the import filled it from Salesforce
`Phone`, falling back to `MobilePhone`). Monday stores it as entered, so an exact
`items_page_by_column_values` lookup misses `(408) 555-0100` against `+14085550100`.

- **Phone index in D1**, rebuilt by a nightly cron: every People item's Phone, normalized to E.164
  (US default; drop extensions), → item id. About 8,000 items, one paged read a night.
- The consumer normalizes the event's external number and looks it up. Every matching item gets
  the entry and its Last Phone Contact, so a shared household number logs on each person (decision
  3; 101 numbers on 214 items as of 2026-11-19). None → `unmatched`.
- **Rematch:** after each nightly rebuild, `unmatched` rows younger than 14 days are tried again,
  so a call from someone staff add to People the next day still lands.
- **Never creates a person.** Organizations' Phone is out of scope for v1 (see Alternatives).

### What lands in Monday

**One `create_timeline_item` per call or text**, custom activities **Zoom Phone call** and **Zoom
Phone text** on the People item, under Emails & Activities, beside Gmail email and Mailchimp
Journey emails. Same mechanics as `mailchimp-sync`'s Journey send log: `content` is HTML (`<p>`
paragraphs, escaped), title and summary capped at 255 characters, the create sent with
`idempotent: false`.

| | Title | Summary | Content |
|---|---|---|---|
| Call, answered | "Call with Jane Rider" | "Outbound · 12 min" | Staff member, direction, start time, length |
| Call, missed | "Missed call to Jane Rider" | "Inbound · voicemail" or "Inbound · no answer" | Same, no voicemail content |
| Text | "Text from Jane Rider" / "Text to …" | "On Ann Staff's line" | Staff line, direction, time, and an **Open in Zoom** link. No message text |

Timestamp: the call's `start_time` or the text's `date_time`.

**The Zoom link for texts** (decision 1) goes to the SMS tab of the Zoom web app (`zoom.smsUrl` in
config; the exact URL is checked in the sandbox). Zoom has no documented link that opens one SMS
conversation ([community thread](https://community.zoom.com/t5/Zoom-Phone-System/Zoom-Phone-Sms-deep-linking/m-p/168089)),
so the entry names the staff line, and the reader finds the thread there by the person's number.
Only that line's owner (and Zoom admins) can read it. A colleague sees that a text happened, when
and on whose line, and asks the owner for the content.

**Last Phone Contact** (🔒 Date on People): set to the entry's Pacific date for an answered call or a
sent/received text, never moved backward (the `advanceDate` rule from the Journey send log). A
missed call doesn't move it. Add to `MARKED_COLUMNS` in `scripts/mark-read-only-columns.mjs`.

## State

D1 (migration `0001`):

```
phone_events
  event_id        TEXT PRIMARY KEY  -- call_element_id or message_id
  kind            TEXT              -- call | text
  occurred_at     TEXT
  zoom_user_id    TEXT              -- the staff party
  external_e164   TEXT              -- cleared once logged, or when an unmatched row expires
  direction       TEXT
  result          TEXT              -- calls only
  talk_seconds    INTEGER
  status          TEXT              -- pending | logged | unmatched | failed | dropped
  logged_at       TEXT
  attempts        INTEGER

phone_event_items                   -- one row per People item an event is logged on
  event_id        TEXT
  item_id         TEXT
  timeline_id     TEXT              -- set once Monday confirms the create
  PRIMARY KEY (event_id, item_id)

phone_index
  e164            TEXT
  item_id         TEXT
  PRIMARY KEY (e164, item_id)
```

- **No message text anywhere.** Ingest drops `message` before D1, the queue or a log sees it, and
  Monday never gets it.
- **Per-item progress.** A shared number logs on several items; `phone_event_items` records each
  confirmed create, so a retry after a partial failure writes only the items still missing one.
- **Phone numbers in D1 are short-lived:** cleared on `logged`, and unmatched rows are deleted
  after 14 days, so D1 doesn't become a record of staff's personal calls.
- **Logs are counts only.** `check-log-safety.mjs` covers email addresses; phone numbers aren't
  checked by it, so the code review has to hold this line (or extend the check).
- **At-least-once:** a crash between Monday's create and the D1 `logged` write duplicates that one
  entry on redelivery. The repo's invariant: a rare duplicate, never a missing entry.
- **Write switch** `zoom-phone-sync:writes` (copy `src/flags.ts`; add to `IN_SCOPE`): `on` logs;
  `off` ingests and stamps queue messages `dropped`; `hold`/`unknown` keeps them queued. The
  nightly index rebuild runs under every state (it writes only D1).

## Delivery risk

Zoom retries a failed delivery three times (5, 20 and 60 minutes later) and then gives up; it
doesn't retry 4xx. So an event is lost only if ingest is down for about 85 minutes, since ingest
needs nothing but D1 and the queue (Monday outages only delay the consumer). Accepted for v1.
`sync-watchdog` can't see missing webhooks; if losses matter later, add a daily reconcile against
the call-history and SMS APIs once their endpoints and scopes are confirmed.

## Sandbox

There is one Zoom account, so the sandbox gets its **own** Server-to-Server app and webhook
subscription, with `zoom.includeUsers` set to one test line. Production calls never reach the sandbox People
board, matching "sandbox is inbound only, no outbound data". `config/sandbox.json` and
`config/svbc.json` follow `member-portal`'s split test (no shared board, column or Zoom
app id). `env.sandbox` needs explicit `routes: []` (it has none anyway, but the rule holds).

## Config

```json
{
  "people": { "boardId": 0, "phoneColumn": "phone_mm8n5szp", "lastPhoneContactColumn": "<date column id>" },
  "timeline": { "callActivityId": "<custom activity id>", "textActivityId": "<custom activity id>" },
  "zoom": {
    "accountId": "<id>",
    "includeUsers": null,
    "excludeUsers": [],
    "smsUrl": "<Zoom web app SMS tab URL>"
  },
  "defaultRegion": "US",
  "unmatchedRetentionDays": 14
}
```

`includeUsers: null` means every user on the account. Secrets: `ZOOM_WEBHOOK_SECRET` (signature and URL validation). Monday access through the
`monday-auth` broker's `SyncToken`. No Zoom REST calls in v1, so no Zoom client secret; the S2S
app exists only to own the webhook subscription.

## Volume

Unknown until measured (Zoom admin → Phone System → Call Logs for a month). A guess for
~10 staff lines: 20–60 external calls and texts a day, most with people in People. Monday cost per
logged event: one create and at most one date write.

## Alternatives considered

- **Activities (Logged) items** instead of timeline entries. Rejected for the reason the Journey
  send log gives: staff read that board as deliberate, significant touches, and the imported
  Activities board already hit its item limit (GL#92). A staff member who wants a call on record
  as a significant touch still logs it there by hand.
- **Message text on the timeline.** More useful, but staff texts can be personal and every seat
  with access to People could read them. Rejected (decision 1); the entry links to Zoom instead.
- **One entry per text conversation per day** instead of per message. Tidier for long threads, but
  needs a daily batch and a different state model. Revisit if timelines get noisy.
- **Organizations' Phone.** A call to a company's main line would land on the Organization.
  Deferred: most of those numbers are switchboards, and staff call people, not front desks.
- **Zapier** (Zoom Phone triggers → Monday). SVBC is retiring Zapier, and it can't do the
  normalization, dedupe or privacy filtering.
- **Polling** call history and SMS hourly instead of webhooks: no public endpoint and self-healing,
  but the endpoints weren't confirmed. Keep it as the reconcile path above.

## Decisions (2026-11-19, dwk)

1. **Texts: only that a text happened, with a link to Zoom for the content.** No message text in
   Monday, D1, the queue or logs.
2. **Staff notice: update the communication-logging protocol** (monday-migration
   `protocols/monday/logging-emails.md`, and its Box copy) before writes go on. Draft below.
3. **Shared numbers: log on each** People item that holds the number.
4. **Lines: all staff.** Every Zoom Phone user, the main number and call queues included;
   `excludeUsers` stays for exceptions.

### Protocol text (decision 2)

Replaces the protocol's "Calls and meetings" section. Publish it the day production writes go on,
not before, so staff aren't told about logging that isn't happening yet.

> ## Zoom Phone calls and texts
>
> Calls and texts on your Zoom Phone line with anyone on **People** are logged by themselves. Each
> one shows on the person's item under **Emails & Activities**, and their **Last Phone Contact**
> date moves. This covers every staff line, including the main number and call queues. Calls
> between staff aren't logged.
>
> - **What's logged:** who called or texted whom, when, and how long a call lasted. Never what was
>   said: no recordings, no voicemail, no message text. A text's entry names the line it was on and
>   links to Zoom, where only that line's owner can read the conversation.
> - **Who can see it:** everyone with access to People. Calls and texts with numbers that aren't on
>   People aren't logged, so personal calls on your Zoom line stay out of Monday.
> - **Matching:** Monday matches the number in the person's **Phone** column. If a call didn't show
>   up, add the number to the person; a call up to 14 days old is then logged overnight.
> - **Shared numbers:** a number on several people (a household) logs on each of them.
>
> ## Significant calls, and calls and meetings off Zoom Phone
>
> A call that matters to the relationship (a major-gift conversation, a sponsor's commitment) is
> still worth an item on the **Activities (Logged)** board with your notes: set **Activity Type**
> to **Call** or **Meeting**, set the date, and link the **Person**. Do the same for calls on your
> own mobile and for meetings.

## Phone coverage (counted 2026-11-19)

Production People board (18437909781), Phone column `phone_mm8n5szp`, read-only count, no numbers
printed. The normalization is the one Matching describes (US default, extension dropped).

| | Items | Share |
|---|---|---|
| People items | 8,410 | |
| With a Phone value | 4,972 | 59% |
| That normalize to E.164 | 4,953 | 59% |
| Distinct numbers | 4,840 | |
| Numbers on more than one item | 101 (on 214 items) | 4% of items with a phone |
| Membership Expiry today or later | 1,496 | |
| Of those, with a usable phone | 1,048 | 70% |

Coverage is good enough to build: most current members match, and almost every stored number
normalizes. Calls with people who aren't in People, or whose number isn't on file, stay unmatched;
the 14-day rematch only helps when staff add the number afterwards.

## Before building

- The Zoom web app's SMS tab URL for `zoom.smsUrl`, checked signed in as a staff line.
- A sandbox S2S app subscribed to the four events, and one real delivery of each captured (shape
  only, numbers redacted) as test fixtures. This confirms the SMS fields.
- The two custom activities created in Monday (account-wide ids, as "Mailchimp email" was) and
  Last Phone Contact added to both People boards.

## At launch

- Protocol text above merged into `protocols/monday/logging-emails.md` and the Box copy, and a
  note to staff, the same day `zoom-phone-sync:writes` goes `on` in production.
