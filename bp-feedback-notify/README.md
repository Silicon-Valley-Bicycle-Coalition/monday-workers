# bp-feedback-notify

**Staff UAT script:** [`docs/uat/bp-feedback-notify.md`](../docs/uat/bp-feedback-notify.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

Emails a Bike Parking event's organizer the Organizer Feedback Form link once SVBC staff marks
the event ready for it. Closes the gap documented in `monday-migration`'s `migration-plan.md`
("Organizer Feedback Form" section): the form itself asks the right questions, but nothing ever
pointed an organizer at it.

## The ask

`BP Request Form` (the intake board for booked events) has no signal for "this event happened,
send the organizer their feedback survey." This Worker turns a monday.com automation into that
signal: staff flips a status column, monday calls this Worker's webhook, the organizer gets an
email with the feedback form link.

## Data flow

1. Staff sets an event item's `Post-Event Feedback` status column to `Ready to Send` on
   `BP Request Form`.
2. A monday.com board automation ("Send a webhook") POSTs to
   `POST /webhook/bp-feedback?secret=<WEBHOOK_SECRET>` — monday's webhook action has no custom
   header field, only a URL, so the shared secret rides in the query string (the Worker also
   accepts `X-Webhook-Secret` as a header, for any future caller that can set one). The Worker
   reads only `itemId` from the body:
   ```json
   { "itemId": 13089808285 }
   ```
   Whatever else the automation sends (`itemName`, `eventName`, `organizerEmail`) is ignored.
   Before [GL#66](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/66) the Worker trusted those fields, so anyone holding the URL secret could send
   SVBC-branded mail to any address with any subject.
3. Before monday sends real traffic, it verifies the URL by POSTing `{"challenge": "<token>"}`
   once and expecting that same body echoed back — the Worker handles this ahead of normal
   payload validation.
4. The Worker validates the secret and the item id. It then reads the item from Monday
   (`config/*.json` `board`): the organizer's address from `Preferred Email Address For
   Coordination` (`short_text3z8szxke`), and the event name from `Event Name`
   (`short_textdqu5gf2d`), or the item name if that's blank. It refuses an item that isn't on the
   configured board (404, nothing sent, nothing written back) and an item with no single valid
   address (422, `Send Failed` written back when `sendStatus` is set). A failed Monday read
   answers 502 so monday retries. Control characters in the event name are collapsed to a space
   before it reaches the Subject.
5. It sends the organizer an email with the feedback form link via Cloudflare Email Sending.

The sandbox config uses the production board's column ids, on the assumption that the sandbox
mirror was duplicated from the live board (monday keeps column ids on duplicate). Not verified:
the tokens available when [GL#66](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/66) was fixed couldn't see the sandbox board. If a sandbox send logs
`bp-feedback-no-email` for an item that has an address, check the ids with `get_board_info`.

No queue here (unlike `funraise-sync`/`quickbooks-sync`): a missed reminder email is low-stakes
compared to a dropped donation write, so a synchronous send-on-receipt is enough. D1 holds only the
per-item resend guard below.

### Resend guard ([GL#105](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/105))

Anyone holding `WEBHOOK_SECRET` could otherwise loop the endpoint over every BP Request item id
and re-email every organizer. So before sending, the Worker claims the item in D1 (`DB`, table
`sends`, `migrations/0001_create_sends.sql`; `src/sendGuard.ts`): an item emailed within
`resendCooldownHours` (`config/*.json`, 24) gets a 200 `{ "sent": false, "alreadySent": true }`
and a `bp-feedback-resend-cooldown` log line, and nothing is sent. The claim is one atomic upsert,
so two concurrent webhooks for an item can't both send. A failed send deletes its own claim, so
monday's retry still goes out. If D1 can't be read (or the binding or table is missing) the Worker
sends nothing and answers 503, so monday retries: it fails closed.

To allow a re-send inside the cooldown (say an organizer lost the email), an engineer deletes the
row: `wrangler d1 execute svbc-bp-feedback-notify --remote --command "DELETE FROM sends WHERE
item_id = <itemId>"` (`svbc-bp-feedback-notify-sandbox` and `--env sandbox` for the sandbox).

Setup, once per environment, before the first deploy that carries the guard:

```sh
cd bp-feedback-notify
wrangler d1 create svbc-bp-feedback-notify                  # paste the id into wrangler.jsonc
wrangler d1 create svbc-bp-feedback-notify-sandbox          # paste into env.sandbox
wrangler d1 migrations apply svbc-bp-feedback-notify --remote
wrangler d1 migrations apply svbc-bp-feedback-notify-sandbox --remote --env sandbox
```

Without a `database_id`, `wrangler deploy` auto-provisions a database by that name, but it doesn't
apply migrations; every send answers 503 until they're applied.

## Monday automation setup

On the target board (production: `BP Request Form`, id `18395469629`; prototyped and confirmed
working end-to-end on its sandbox mirror `BP Request Form (sandbox)`, id `18431960612`, in the
`Bike Parking Forms (sandbox)` workspace). Per the project convention of never writing directly to
live SVBC boards from an agent session, these steps are for a human with write access (Zachary
Kearsley, the live board's owner, or an account admin) to apply manually — verified against the
sandbox mirror's actual live config on 2026-09-21, not just described generically:

1. **Deploy the Worker to production first** — the webhook URL in step 3 doesn't exist until this
   runs, and monday's connection handshake will fail against a URL that isn't live yet:
   ```sh
   cd bp-feedback-notify
   wrangler secret put WEBHOOK_SECRET   # generate with: openssl rand -hex 32
   npm run deploy
   ```
   This deploys to `https://svbc-bp-feedback-notify.svbc-account.workers.dev` (same `*.workers.dev`
   pattern as this repo's other webhook-only Workers — see Open questions below, no custom route
   needed).
2. Add a status column named exactly `Post-Event Feedback`, with these labels in this order
   (matches the sandbox mirror's live config exactly):

   | Label | Color |
   |---|---|
   | `Not Yet` (default) | orange |
   | `Ready to Send` | blue |
   | `Sent to Organizer` | green |
3. In the board's Automation Center → Create → search "webhook" → use the template "When a
   status changes to something, send a webhook" (monday's natural-language automation-creation
   API could not resolve this action by name — two different phrasings both matched an unrelated
   *inbound* webhook trigger block instead. It only worked by building it directly in the UI).
   Use the template: "Create from scratch" has no webhook action. The template first asks for an
   account connection, which here means the webhook URL: choose "Use another account" and paste it.
   Trigger: `Post-Event Feedback` → `Ready to Send`. Webhook URL:
   `https://svbc-bp-feedback-notify.svbc-account.workers.dev/webhook/bp-feedback?secret=<the WEBHOOK_SECRET from step 1>`
   (there's no header field, hence the secret in the query string — see Data flow above). monday
   verifies the URL with a one-off `{"challenge": "..."}` POST before accepting the connection —
   the Worker already handles that ahead of normal payload validation.
4. Staff sets the column back to `Sent to Organizer` once they've confirmed delivery — manual
   unless the optional status write-back below is configured.

### Optional: write Sent/Failed back to the item

Every send is logged (`bp-feedback-sent` / `bp-feedback-send-failed`, with the item id, in
Workers observability), but staff only watch the board, so a failed send is otherwise invisible
to them — the webhook just gets a 500. To surface it, `sendStatus` is set in
`config/production.json` (the sandbox's `config/sandbox.json` keeps it `null`; set it there,
pointing at the sandbox mirror board, to test). Its shape:

```json
"sendStatus": {
  "boardId": "18395469629",
  "columnId": "<the Post-Event Feedback column's id>",
  "sentLabel": "Sent to Organizer",
  "failedLabel": "Send Failed"
}
```

(it uses the same Monday access as the item read; see Secrets). After each send the Worker sets that status
column to `sentLabel` or `failedLabel` via `change_simple_column_value` — in the background
(`waitUntil`, 10-second timeout) after the webhook has been answered, so a slow Monday API can't
push the response past monday's timeout and trigger a retry (a duplicate email). Add the `failedLabel`
(e.g. `Send Failed`, red) to the column first — Monday rejects an unknown label, and the Worker
only logs that rejection. Writing `Sent to Organizer` onto the same `Post-Event Feedback` column
doesn't re-fire the automation, which triggers only on `Ready to Send`; staff re-trigger a
failed send by setting it back to `Ready to Send`. A write-back failure is logged and never
fails the webhook (the email already went out).

**Status-column resend check ([GL#105](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/105)):** with `sendStatus` set, the item read also fetches that
status column and the Worker skips the send (200, `{ "sent": false, "alreadySent": true }`,
`bp-feedback-already-sent`) when it already reads `sentLabel`. Staff re-send by moving the column
back to `Ready to Send`, though the D1 cooldown (see "Resend guard" above) still applies. A failed
send never writes `sent`, so a genuine retry still goes through.

Confirmed on the sandbox board on 2026-09-21: the connection's challenge handshake succeeded, and
a real status-change fired the webhook end-to-end (verified via `wrangler tail`). The only
remaining failure at that point was the organizer email send itself, blocked on the Cloudflare
destination-address verification described below — the monday → Worker leg is solid. The sandbox
board's two other automations (an internal notify-me and a broken Gmail send, both left over from
earlier prototyping) are disabled — nothing there worth replicating on the live board.

## Secrets

```sh
wrangler secret put WEBHOOK_SECRET               # production
wrangler secret put WEBHOOK_SECRET --env sandbox  # sandbox
```

Generate with e.g. `openssl rand -hex 32`. Anyone with this value can trigger a feedback email to
the organizer on any BP Request Form item, so treat it like a password, not a config value.

Monday access is required: every send reads the item from the board, and the same access does the
optional status write-back (see "Optional: write Sent/Failed back to the item"). It comes from the
`monday-auth` broker, not a stored token: both deployments bind `MONDAY_AUTH` (`wrangler.jsonc`
`services`) to its `SyncToken` entrypoint — the *SVBC Staff Sync* OAuth app — production to
`svbc-monday-auth`, sandbox to `svbc-monday-auth-sandbox`. This Worker carries no transport copy, so
`src/mondayApi.ts` has its own `tokenProviderFor`: it asks the broker per request and re-asks once
on a 401, as the shared `graphql.ts` does. A `MONDAY_API_TOKEN` secret is only the fallback while
the cutover is under way (delete it once the binding works); with neither, the Worker logs
`bp-feedback-misconfigured`, answers 500 and sends nothing. Local `wrangler dev` has no broker to
call, so put a `MONDAY_API_TOKEN` in `.dev.vars` for it. Design:
`docs/superpowers/specs/2026-10-30-monday-oauth-broker-design.md`.

Because monday's webhook action can only carry the secret in the URL (see Data flow above), it
appears in this Worker's Cloudflare access logs (Logpush, `wrangler tail`) on every request.
Restrict who can read those logs the same way you'd restrict who holds `WEBHOOK_SECRET` itself,
and rotate the secret if that access ever widens.

## Write switch

The `FLAGS` KV key `bp-feedback-notify:writes` (`on` | `hold` | `off`; missing or unrecognized means
`off`) gates the send. The challenge echo is always live. `off` logs a masked skip line and answers
200 without sending or writing status back. `hold`, or a KV read error, answers **503**: this Worker
has no queue, so Monday's own webhook retries are the only retry. Monday gives up after its retry
window, so a feedback request fired mid-migration may need re-triggering by hand once the key is
back to `on`. Set the key with `node scripts/flags.mjs`; `<worker>:log` = `debug` adds masked
payloads to skip lines.

## Sandbox environment

Same convention as `member-portal`: `wrangler deploy --env sandbox` deploys
`svbc-bp-feedback-notify-sandbox`, whose `EMAIL` binding can only deliver to
`sandbox@bikesiliconvalley.org` (Cloudflare-enforced via `allowed_destination_addresses`, plus a
code-layer rewrite in `src/email/sandboxBinding.ts` — see that file's comment). `config/sandbox.json`
holds the sandbox Organizer Feedback Form's real URL; `config/production.json`'s
`feedbackFormUrl` now points at the real, live Organizer Feedback Form
(`https://forms.monday.com/forms/4a5ce8f0e00550987dffbcf96280094e`, confirmed live 2026-09-20 —
its questions and welcome/success copy are already organizer-specific; only the browser-tab title
and some dead board columns are still cosmetically wrong, see `migration-plan.md`). That cosmetic
cleanup doesn't block this Worker functionally, and production went live on 2026-11-03 (see Open
questions below).

**Confirmed working end-to-end as of 2026-09-21.** Sends to `sandbox@bikesiliconvalley.org` had
initially failed with `destination address is not a verified address` — Cloudflare requires every
`send_email` destination to be added and verified once, per account, before any Worker can deliver
to it (Compute → Email Service → Email Routing → Destination Addresses in the dashboard, which
emails a verification link to the address itself). Added and verified; a real monday automation
run (not just a direct curl call) was then confirmed landing via `wrangler tail`. This was an
account-level prerequisite, not per-Worker config — it also unblocks `member-portal`'s own sandbox
email testing, which hadn't hit it yet.

**Workers Builds:** connect a second Worker, `svbc-bp-feedback-notify-sandbox`, to this repo with
root directory `/bp-feedback-notify`, production branch `main`, and deploy command
`npx wrangler deploy --env sandbox`. The sandbox then tracks `main` alongside production. If the
dashboard refuses two connections on one root directory, fall back to the
`deploy-sandbox` job in `../.github/workflows/workers.yml` — same command, gated on a
`CLOUDFLARE_API_TOKEN` `sandbox` environment secret so it stays inert until that secret is set.

## Commands

```sh
npm install
npm test
npm run typecheck
npm run dev           # wrangler dev — local Worker, no real email sends without a send_email
                       # domain configured locally; see wrangler docs for local email testing
npm run dev:sandbox
npm run deploy:sandbox
npm run deploy         # production: live, and goes straight to real organizers
```

## Open questions

- ~~`workers_dev: true` is a placeholder route~~ — resolved (2026-09-21): this is the established
  pattern for secret-authenticated, webhook-only Workers in this repo (`funraise-sync`,
  `quickbooks-sync`, `mailchimp-sync`, `donation-rollups`, `benevity-import` all take webhook
  traffic on their default `*.workers.dev` URL with no custom route — access control is the
  shared secret, not domain trust). No route to add here.
- ~~Production `feedbackFormUrl` is a placeholder~~ — resolved (2026-09-20): points at the real
  live form now (see Sandbox environment section above for the URL and what's still cosmetically
  pending on the board itself).
- ~~To go live in production~~ — done (2026-11-03): the Worker is deployed with
  `bp-feedback-notify:writes` = `on`, the live board has the `Post-Event Feedback` column
  (`color_mm8rtt99`), and the webhook automation is on, its handshake answered 200. Still open: no
  real item has gone through it yet, so a production email is unconfirmed, and staff need telling
  about the 24-hour resend cooldown. Since 2026-11-14 (D1 resend guard deployed, `sendStatus` set)
  the Worker writes `Sent to Organizer` back itself; the column still needs a `Send Failed` label
  before a failed send can show. Changing the board's structure
  takes board ownership; the `+` column button is simply dead without it.
