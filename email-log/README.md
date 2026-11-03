# email-log

**Status:** Built (2026-10-20; design:
[`docs/superpowers/specs/2026-10-19-email-log-design.md`](../docs/superpowers/specs/2026-10-19-email-log-design.md))
— **sandbox deployed 2026-11-02** (`svbc-email-log-sandbox`, `log-sandbox@log.bikesiliconvalley.org`;
a staff BCC logged end to end); **production live 2026-11-03** (`svbc-email-log`,
`log@log.bikesiliconvalley.org`, writes on; a staff BCC logged end to end, see "Production
bring-up"). The sandbox still owes the forgery check (step 5) and steps 6 to 10 (see "Sandbox
bring-up"), and the staff note isn't written yet.
**Priority:** Post-cutover, non-blocking. It replaces the Salesforce Gmail extension's one-click
email logging.
**Stack:** TypeScript + D1 + Cloudflare Queues + Email Routing (an `email()` handler; there is no
HTTP route).

## The ask

Before cutover, staff logged email to Salesforce with the Gmail side panel. Salesforce retires at
the 2026-10-23 cutover and Monday has no equivalent. This Worker brings back the old
Email-to-Salesforce address: **BCC an email you sent, or forward one you received, to one address,
and it becomes an item on the Activities (Logged) board, linked to the right Person.**

What it is not: a mailbox sync (staff choose what to log), a Gmail UI (a separate, later design),
or a way to create People. An address that matches nobody is reported, never turned into a Person,
and a name alone never links anything.

## Staff use

Log **significant touches only**: the same rule as the staff guide's "What to log". The address
makes logging one significant email cheap; it does not change what counts as significant. Routine
email stays in email.

* **An email you send:** BCC `log@log.bikesiliconvalley.org` on it (a new message or a reply).
  Don't put the address in To or Cc.
* **An email you received:** forward it to the same address.
* You'll only hear back if something didn't match: a short reply listing addresses that aren't on
  anyone's record, with a link to the item. Add the address to the right person in Monday (or
  create the person), then link the item to them. If nobody matched, the item's Status is
  `Needs Person`. If no outside address could be read from the email at all (for example a
  forward the Worker couldn't parse), the reply says so and the item is `Needs Person`: open it
  and link the person by hand. You'll also hear back if the item couldn't be written after
  several tries.
* A clean log is silent. Mail with no one outside SVBC on it (staff to staff) is dropped without
  a reply.

If you BCC and also forward the same email, you may get two items; delete the extra one.

## Data flow

```
staff Gmail ──BCC/forward──▶ log@log.bikesiliconvalley.org
   Cloudflare Email Routing ──▶ email() handler
      1. too large (maxRawBytes) or unparseable → setReject
      2. authenticate the sender (staff From domain + DKIM aligned to it) → else setReject
      3. classify: BCC vs Gmail/Apple Mail forward; pick the counterpart addresses
      4. no non-staff counterpart (plain BCC) → drop quietly
      5. claim the Message-ID hash in D1 (already there → stop quietly)
      6. enqueue the extracted fields ──▶ queue ──▶ consumer
                                                    a. adopt an existing item with this hash, else
                                                    b. match each address to People
                                                    c. create the Activities (Logged) item
                                                    d. mark the D1 row `logged`
                                                    e. reply to the staff member if any address
                                                       was unmatched, or none was found
                                             retries (1, 4, 16 min) → dead-letter consumer
```

* **BCC:** the staff member is the sender. Counterparts are To + Cc, minus staff-domain addresses
  and the logging address, lowercased and deduped. A colleague on Cc or the logging address in To
  is ignored; the message is still logged against the external recipients.
* **Forward:** the subject starts with `Fwd:`/`FW:` and the body holds a forward header block:
  Gmail's `---------- Forwarded message ---------` or Apple Mail's (macOS, iOS)
  `Begin forwarded message:`, whose block and forwarded text are usually `> `-quoted (the quoting
  on the marker line is removed from what follows). The first block in the body wins. The
  counterpart is the block's `From:` plus its non-staff Cc's (if the forwarded message was one
  the staff member sent, the block's To + Cc instead). The item takes the block's `Date:`, the subject without `Fwd:`, and the
  forwarded message's text. Gmail's `Date:` has no zone and is read in `mail.forwardTimeZone`;
  Apple's names its own (`PST`, `PDT`, `GMT+2`, …), which wins, and only a zoneless one falls
  back to `mail.forwardTimeZone`. Outlook's `From:`/`Sent:` block isn't parsed.
* **Body:** `text/plain`, else HTML stripped to text. Quoted history is cut at Gmail's
  `On … wrote:` line. Truncated to `mail.bodyMaxChars` (1,900), ending `… [truncated]`.
* **Dedupe:** D1 `logged_messages` is keyed on the SHA-256 of the Message-ID (a forward uses the
  forwarded message's Message-ID, else a hash of original From + Date + Subject; a message with no
  Message-ID falls back to From + Date + Subject). A row is claimed `queued` before enqueueing and
  becomes `logged` only after Monday confirms the item. D1 holds the hash, status, kind and item
  id, never an address, subject or body. The queue payload is the only copy outside Monday.
* **The item** (one per message): Name = subject (cut to 255 characters; `(no subject)` if
  empty), Activity Type = `Email`, Date, Status = `Done` (or `Needs Person` when nothing
  matched), Owner = the Monday user whose email is the sender's (left blank if none; the address
  then goes in Notes), Person = every matched People / People (Historical) item, Notes = body plus
  a footer (direction, unmatched addresses, attachment filenames; each list shows its first 10,
  then `+N more`, and Notes as a whole is cut to 2,000 characters), Message Hash = the dedupe
  hash. Inline images the HTML shows in place (signature logos) aren't listed as attachments.
* **If nothing matched, the item is still created**, with an empty Person link and `Needs Person`.

## Matching

One module (`src/matching/people.ts`). Each lowercased address is looked up exactly with
`items_page_by_column_values` on:

* People: the two email columns in `matching.peopleEmailColumns` (Personal Email, Household Email);
* People (Historical): `matching.historicalEmailColumns`;
* Affiliations: `matching.affiliationsWorkEmailColumn`, then the affiliation's Person via
  `matching.affiliationsPersonColumn` (skipped when the Affiliations board id or either column
  is `null`).

A household address can match more than one person; all are linked. Columns are matched by id, so
their titles don't matter. Lookups are sequential to spare Monday's complexity budget.

## Config and secrets

`config/svbc.json` (production) and `config/sandbox.json`, chosen at request time by
`env.ENVIRONMENT` (`src/environment.ts`), validated once per isolate (`src/config.ts`).
Production (`svbc.json`) ships placeholders throughout: `null` boards, `REPLACE_WITH_COLUMN_ID`
columns and `REPLACE_WITH_AUTHSERV_ID`. The sandbox (`sandbox.json`) already has the CRM
Sandbox's real People, People (Historical) and Affiliations board and matching column ids; only
the Activities (Logged) board and its `activities.*` columns, and `mail.trustedAuthServId`, are
still unset until the board and live mail exist.

| Key | What |
|---|---|
| `monday.boards` | `activities-logged` (write target), `people-live`, `people-historical`, `affiliations`; `null` = not configured |
| `activities.*Column` | column ids on Activities (Logged): activity type, date, status, owner, person, notes, message hash |
| `activities.activityTypeLabel`, `doneLabel`, `needsPersonLabel` | status/label text written (`Email`, `Done`, `Needs Person`) |
| `matching.*` | email column ids on People, People (Historical), and Affiliations (Work Email + Person link) |
| `mail.loggingAddress` | the address staff BCC; must not be on a staff domain |
| `mail.staffDomains` | exact domain match; subdomains are not staff |
| `mail.staffSenders` | optional allowlist of addresses; `[]` = the whole staff domain |
| `mail.trustedAuthServId` | authserv-id of the `Authentication-Results` header to trust (see below) |
| `mail.bodyMaxChars`, `maxRawBytes`, `forwardTimeZone` | body cut (200-1950), message size cap, zone for forwarded `Date:` lines that carry none (Gmail's) |
| `mail.replyFrom` | sender of replies (`noreply@mail.bikesiliconvalley.org`) |
| `capacity.activitiesMaxItems`, `warnPct` | board ceiling and the percentage at which the consumer files a capacity alert |
| `alerts.itRequests` | IT Requests board id, type column id, label, and `cooldownDays`; `null` disables alerts |

* **Monday access:** from the `monday-auth` broker, not a stored token. Both deployments bind
  `MONDAY_AUTH` (`wrangler.jsonc` `services`) to its `SyncToken` entrypoint — the *SVBC Staff Sync*
  OAuth app — production (`svbc-email-log`) to `svbc-monday-auth`, sandbox (`--env sandbox`) to
  `svbc-monday-auth-sandbox`; `src/monday/graphql.ts` `tokenProviderFor` asks it per request and
  re-asks once on a 401. No secrets: a `MONDAY_API_TOKEN` secret is only the fallback while the
  cutover is under way (delete it once the binding works). With neither, every message fails
  (building the Monday client throws a config error naming both) and dead-letters. Local `wrangler
  dev` has no broker to call, so put a `MONDAY_API_TOKEN` in `.dev.vars` for it. Design:
  `docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md`.
* **Vars:** `ENVIRONMENT` (`sandbox` in `env.sandbox`; unset = production) and `SANDBOX_EMAIL_SINK`
  (sandbox only). In the sandbox every reply goes to the sink address, and the `send_email`
  binding is locked to it at the platform (`allowed_destination_addresses`). A missing sink
  fails closed.
* The split test (`config/split.test.ts`) fails if the two configs share a board id or the
  logging address.

## Monday API

Standard Monday GraphQL through the canonical transport copy `src/monday/graphql.ts`
(byte-identical to `monday-backup`'s; the `monday-graphql-copies` CI job enforces it). The Worker
reads People, People (Historical), Affiliations and the users list, and writes Activities (Logged)
plus, if alerts are on, IT Requests. Use a dedicated integration user and run
`node ../scripts/check-monday-token-scope.mjs --workspace <id>` before calling the token scoped.

## Prerequisites (board work nobody has done)

Copied from the spec. None of this is done in code.

* A new **Activities (Logged)** board, in the same workspace and folder as Activities, with the
  same columns plus the ones this Worker needs: `Activity Type` with `Email`, `Call`, `Meeting`
  labels; `Status` including `Needs Person`; `Owner` as a **People** column, not the imported
  board's text Owner; `Person` connected to People and People (Historical); `Notes` (long text);
  `Message Hash` (text). Staff also log calls and meetings by hand here, so this is the one
  go-forward activity board. The imported Activities board stays as read-only history (it sits
  at the item ceiling, which is why this board exists).
* People and People (Historical) show both boards: either their Activities connect/mirror column
  links to both, or a second one is added for Activities (Logged). Pick whichever Monday allows
  for a two-way connect column; the goal is that a person's item shows old and new activity.
* A dedicated Monday integration user for this Worker that can read People, People (Historical),
  Affiliations, and the users list, and write only Activities (Logged) (and IT Requests, if
  `alerts.itRequests` is set). Run `scripts/check-monday-token-scope.mjs` against it before
  calling it scoped (#18).
* Email Routing on a dedicated subdomain (`log.bikesiliconvalley.org`). `bikesiliconvalley.org`
  mail is Google Workspace, so Email Routing can't take the apex MX; and it must not be
  `mail.bikesiliconvalley.org`, which is the Email Sending domain.

## Sandbox bring-up

Do these in order. Steps 5 to 9 are live checks: the answer decides config or code.

1. **Board.** Create the sandbox Activities (Logged) board with the columns above. Connect Person
   to both People boards. Put the board id in `monday.boards.activities-logged` and the column
   ids in `activities.*` in `config/sandbox.json`. While any is a placeholder the consumer
   refuses to write and the message dead-letters. The consumer's log line on each attempt names
   the missing key (`config: activities.<key> is not configured`); the D1 row's error ends up as
   `dead-lettered after retries`. A new board is private: subscribe the integration user
   (Sandbox Integration in the sandbox, SVBC Integration in production) or every create fails
   with `User unauthorized to perform action` and retries. Optionally set
   `alerts.itRequests` (board id, **column id** for `typeColumn`, label, `cooldownDays`).
2. **D1 and queues.** `wrangler d1 create svbc-email-log-sandbox`, paste the id into
   `wrangler.jsonc` `env.sandbox.d1_databases[0].database_id`, then
   `npx wrangler d1 migrations apply svbc-email-log-sandbox --env sandbox --remote`. Create the
   queues `email-log-writes-sandbox` and `email-log-writes-sandbox-dlq`. (Production later:
   `svbc-email-log`, `email-log-writes`, `email-log-writes-dlq`.)
3. **Monday access.** Confirm the sandbox broker's Staff Sync app is consented
   (`svbc-monday-auth-sandbox`); the `MONDAY_AUTH` binding needs no secret here.
4. **Email Routing.** Enable Email Routing on `log.bikesiliconvalley.org`. Confirm the Workspace
   MX records on the apex and the Email Sending records on `mail.` are untouched. Route
   `log-sandbox@log.bikesiliconvalley.org` to the Worker `svbc-email-log-sandbox`. Deploy with
   `npm run deploy:sandbox`.
5. **Live check: authserv-id.** Send one BCC from a staff Gmail account. Read the
   `Authentication-Results` header the Worker sees (temporarily log the header *names* and the
   authserv-id only, never addresses, then remove the logging). Set `mail.trustedAuthServId` in
   `config/sandbox.json` and redeploy. **If there is no DKIM verdict in the header, stop and
   report back** (spec section 1); don't fall back to trusting From.
   *Done 2026-11-02:* one header, authserv-id `mx.cloudflare.net`, with
   `dkim=pass header.d=bikesiliconvalley.org` (Gmail's own verdict arrives separately as
   `ARC-Authentication-Results`, which the parser ignores). Production uses the same id.

   **Then the forgery check.** From an outside (non-staff) account, send *unsigned* mail to the
   sandbox address with a staff `From:` and a forged
   `Authentication-Results: <trusted-id>; dkim=pass header.d=bikesiliconvalley.org` header (the
   real authserv-id you just set). Cloudflare should add its own header with that id on top,
   making two, which the parser rejects. Confirm the message is rejected. **If Cloudflare does not
   add its own `Authentication-Results` header to unsigned mail, stop and report back before going
   live:** the parser's single-header rule is then forgeable.
6. **Live check: email lookup case.** Does `items_page_by_column_values` on an email column
   ignore case? The Worker looks up lowercased addresses. If Monday's lookup is case-sensitive,
   record that here and open an issue: a person stored with a mixed-case address shows as
   unmatched until the resolver's `email_index` exists.
7. **Live check: Person link across a move.** Does a Person link survive `move_item_to_board`
   between People and People (Historical)? Do this once, shared with people-reclassification's
   pending check, and record the answer in both READMEs.
8. **Live check: board-full error text.** Confirm Monday's full-board error reaches the consumer
   containing `Board has reached its max size` after `graphql.ts` wraps it. If not, update the
   `BOARD_FULL` match in `src/consumer/processBatch.ts`.
9. **Live check: handler failure.** When `email()` throws (a `queue.send` failure), what does the
   sending server see: a temporary failure it retries, or a bounce? The code assumes a temporary
   failure (it rethrows after marking the row `failed`).
10. **End to end**, from the spec's Testing section: a BCC, a forward, a staff-only message
    (dropped, no item), a message to an unmatched address (item with `Needs Person`, plus the
    reply to the sink), and a duplicate (the same message again makes no second item).

## Production bring-up

Started 2026-11-03, post-cutover.

1. **Config — done.** `config/svbc.json` points at the production boards: Activities (Logged)
   18438042551, People 18437909781, People (Historical) 18437909784, Affiliations 18437909787,
   with their column ids. Activities (Logged) already existed with the sandbox board's columns
   (plus a `Topic` tag column the Worker doesn't write), Person connected to both People boards,
   and SVBC Integration subscribed. `mail.trustedAuthServId` is `mx.cloudflare.net`, the id the
   sandbox found in step 5. `alerts.itRequests` files to IT Requests (8846215481, Type
   `status_11` = `IT Support`) with a one-day cooldown per alert kind.
2. **D1 and queues — done.** D1 `svbc-email-log` (`5e2475bd-…`, migration 0001 applied) and the
   queues `email-log-writes` and `email-log-writes-dlq`.
3. **Monday access.** Nothing to set: `MONDAY_AUTH` binds `svbc-monday-auth`, whose Staff Sync app
   is already consented for the other production Workers.
4. **Write switch — done 2026-11-03:** `node scripts/flags.mjs email-log writes on --env production`
   (run from the repo root). Missing means off, and an off Worker dry-runs every message.
5. **Deploy — done 2026-11-03:** `cd email-log && npx wrangler deploy --env=""` (version
   `4198adc6`).
6. **Email Routing — done 2026-11-03:** on `log.bikesiliconvalley.org`, the rule
   `log@log.bikesiliconvalley.org` → Worker `svbc-email-log` is active. The route can only be
   created once the Worker exists, so it comes after the deploy.
7. **Smoke test — done 2026-11-03.** One staff BCC to `log@` went through: D1 row `logged` 12 s
   after receipt, and an Activities (Logged) item with Activity Type `Email`, Owner the sender and
   the Message Hash set. The recipient was a personal address not on any People record, so the item
   is `Needs Person` with the address in Notes, which is correct. A second BCC, to an address on
   a People record, logged as `Done` with Person linked to that People item, so the matched path
   works in production too.
8. **Staff note:** one paragraph in the staff guide (significant touches only).

The sandbox's forgery check (step 5) and steps 6 to 10 are still owed. They test the code, not the
deployment, so they apply to production as they stand; until the forgery check is done, keep the
`log@` address internal.

## Failures and alerts

* A failed consumer attempt retries on the shared backoff (1 minute doubling to an hour) up to 100
  times, about four days, then goes to the dead-letter queue.
  The dead-letter consumer marks the row `failed`, tells the staff member to try again, and raises
  a `dead-letter` IT Requests item. Nothing is re-driven from the queue: the staff member
  re-sends.
* Capacity: when Activities (Logged) holds `warnPct` percent of `activitiesMaxItems`, the
  consumer still writes and raises a `capacity` alert. A "Board has reached its max size" error
  raises `board-full`.
  `activitiesMaxItems` is 100,000 in both configs: SVBC's Monday board limit, the `items_limit`
  Monday reports (decided 2026-11-03; it was 10,000, which would have raised a false `capacity`
  alert at 9,500 items).
* Each alert kind has a per-kind cooldown (`alerts.itRequests.cooldownDays`), tracked in D1.
* Logs carry an outcome and the first 12 hex chars of the hash as a correlation id, never an
  address, subject or body (`node ../scripts/check-log-safety.mjs`).

## Deploying: the write switch

Every Monday create (the Activity item and the IT Requests alerts), every staff reply
(`sendUnmatched`, `sendNoAddress`, `sendNotLogged` from the main consumer) and every D1 write the
consumer makes (`markLogged`, `recordError`, `recordAlert`) is gated by the shared write switch
(spec `../docs/superpowers/specs/2026-10-26-write-switch-design.md`, module `src/flags.ts`, a
byte-identical copy of `member-portal/src/flags.ts`; the dry-run deps are `src/writeSwitch.ts`),
read from the `FLAGS` KV namespace (`wrangler.jsonc`; the ids are placeholders until the
namespaces exist):

- `email-log:writes` — `on` writes normally; `hold` writes nothing and keeps messages on the queue
  (retrying at 1 minute doubling to an hour); `off` runs the consumer against recording proxies,
  logging one `"writeSwitch":"skipped"` line per would-be write and acking. **A missing key means
  `off`**; a KV read error behaves like hold.
- `email-log:log` — `debug` adds redacted payloads to those lines (names, addresses and subjects
  masked, body as a length).

The inbound `email()` handler keeps authenticating, deduping and enqueuing in every mode (and
`setReject` for oversize or unauthenticated mail stays live). Under `off` it stamps the message
dropped, so it is never written even if the switch is `on` by the time it is consumed, and closes
the ledger row out as `failed` (error `dropped: write switch off`) — `claim` re-opens only
`failed` rows, so the staff member's re-send after the switch is on is logged instead of being
swallowed as a duplicate. A dry run does the same for a message it consumes. Nothing re-enqueues
ledger rows automatically (no cron), so a dropped row is never revived. A message queued before
this build has no stamp and is written under `on`. The dead-letter consumer, its staff reply and
its IT alert run in every mode. The main queue retries 100 times before dead-lettering. Set the
switch with the operator CLI at the repo root, never by hand — `writes hold`/`on` also pauses and
resumes the queue:

```sh
node scripts/flags.mjs email-log writes on --env sandbox     # or --env production
node scripts/flags.mjs status --env sandbox
```

**Set `writes on` before deploying** a build that carries the switch, or the deployed Worker
dry-runs everything.

## Known limits and threat model

* **Authentication is domain-level DKIM with From alignment.** A message is accepted only if its
  From domain is exactly an entry in `mail.staffDomains` and a passing DKIM result in
  Cloudflare's `Authentication-Results` header names that same domain (`header.d`). Only the
  single header whose authserv-id equals `mail.trustedAuthServId` is read; headers an outsider
  adds with other ids are ignored. Until the placeholder is replaced (bring-up step 5), every
  message is rejected (fail closed).
* **Replay.** Any genuine staff-signed message an outsider holds can be re-sent to the logging
  address and passes, and so can mail from a third-party service allowed to sign as
  `d=bikesiliconvalley.org` (for example a Mailchimp custom DKIM). Message-ID dedupe limits
  repeats. Don't hand out the logging address publicly.
* **Availability over acceptance.** An unparseable `Authentication-Results` header, or a second
  header claiming the trusted authserv-id, rejects otherwise-legitimate mail.
* **A forward whose `Fwd:` block doesn't parse** is still logged, as a BCC with the To + Cc
  counterparts, never dropped. That list is usually empty, so the result is a `Needs Person` item
  with no Person link, and the staff member gets the "no outside address was found" reply with
  the item link.
  Gmail and Apple Mail blocks parse; Outlook's doesn't, nor does a forward sent as HTML only (the
  block is read from `text/plain`, which both Gmail and Apple Mail always include; stripped HTML
  runs Apple's header lines together). An Apple `Date:` with a zone abbreviation outside North
  America (other than `GMT`/`UTC` or a `GMT±h` offset) leaves the item on the forward's own date,
  and that date then feeds the dedupe hash, so two forwards of that message aren't caught.
* **Create succeeded, D1 `markLogged` failed.** The retry finds the item by its Message Hash and
  adopts it; no reply to staff is sent for that message.
* **A row can stay `queued`** if the isolate dies between claiming the hash and enqueueing. The
  sender's retry then looks like a duplicate and is dropped. Rare; accepted for v1.
* **One IT item can stand for many events.** Dead-letter, capacity and board-full alerts each have
  a per-kind cooldown; the logs have every event.
* **Attachments are never stored.** Only their filenames appear in Notes.
* **Matching is exact** (lowercased) on Personal/Household Email (People, People (Historical)) and
  Affiliations Work Email. There is no `+tag` or Gmail-dot normalization and no Other Emails
  aliases until the resolver's `email_index` exists; an alias shows up as unmatched and staff link
  it by hand.
* A message BCC'd and then also forwarded may make two items (a forward has no shared key with the
  original). Staff delete the duplicate.
* **Resolved 2026-11-03: keep the separate Activities (Logged) board.** Production already has it
  (18438042551), staff-subscribed and connected to both People boards, so the Worker writes there.
  The original question, kept for the record: **is a separate Activities (Logged) board still needed?** The design
  (Constraints, Decision 1) sends go-forward logs to a new board because the imported Activities
  board was "full" at a ~10,000-item ceiling. SVBC's real limit is 100,000 (decided 2026-11-03),
  so the imported board (about 10,000 items) has room for years of significant-touch logging.
  Writing to Activities itself would put all activity on one board. Keeping Activities (Logged)
  keeps imported history apart from new entries. Nothing has changed yet: the Worker still
  writes only `monday.boards.activities-logged`. SVBC to decide before production bring-up.

## Commands

```sh
npm test                 # vitest run (needs the sandbox off: workerd binds a local port)
npm run typecheck        # wrangler types && tsc --noEmit
npm run deploy:sandbox   # wrangler deploy --env sandbox
npm run deploy           # production
```
