# email-log: BCC an email to log it on Monday

Date: 2026-10-19. Status: design, not built.

## Why

Before cutover, SVBC staff logged email to Salesforce through the Salesforce Gmail extension:
a Gmail side panel that matched each message to a Contact and logged it with one click (staff
guide "Salesforce Gmail Integration", Tim Oey, rev. 2023-03-23). Tim logs every email and
cancels the ones that don't need logging, like email between staff. Salesforce retires at
the 2026-10-23 cutover, and Monday has nothing to replace that panel. The plan today is that
staff create an Activities item by hand for "significant touches" (monday-migration
`docs/06-staff-process-guide.md` §3). That takes a lot more effort than one click, so
in practice most email will go unlogged.

Salesforce also had an Email-to-Salesforce address (`EmailToSalesforce` service, monday-migration
`docs/09` §🔵). This Worker brings that back for Monday: **a staff member BCCs (or forwards) an
email to one address, and it appears on the new Activities (Logged) board, linked to the right Person.**

This is the first of two pieces. The second, a Gmail/Calendar add-on with a lookup side panel
(membership status, recent activity, add/update person), is a separate later design and is
out of scope here.

## Goals

* BCC `log@<logging domain>` on an outgoing email (new or reply) → one Activities item,
  linked to every recipient who matches a People / People (Historical) item.
* Forward a received email to the same address → one Activities item, linked to the original
  sender.
* Feedback only when something goes wrong: the staff member gets a short reply only when
  nothing could be linked or the message was rejected. A clean log stays quiet.
* Idempotent: a queue redelivery, the same message BCC'd twice, or two staff forwarding the same
  received email makes one item. *(Design call: a message that's BCC'd and then also forwarded
  may make two items. The two can't share a key, because Gmail's forwarded block has no
  Message-ID and its Date has no timezone. Staff can delete the duplicate.)*
* Same shape and conventions as the other Workers: config not hardcoding, a sandbox
  environment, queue + DLQ, least-privilege token, no email addresses in logs.

## Non-goals

* No Gmail/Chrome UI. That's the second piece.
* No mailbox sync or auto-capture of all mail. Staff choose what to log by BCCing it.
* No calendar events.
* No storing attachments. The item notes how many there were and their filenames, nothing
  more.
* No editing of People. A sender's new phone number or address is not written back.

## Anti-goals (failure even if it "works")

* **Creating People from email.** An unmatched address never creates a Person. That is the
  duplicate-person problem the dedup and email-model work spent weeks removing (monday-migration
  `docs/10`, `2026-09-08-person-org-email-model-design.md`). Unmatched means "tell the staff
  member", not "guess".
* **Linking on name alone.** Same rule as the resolver: email address or nothing.
* **Anyone on the internet writing to the CRM.** The address is guessable. Only authenticated
  SVBC staff mail may create items.
