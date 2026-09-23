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
   `POST /webhook/bp-feedback?secret=<WEBHOOK_SECRET>` — monday's webhook action has no custom
   header field, only a URL, so the shared secret rides in the query string (the Worker also
   accepts `X-Webhook-Secret` as a header, for any future caller that can set one) — with a body
   shaped like:
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
3. Before monday sends real traffic, it verifies the URL by POSTing `{"challenge": "<token>"}`
   once and expecting that same body echoed back — the Worker handles this ahead of normal
   payload validation.
4. The Worker validates the secret and payload, then sends the organizer an email with the
   feedback form link via Cloudflare Email Sending.

No D1/queue here (unlike `funraise-sync`/`quickbooks-sync`) — a missed or duplicate reminder
email is low-stakes compared to a dropped donation write, so a synchronous send-on-receipt is
enough. If that stops being true (e.g. monday retries webhooks and duplicate emails become a real
annoyance), add the dedupe-then-queue shape documented in the parent `CLAUDE.md`'s Architecture
section.

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
   Trigger: `Post-Event Feedback` → `Ready to Send`. Webhook URL:
   `https://svbc-bp-feedback-notify.svbc-account.workers.dev/webhook/bp-feedback?secret=<the WEBHOOK_SECRET from step 1>`
   (there's no header field, hence the secret in the query string — see Data flow above). monday
   verifies the URL with a one-off `{"challenge": "..."}` POST before accepting the connection —
   the Worker already handles that ahead of normal payload validation.
4. Staff sets the column back to `Sent to Organizer` once they've confirmed delivery (manual for
   now — the Worker doesn't write back to monday).

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

Generate with e.g. `openssl rand -hex 32`. Anyone with this value can trigger an email send, so
treat it like a password, not a config value.

Because monday's webhook action can only carry the secret in the URL (see Data flow above), it
appears in this Worker's Cloudflare access logs (Logpush, `wrangler tail`) on every request.
Restrict who can read those logs the same way you'd restrict who holds `WEBHOOK_SECRET` itself,
and rotate the secret if that access ever widens.

## Sandbox environment

Same convention as `donor-portal`: `wrangler deploy --env sandbox` deploys
`svbc-bp-feedback-notify-sandbox`, whose `EMAIL` binding can only deliver to
`sandbox@bikesiliconvalley.org` (Cloudflare-enforced via `allowed_destination_addresses`, plus a
code-layer rewrite in `src/email/sandboxBinding.ts` — see that file's comment). `config/sandbox.json`
holds the sandbox Organizer Feedback Form's real URL; `config/production.json`'s
`feedbackFormUrl` now points at the real, live Organizer Feedback Form
(`https://forms.monday.com/forms/4a5ce8f0e00550987dffbcf96280094e`, confirmed live 2026-09-20 —
its questions and welcome/success copy are already organizer-specific; only the browser-tab title
and some dead board columns are still cosmetically wrong, see `migration-plan.md`). That cosmetic
cleanup doesn't block this Worker functionally, but production deploy is still gated on the two
items in Open Questions below.

**Confirmed working end-to-end as of 2026-09-21.** Sends to `sandbox@bikesiliconvalley.org` had
initially failed with `destination address is not a verified address` — Cloudflare requires every
`send_email` destination to be added and verified once, per account, before any Worker can deliver
to it (Compute → Email Service → Email Routing → Destination Addresses in the dashboard, which
emails a verification link to the address itself). Added and verified; a real monday automation
run (not just a direct curl call) was then confirmed landing via `wrangler tail`. This was an
account-level prerequisite, not per-Worker config — it also unblocks `donor-portal`'s own sandbox
email testing, which hadn't hit it yet.

**Workers Builds:** connect a second Worker, `svbc-bp-feedback-notify-sandbox`, to this repo with
root directory `/bp-feedback-notify`, production branch `main`, and deploy command
`npx wrangler deploy --env sandbox`. The sandbox then tracks `main` alongside production. If the
dashboard refuses two connections on one root directory, fall back to the
`deploy-sandbox:bp-feedback-notify` job in `../.gitlab-ci.yml` — same command, gated on a
`CLOUDFLARE_API_TOKEN` CI variable so it stays inert until that variable is set.

## Commands

```sh
npm install
npm test
npm run typecheck
npm run dev           # wrangler dev — local Worker, no real email sends without a send_email
                       # domain configured locally; see wrangler docs for local email testing
npm run dev:sandbox
npm run deploy:sandbox
npm run deploy         # do not run until the Open Questions below are resolved
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
- To go live in production: follow the four steps in Monday automation setup above (deploy,
  add the column, wire the webhook automation, hand off the manual "mark sent" step to staff).
  Nobody's done this yet — it needs a human with write access to the live board.
