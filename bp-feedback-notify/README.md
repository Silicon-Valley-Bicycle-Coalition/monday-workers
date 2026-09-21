# bp-feedback-notify

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
   `POST /webhook/bp-feedback` with a shared secret header and a body shaped like:
   ```json
   {
     "itemId": 13089808285,
     "itemName": "Fall Festival — BP Request Form item name",
     "eventName": "Fall Festival",
     "organizerEmail": "organizer@example.org"
   }
   ```
   (`itemName` and `eventName` are usually the same text — monday exposes both because the
   automation fills them from different sources; only `eventName` is used in the email copy.)
3. The Worker validates the secret and payload, then sends the organizer an email with the
   feedback form link via Cloudflare Email Sending.

No D1/queue here (unlike `funraise-sync`/`quickbooks-sync`) — a missed or duplicate reminder
email is low-stakes compared to a dropped donation write, so a synchronous send-on-receipt is
enough. If that stops being true (e.g. monday retries webhooks and duplicate emails become a real
annoyance), add the dedupe-then-queue shape documented in the parent `CLAUDE.md`'s Architecture
section.

## Monday automation setup

On the target board (production: `BP Request Form`, id `18395469629`; prototyped on its sandbox
mirror `BP Request Form (sandbox)`, id `18431960612`, in the `Bike Parking Forms (sandbox)`
workspace):

1. Add a status column named `Post-Event Feedback` with labels `Not Yet` / `Ready to Send` /
   `Sent to Organizer` (already added on the sandbox mirror).
2. Create an automation: "When status changes to `Ready to Send`, send a webhook to
   `https://<this-worker's-domain>/webhook/bp-feedback`" with:
   - Header `X-Webhook-Secret: <WEBHOOK_SECRET>` (see Secrets below)
   - Body mapped to the JSON shape above — `itemId`/`itemName` from the trigger item, `eventName`
     from the `Event Name` column, `organizerEmail` from `Preferred Email Address For
     Coordination`.
3. Staff sets the column back to `Sent to Organizer` once they've confirmed delivery (manual for
   now — the Worker doesn't write back to monday).

**Known gap:** as of 2026-09-21 this repo's monday.com connection couldn't confirm the "Send a
webhook" action is configured with custom headers/body mapping via the API — it was validated by
reading the automation-builder's block schema, not by creating one live. Confirm header/body
support in the monday UI before wiring this up for real, and adjust the payload contract above
(and `src/webhook.ts`) if monday's webhook action shapes the body differently than assumed.

## Secrets

```sh
wrangler secret put WEBHOOK_SECRET               # production
wrangler secret put WEBHOOK_SECRET --env sandbox  # sandbox
```

Generate with e.g. `openssl rand -hex 32`. Anyone with this value can trigger an email send, so
treat it like a password, not a config value.

## Sandbox environment

Same convention as `donor-portal`: `wrangler deploy --env sandbox` deploys
`svbc-bp-feedback-notify-sandbox`, whose `EMAIL` binding can only deliver to
`sandbox@bikesiliconvalley.org` (Cloudflare-enforced via `allowed_destination_addresses`, plus a
code-layer rewrite in `src/email/sandboxBinding.ts` — see that file's comment). `config/sandbox.json`
holds the sandbox Organizer Feedback Form's real URL; `config/production.json`'s
`feedbackFormUrl` is a placeholder until the production Organizer Feedback Form's title/column
cleanup (see `migration-plan.md`) is actually applied by someone with write access to it.

## Commands

```sh
npm install
npm test
npm run typecheck
npm run dev           # wrangler dev — local Worker, no real email sends without a send_email
                       # domain configured locally; see wrangler docs for local email testing
npm run dev:sandbox
npm run deploy:sandbox
npm run deploy         # do not run until config/production.json's feedbackFormUrl is real
```

## Open questions

- Confirm the "Send a webhook" automation action really supports custom headers and a mapped JSON
  body the way this README assumes (see "Known gap" above).
- `workers_dev: true` is a placeholder route — pick a real subdomain/route before production use,
  matching how other Workers in this repo are routed.
- Production `feedbackFormUrl` needs the real Organizer Feedback Form fixed (title + dead columns
  — see `migration-plan.md`) before this Worker can be deployed to production for real.