* **Email bodies or addresses at rest outside Monday.** D1 holds a hash of the Message-ID and the
  created item id, nothing personal (same rule as eventbrite-sync's ledger). Logs never contain
  an address (`scripts/check-log-safety.mjs` enforces `console.*`).
* **Logging staff-to-staff mail.** If the message has no non-staff address, nothing is written
  (this is the step Tim does by hand today).

## Constraints

* **Mail for `bikesiliconvalley.org` is Google Workspace**, so Email Routing can't take the
  apex domain's MX. The logging address lives on a **dedicated subdomain** routed through
  Cloudflare Email Routing (default: `log@log.bikesiliconvalley.org`). It must not be
  `mail.bikesiliconvalley.org`, which is the Email Sending domain. The builder confirms the
  subdomain MX/SPF records don't disturb the Workspace or Email Sending setup.
* **The Activities board is full.** The imported history fills it to the ~10,000-item Pro
  ceiling (monday-migration `docs/18` §"board limit", `docs/22` §1: 10,039 items in sandbox v2).
  `create_item` returns `Board has reached its max size` past that. Go-forward logging cannot
  target the import's board, so it writes to a new **Activities (Logged)** board (Decision 1).
* **Monday long text is ~2,000 characters** (monday-migration `docs/07`), and 46% of historical
  email bodies were longer.
* **Queue message limit is 128 KB**, so the queue carries extracted fields, not the raw message.
* Monday GraphQL goes through the canonical transport copy (`src/monday/graphql.ts`, byte-identical,
  added to the `monday-graphql-copies` CI job's list).

## How it works

```
staff Gmail ──BCC/forward──▶ log@log.bikesiliconvalley.org
   Cloudflare Email Routing ──▶ email() handler
      1. authenticate sender         (reject → setReject, no item)
      2. parse (postal-mime)
      3. classify: BCC vs forward; extract counterpart addresses
      4. drop staff-only mail        (quiet, no reply)
      5. dedupe by Message-ID hash in D1
      6. enqueue extracted fields ──▶ queue ──▶ consumer
                                              a. match addresses → People ids
                                              b. create Activities item, link People
                                              c. record item id in D1
                                              d. reply to staff only if unmatched
                                         DLQ after 3 attempts
```

### 1. Authenticating the sender

Accept a message only when all of these hold:

* the header From address is on the staff domain list in config (`bikesiliconvalley.org`), and
* the message carries a DKIM signature that **passed** for that domain, as recorded in the
  `Authentication-Results` header Cloudflare Email Routing adds (or ARC, if that's where it
  appears), and
* the From address passes an optional allowlist in config (`staffSenders`; empty = whole domain).

Anything else gets `message.setReject("…")` and no item. The builder confirms against live mail
which header Cloudflare writes and what it looks like when DKIM fails. If Cloudflare doesn't
expose a DKIM verdict at all, stop and bring that back: don't fall back to trusting From.

### 2–3. Parsing and classifying

Parse with `postal-mime` (the parser Cloudflare's Email Workers docs use).

* **BCC (default):** the staff member is the sender. Counterpart addresses = To + Cc, minus
  staff-domain addresses, minus the logging address itself.
* **Forward:** the subject starts with `Fwd:`/`FW:` *and* the body contains a forwarded-message
  header block. Gmail's `---------- Forwarded message ---------` block is the required case;
  Outlook-style and attached `message/rfc822` are nice-to-have. The counterpart is the
  forwarded block's `From:` (plus its Cc's non-staff addresses). The item's Date comes from the
  block's `Date:`, the subject has the `Fwd:` prefix removed, and the body is the forwarded
  message's text. If the subject says `Fwd:` but no block parses, treat it as a BCC whose
  counterparts are To + Cc. That will usually be empty, which triggers the unmatched reply below.

Body text: prefer `text/plain`; else strip HTML to text. Cut quoted reply history where it can be
detected reliably (Gmail `On … wrote:` line); otherwise keep it. Truncate to the configured
`bodyMaxChars` (default 1,900), ending in `… [truncated]`.

### 4. Staff-only mail

If no counterpart addresses remain, drop it quietly. Don't reply: staff will BCC these by
habit and a reply each time is noise.

### 5. Dedupe

D1 table `logged_messages(message_id_hash TEXT PRIMARY KEY, status, activity_item_id, created_at)`.
`message_id_hash` = SHA-256 of the normalized `Message-ID` header. For a forward, use the forwarded
message's Message-ID if the block has one, otherwise a hash of (original From, Date, Subject).
Insert `queued` before enqueueing; a row that already exists → stop (quiet). Rows go to
`logged` only after Monday confirms the item (the cursor-after-confirmed-write rule in the repo
`CLAUDE.md`).

### 6. Queue payload

`{ messageIdHash, kind: "bcc"|"forward", staffEmail, counterparts: string[], subject, date,
body, attachmentNames: string[] }`. This is PII in transit; it lives only in the queue, never
in D1 or logs.

### a. Matching addresses to People

**v1 (design call): exact match, ignoring case, on the email columns that exist at cutover.**
Look up each trimmed, lowercased address with `items_page_by_column_values` (as
`eventbrite-sync/src/matching/donors.ts` does) on People and People (Historical): **Personal
Email** and **Household Email** (titled Email / Secondary Email until the importer's rename;
match by column id from config, so the title doesn't matter). If the Affiliations board exists,
also look up **Work Email** and link that affiliation's Person. The builder checks live whether
Monday's lookup ignores case, and if it doesn't, tries the address as written as well as
lowercased. A household address can match more than one person; link all of them.

Not in v1: the duplicate finder's normalization (drop `+tag`, Gmail dots; monday-migration
`docs/10`) and the **Other Emails** alias list. An exact-value lookup can't find either,
because Monday stores the address as written and Other Emails is free text. Both come with the
resolver's D1 `email_index` (person-org-email design, "The resolver"), which isn't built yet.
Keep matching behind one module so switching to `email_index` later touches only that module.
Until then, an alias the person once used shows up as "unmatched" in the reply, and staff link
it by hand.

### b. The Activities (Logged) item

One item per message, whatever the number of recipients:

| Column | Value |
|---|---|
| Name | subject (or `(no subject)`) |
| Activity Type | `Email` (new label, see Board prerequisites) |
| Date | the message date (forward: the original's) |
| Status | `Done` |
| Owner | the staff member: a People-type column set to the Monday user whose email = From. If no Monday user matches, leave blank and put the address in Notes. |
| Person | connect → every matched People / People (Historical) item. *(Design call: one connect column linked to **both** boards, matching staff guide §3's "connect → People or People (Historical)", so a reclassified person keeps the link.)* The builder confirms two things live: that the target board's Person column really is set to both boards (monday-migration `docs/30` shows it linked to People only), and that a link survives `move_item_to_board`. The second is people-reclassification's pending one-item check, so run it once for both Workers. |
| Notes (long text) | body text (truncated); a footer with direction (`Sent by …` / `Received from …`), unmatched counterpart addresses, and attachment filenames |
| Message Hash | text: `message_id_hash`, for tracing an item back to its D1 row |

If none of the counterparts match, **still create the item** with an empty Person link and a
`Needs Person` status label, so the content isn't lost and staff can link it by hand. Then reply.

### d. The reply to staff

Sent via the `send_email` binding on `mail.bikesiliconvalley.org` (same as bp-feedback-notify),
only in these cases:

* **some counterparts didn't match:** "Logged '<subject>' to Monday, but these addresses aren't
  on anyone's record: …", with a link to the item. Add the address to the person (or create
  them) in Monday, then link the item.
* **nothing matched:** same, saying the item is in the `Needs Person` group/status.
* **rejected for authentication:** no reply. The rejection bounce is enough, and replying to
  unauthenticated mail is a spam vector.

A full match stays silent.

## Board prerequisites (the builder lists these in the README; nobody does them in code)

* A new **Activities (Logged)** board, in the same workspace and folder as Activities, with the
  same columns plus the ones this Worker needs: `Activity Type` with `Email`, `Call`, `Meeting`
  labels; `Status` including `Needs Person`; `Owner` as a **People** column, not the imported
  board's text Owner; `Person` connected to People and People (Historical); `Notes` (long text);
  `Message Hash` (text). Staff also log calls and meetings by hand here, so this is the one
  go-forward activity board, not just the email one. The imported Activities board stays as
  read-only history. (The Activity Type labels and the People-type Owner are monday-migration
  `docs/06` §3's pre-cutover gaps; on this board they're designed in from the start.)
* People and People (Historical) show both boards: either their Activities connect/mirror
  column links to both, or a second one is added for Activities (Logged). Pick whichever Monday
  allows for a two-way connect column; the goal is that a person's item shows old and new
  activity.
* A dedicated Monday integration user for this Worker that can read People, People (Historical),
  Affiliations, and the users list, and write only Activities (Logged). Run
  `scripts/check-monday-token-scope.mjs` against it before calling it scoped (#18).

## Config

`config/svbc.json` / `config/sandbox.json`, chosen by `env.ENVIRONMENT` (copy `member-portal`'s
`environment.ts` and split test):

* board ids: `activities-logged` (write target), `people-live`, `people-historical`, `affiliations`
* column ids for every column above, and the People/Affiliations email columns
* `staffDomains`, `staffSenders`, `loggingAddress`, `bodyMaxChars`, `replyFrom`
* `activitiesMaxItems`: when Activities (Logged) is within ~5% of it, the consumer still writes but
  also files an IT Requests item once per day (people-reclassification's warning pattern)

Sandbox: its own Email Routing address (`log-sandbox@log.bikesiliconvalley.org`), a sandbox
Activities (Logged) board and the sandbox People boards, its own D1/queues/secrets, and the `send_email` binding locked to
`sandbox@bikesiliconvalley.org`. The split test fails if the two configs share a board id or
the logging address.

## Testing (the builder's to shape; minimum)

* Fixture `.eml` files: Gmail BCC on a new message, Gmail BCC on a reply, Gmail forward,
  Outlook forward, staff-only, DKIM fail, spoofed From, HTML-only body, a 50 KB body.
* Unit: classify, extract counterparts, normalize, truncate, hash, dedupe.
* Consumer with a fake Monday client: full match, partial, none, household address → two people,
  Monday 429 → retry, board-full error → DLQ plus IT Request.
* Sandbox end to end: a real BCC from a staff Gmail account lands on the sandbox Activities (Logged) board.

## Rollout

1. Board prerequisites in the sandbox, build, deploy sandbox, verify with real Gmail.
2. After cutover: production boards, Email Routing on the production address, a one-paragraph
   staff note ("BCC log@log.bikesiliconvalley.org; forward a received email to log it") in the
   staff guide §3 and the cutover runbook's all-staff message.
3. Update staff guide §3: new activity goes on Activities (Logged), and the BCC address is
   the quick way to log a significant email. The "What to log" rule stays as it is (Decision 2).

## Decisions (SVBC, 2026-10-20)

1. **Go-forward logs go on a new Activities (Logged) board.** The imported Activities board is
   at the item ceiling and stays as history. At significant-touches volume, the new board's
   10,000-item ceiling is years away. The `activitiesMaxItems` warning is there to flag it in
   time, not because it's expected soon.
2. **"Significant touches only" stays the rule** (calls, meetings, major-gift emails; routine
   email stays in email). The BCC address makes logging a significant email cheap. It doesn't
   change what counts as significant. The reply and staff-note wording must not suggest
   BCCing everything.

## Left to the builder

Module layout, the HTML-to-text approach, the exact reply wording, quoted-history trimming rules,
retry tuning, and whether the forward parser handles more than Gmail's format in v1.
