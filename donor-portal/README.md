# donor-portal

**Status:** Live — v1 deployed (login + read-only donation history and member discounts). v2 in
development.
**Priority:** Post-migration, non-blocking on the October cutover.
**Owner:** Unassigned.
**Stack:** Hono + TypeScript, D1 (tokens/sessions and queued change requests — Monday stays the
system of record for donor data).

## The ask

Let donors log in themselves to see their own donation history and their membership benefits —
specifically, discounts at local bike shops. Everything else in this plan is staff-facing; this is
the first donor-facing surface.

## Why this is a different kind of build than everything else here

Every other Worker in this plan sits inside SVBC's own trust boundary — staff, volunteers, board
members, already on Slack/Google Workspace. This one is public-facing, handles another person's
financial history, and needs a real login. Treat it with the caution that implies: read-only, no
password storage, tightly scoped data access, and two things deliberately **cut from v1** rather
than silently assumed in:

* **Tax-deductibility receipts.** Showing a donor their own giving history is not the same
  document as an IRS-compliant annual acknowledgment letter. Monday has no receipting primitive
  (same gap noted in the Funraise Option B/C discussion in the plan) and generating compliant tax
  documents is real compliance surface this build doesn't take on. **Decided 2026-08-21: scoped
  as its own separate deliverable** (likely a Workers cron generating year-end letters from the
  Donations board — see the plan's Post-Migration Follow-ups). Say so explicitly in the UI copy
  so donors don't mistake this portal for a tax document.
* **Editing their own info.** Read-only, for the same rollback-safety reason
  `workers/salesforce-import` never writes back to Salesforce. A self-service edit path needs its
  own scope (validation, an audit trail, a staff review step) and shouldn't ride along with "let
  them see their data."

## Blocking precondition — resolved

**Resolved 2026-08-21: the minimal Status/Tier slice is confirmed stable to build against**, ahead
of the full renewal-workflow design. The original reasoning, kept for context:

**The Membership board needs a Status and a Tier field before this can be built at all** —
"membership benefits" is meaningless without knowing whether someone's membership is current and
which tier they're in. Per
`docs/06-staff-process-guide.md` (private planning repo) §8, **no Membership
board design exists yet**, full stop. This Worker needs only that minimal two-field slice, not the
full renewal-workflow design (what triggers a reminder, what "lapsed" means operationally) — but
that slice is a real prerequisite, not a nice-to-have. Don't let this Worker's existence pressure
that design into being rushed; if the minimal slice isn't stable, wait.

## Localization

The portal is available in English plus nine languages (see `src/i18n/locales.ts` for the full
list). A donor's preferred language is read from a **Preferred Language** dropdown column on the
Donors board — add it with these exact option labels (staff-facing, matching what
`src/i18n/locales.ts`'s `LOCALE_LABELS` expects): English, Spanish, Chinese (Simplified), Chinese
(Traditional), Filipino, Hindi, Japanese, Korean, Portuguese (Brazil), Vietnamese. Until that
column exists (or for a donor with nothing set), the portal falls back to whatever the pre-login
page guessed from the browser's language and a cookie.

Translations are AI-drafted without a separate human review pass — a deliberate, approved
tradeoff. The tax letter's own acknowledgment text stays English-only regardless of locale (see
`letterViews.ts`); only its surrounding page chrome is translated.

**Gated on `monday.columns.preferredLanguage`:** add the Preferred Language column above, then
fill in its column id in `config/svbc.json` (same treatment as v2's `donorAddress`/`donorPhone`
and v3's `membershipExpiry`) — until it's set to a real Monday column id, a donor's stored
preference is never read, and every donor falls back to the pre-login browser/cookie guess
described above, even after staff pick a value in the dropdown.

## Data flow

```
Donor visits the portal (a subdomain, e.g. portal.bikesiliconvalley.org), enters their email
  ▼
Cloudflare Worker (Hono + TypeScript, D1 for tokens/sessions)
  │  looks up the email against the Donors board via Monday's GraphQL API
  │  generates a signed, single-use token (short expiry — e.g. 15 min) and stores it in D1
  │  emails a magic link containing the token
  ▼
Donor clicks the link
  │  Worker verifies the token against D1 (single-use — invalidate on first use), issues a
  │  signed, httpOnly session cookie
  ▼
Portal renders, server-side (Hono — no SPA framework needed for a page this small), reading
live from Monday, scoped only to the authenticated Donor's own item id (never client-supplied):
  │  • Donations connected to this Donor → history list + running total (the existing
  │    $ Donated mirror column already computes this)
  │  • Membership Status/Tier on this Donor → matching Organizations tagged
  │    Discount Active = true → their discount terms
  ▼
Nothing is written back to Monday at any point.
```

## Auth: passwordless email magic link, not username/password

SVBC has no reason to store donor passwords — pure breach liability with no offsetting benefit at
this scale, and one more credential for a donor to forget. A donor enters their email; if it
matches a Donors-board item, they get a login link; if it doesn't, show the same "check your email"
message either way (don't reveal whether an address is in the system — an email-enumeration
guard). No account-creation step, nothing to reset.

**Decided (2026-08-21): one email matching multiple Donor items → show all matches, explicitly
labeled.** Households and couples share email addresses, and dedup analysis proved collisions
exist in this data. The portal renders each matched person's history under its own name header —
people sharing an inbox already receive each other's receipts, and explicit labeling prevents
silent misattribution. Never fall into the accidental default (first match wins), which can show
one family member another's giving history unlabeled.

**Cloudflare Access (Zero Trust) was considered and ruled out for this specific use.** It's the
right fit for gating small internal tools to a handful of staff — its free tier caps at 50 users —
but this needs to serve every donor with an email on file, not a small team. Custom magic-link auth
is the correct scope match here, not a shortcut around a better-fit product.

**Rate-limit login requests** (per email and per IP) to blunt abuse of the email-sending step —
this is the one place this Worker can be used to spam an inbox if left unguarded.

## Sending the email

**Do not use Cloudflare's old free MailChannels-Workers integration — it's dead.** MailChannels
ended free sending for Workers on 2024-08-31; any tutorial or example referencing it predates that
and will not work.

**Sent via [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/)** — the
native `send_email` Workers binding (`env.EMAIL`, see `src/email/cloudflareEmail.ts`), not a
third-party API. No API key to manage: Cloudflare auto-configures SPF/DKIM when the sending domain
is onboarded, and delivery/bounce/suppression handling is built in. This Worker previously used
Resend; that integration was replaced before first deploy (see `src/email/cloudflareEmail.ts` and
its predecessor's git history), consolidating onto Cloudflare rather than running two vendors for
one low-volume transactional need (a few hundred to low-thousands of donor logins, nowhere near any
sending quota).

A dedicated sending subdomain (`mail.bikesiliconvalley.org`) with its own SPF/DKIM/DMARC records,
kept separate from the main domain's mail flow, is standard practice for transactional email — see
`DEPLOY.md` Phase 3 for the onboarding steps.

## Data model dependencies

* **Membership Status + Tier** on the Donors board (or a linked Membership board, once designed) —
  blocking precondition above.
* **Discount Offered (text) + Discount Active (checkbox)** on the Organizations board (proposed,
  not yet built — see `docs/06-staff-process-guide.md` §1). Extends the existing partner-type
  cleanup rather than requiring a new board: the Data Inventory section of the plan already found
  `Outdoor Shop` as an existing, if stale, picklist value on Account, confirming bike shops are
  already modeled as Organizations, just not consistently tagged for this yet.
* **Donations board's existing Donor connection and $ Donated mirror** — already live, no changes
  needed; see `docs/06-staff-process-guide.md` §2.

## Security notes

* Session and magic-link tokens: signed, single-use for the magic link, short expiry, stored in D1
  keyed to a hash of the token (not the raw token) so a D1 read doesn't itself leak a usable
  credential.
* Session cookies get an explicit server-side TTL too (hours to low days, not indefinite) —
  sessions live in D1, so expiry and logout are server-enforced, not cookie-only.
* The Worker's Monday API token comes from a dedicated integration user with access to only the
  boards this portal reads (Donors, Donations, Membership, Organizations) — never a staff member's
  personal token, which would make this public-facing Worker a door to the whole workspace. See
  `../README.md`'s least-privilege-token note.
* Every data read is scoped server-side to the authenticated session's Donor item id — the portal
  never accepts a donor-id or email as a client-supplied parameter for "whose data to show."
* HTTPS only, on its own subdomain, separate from any staff-facing tooling.
* No permanent duplicate of donation records in D1 — read live from Monday (or cache with a short
  TTL, e.g. a few minutes, purely for rate-limit headroom against Monday's API), so Monday stays
  the single place donation data actually lives.

## v2 — Year-end tax letters and change requests

Design: `../docs/superpowers/specs/2026-08-24-donor-portal-v2-design.md`. Two independent,
config-gated features:

* **Tax letters** (`GET /:locale/portal/letters`, `GET /:locale/portal/letters/:donorItemId/:year`): a
  consolidated per-year giving letter rendered live from the Donations board as HTML with print
  CSS — the browser's Print → Save as PDF is the delivery mechanism; nothing is generated or
  stored server-side. Only completed calendar years with at least one donation get a letter.
  **Gated on `taxLetter` config:** every string in it ships as `REPLACE_AFTER_SIGNOFF` and the
  feature shows a friendly "not available yet" state until SVBC signs off on the IRS
  acknowledgment language (both the plain no-goods-or-services statement and the
  benefit/quid-pro-quo variant used for tiers listed in `taxLetter.benefitTiers`) and an
  operator fills in the real wording.
* **Change requests** (`GET`/`POST /:locale/portal/change-request`): a donor submits a new address,
  email, or phone; the Worker records it in D1 (dedupe window:
  `changeRequests.dedupeWindowHours`) and a queue consumer creates an item on a staff-owned
  Change Requests board (donor link, field, old value, new value, submitted-at). Staff apply
  approved changes to the Donors board by hand — the portal never writes donor records.
  **Gated on `changeRequests.boardId`** plus its column ids and the `donorAddress`/`donorPhone`
  Donors-board column ids in config.

Operator setup for v2, in addition to the v1 steps: create the Change Requests board (five
columns: connect-boards to Donors, three text, one date) and fill in
`changeRequests.boardId`/`columns`; fill in `monday.columns.donorAddress` and
`monday.columns.donorPhone`; grant the portal's integration user **write access to the Change
Requests board only**; create the `donor-portal-change-requests` queue and its
`donor-portal-change-requests-dlq` dead-letter queue before deploying; apply D1 migration
`0002_create_change_requests.sql`; and, once the letter language is signed off, replace every
`REPLACE_AFTER_SIGNOFF` in `taxLetter`.

## v2.1 — Staff-triggered letter-ready emails

Design: `../docs/superpowers/specs/2026-08-24-donor-letter-emails-design.md`. A Button column on
the Donors board lets staff email a donor a "your letter is ready" notification — a magic link to
the portal home, not the letter content itself. Always sends the most recently completed year with
gifts; a donor+year is only ever sent once (tracked in the `letter_sends` D1 table). Inert until
`taxLetter` is signed off, same as the portal-facing letters.

**The automatic January cron this eventually enables is not built yet** — this ships the send
primitive (`POST /webhooks/monday/letters` → `donor-portal-letter-emails` queue →
`processLetterSendBatch`) that a scheduled trigger can reuse later without rework.

Operator setup, in addition to v1/v2 steps:

1. Add a Button column ("Send Giving Letter") to the Donors board.
2. Create a Monday automation recipe on that board: "When button column changes → Send a webhook
   to `https://<worker-domain>/webhooks/monday/letters?secret=<LETTER_WEBHOOK_SECRET>`". This is
   the locked-in trigger design (see the design spec's Decisions) — a raw Webhooks-API subscription
   on the button column's `change_specific_column_value` event does **not** work here, since Button
   columns are action triggers with no persisted value, so that event likely never fires for a
   button click. The automation recipe is the supported path for "button clicked → webhook".
   **Verify the exact automation payload shape against a real delivery before relying on it in
   production** — this could not be confirmed from a development session without live Monday
   access.
3. Set the `LETTER_WEBHOOK_SECRET` Worker secret (`wrangler secret put LETTER_WEBHOOK_SECRET`) —
   must match the `secret` query param used in the webhook URL above.
4. Create the `donor-portal-letter-emails` queue and its `donor-portal-letter-emails-dlq` dead-letter
   queue before deploying (`wrangler queues create donor-portal-letter-emails` and
   `wrangler queues create donor-portal-letter-emails-dlq`).
5. Apply D1 migration `0004_create_letter_sends.sql`.

## v2.2 — Communication preferences

From [IT Requests #12893526579](https://bikesiliconvalley.monday.com/boards/8846215481/pulses/12893526579).
A "Communication preferences" section on the existing change-request page lets a donor set three
preferences — **Email Opt-Out**, **SMS Opt-Out**, and **Do Not Mail** — flowing through the same
staff-review write path as the free-text change requests (the portal still never writes donor
records; staff apply approved changes by hand). The form shows the current state read live from
the Donors board and submits a diff: only preferences that actually changed become change
requests, with fixed staff-facing values ("Opted out of email" / "Subscribed to email", "Opted
out of SMS" / "Subscribed to SMS", "Do not mail" / "OK to mail") rather than free text.

Two compliance notes baked into the design:

* **The staff-review path is deliberate, not a shortcut.** Mailchimp is SVBC's real system of
  record for email consent (see the private planning repo's Mailchimp reconciliation item), so
  the portal must not flip opt-out flags directly; a queued request staff reconcile by hand is
  also comfortably within CAN-SPAM's 10-business-day window for honoring opt-outs.
* **Email Opt-Out maps to the compliance-critical `HasOptedOutOfEmail` migration column**
  (`docs/03-monday-migration-mapping.md`, private planning repo). Do Not Mail maps to Salesforce's
  `Do_Not_Mail__c`. SMS Opt-Out is net-new — Salesforce has no per-contact SMS consent field — so
  its column starts empty for every donor.

**Gated per column on `monday.columns.donorEmailOptOut` / `donorSmsOptOut` / `donorDoNotMail`:**
each preference appears on the form only once its Donors-board **checkbox** column id is filled in
(same treatment as `preferredLanguage`), so staff can roll out one preference at a time. With none
configured, the section is absent entirely. The change-request board/queue prerequisites are the
v2 setup above — no new board, queue, migration, or secret.

Operator setup, in addition to the v2 steps: add up to three checkbox columns (Email Opt-Out,
SMS Opt-Out, Do Not Mail) to the Donors board and fill in their ids in `config/svbc.json`. At
migration cutover, Email Opt-Out and Do Not Mail carry over from Salesforce per the mapping doc;
verify consent state against Mailchimp before trusting migrated opt-out flags (compliance item in
`docs/09-integrations-and-addons.md`).

## v3 — Digital membership card

Design: `../docs/superpowers/specs/2026-08-24-digital-membership-card-design.md`. A donor views a
live card (`GET /:locale/portal/card/:donorItemId`) — name, member number, tier, status, expiry — with a
QR code and a plain-text link to a public verify page (`GET /verify/:token`) that always fetches
current status live from Monday, never from whatever was true when the card was viewed or
scanned. iOS 27 donors can self-serve the card into Apple Wallet via the OS's own "Create a Pass"
camera-scan feature — no Apple Developer account or signing infrastructure on our side. Android
has no equivalent yet, so Android donors use the web card directly.

**`GET /verify/:token` is public and unauthenticated by design** — unlike every other `/portal/*`
route, it requires no session cookie, since the whole point is that a bike shop clerk (or anyone
who scans the QR code) can check a card's validity without logging in as the donor. It serves the
donor's name, member number, tier, status, and expiry to anyone holding the token. Protection comes
from the token being an unguessable, revocable secret (rather than the donor's login), IP rate
limiting (`deps.ipLimiter`), and the `cardEnabled` kill switch, not from authentication — treat the
verify link with the same care as the card itself.

**Gated on `monday.columns.membershipExpiry`:** the whole feature shows a "not available yet"
state until that column is set to a real Monday column id (same treatment as v2's
`donorAddress`/`donorPhone`). If a card's link ever leaks, the donor can invalidate it and get a
fresh one any time from `/:locale/portal/card/:donorItemId` ("Regenerate card").

Operator setup for v3, in addition to the v1/v2 steps: add a Membership Expiry (date) column to
the Donors board and fill in `monday.columns.membershipExpiry`; apply D1 migration
`0003_create_card_tokens.sql`. No new Monday write access, no new queue, no new secret.

**Revoked tokens don't linger:** the daily retention cron (same one that purges `change_requests`
— see `src/index.ts`'s `scheduled` handler) also deletes `card_tokens` rows past
`cardTokens.retentionDays` once `revoked_at` is set — a revoked token is a dead bearer credential
for donor PII with no purpose once superseded. Active tokens (`revoked_at IS NULL`) are never
touched, regardless of age.

## v3.1 — Funraise deep links (recurring gifts & membership renewal)

From the v2 brainstorm's candidate list (IT Requests item "Donor portal: recurring-gift
management / membership renewal deep links"). The portal's "Manage your giving" section links
donors out to **Funraise's own donor-account surface** (to change or cancel a recurring gift) and
to a **Funraise checkout page** (to renew a membership). Deliberately links, not embedded flows:
every payment interaction happens on Funraise's PCI-scoped pages, so this Worker never touches
card data — "build" here means two `<a>` tags and nothing more. Changes a donor makes on Funraise
flow back into Monday via `workers/funraise-sync`, so the portal reflects them on the next visit
after the sync lands (the section's UI copy says so).

**Gated per link on `funraise.*` config:** each of `funraise.manageRecurringUrl` and
`funraise.renewMembershipUrl` renders only when set to a real URL — while a value is still the
`REPLACE_WITH_FUNRAISE_URL` placeholder (or empty), that link is silently omitted, and with
neither configured the whole section disappears (same gate-not-error treatment as the
`taxLetter` sign-off fields). A set value must be an `https://` URL or config validation fails at
startup — a typo'd link should fail a deploy, not a donor.

Operator setup: `funraise.manageRecurringUrl` ships pre-filled with
`https://give.funraise.org/login` — Funraise's donor portal is a shared surface, not
org-specific, and donors sign in there with the same email they donated with (the address they
already used for this portal's magic link). `funraise.renewMembershipUrl` needs a hosted
Giving Page link, format `https://funraise.org/give/Silicon-Valley-Bicycle-Coalition/:id`
(copy it from the Funraise form editor: **Giving Forms → open form → Publish tab → Page** — it's
not in the dashboard). **Blocked as of 2026-08-25: no active membership giving form exists** —
other drives are active, but the two forms embedded on bikesiliconvalley.org (33777, 35786) have
no published giving page (both 404 at that URL), so which form renewal should point at is a
staff decision, tracked on the IT Requests item. Until it's made, the placeholder stays and the
renewal link simply doesn't render. When a URL does land, prefill parameters can be appended,
e.g. `?x_frequency=y&x_amount=35` for an annual $35 membership; use the full Page link, not the
Bitly Short URL, which drops query parameters. No new Monday access, no new secret, no D1
migration.

## v4 — Pledge tracking + employer matching gifts

Scoped from the [IT Requests board item](https://bikesiliconvalley.monday.com/boards/8846215481/pulses/12893527597)
("Donor portal: pledge tracking / employer matching-gift lookup"). Two independent, config-gated
features, both read-only — no new D1 tables, queues, secrets, or Monday write access.

* **Pledge tracking** (`GET /:locale/portal/pledges`): a per-donor list of pledges rendered live
  from a Pledges board — pledge name, pledged amount, fulfilled amount, computed percent
  complete (shown as a dash when either amount doesn't parse as a number; overpayment caps at
  100%), status, and due date. Scoped to the session's own donor item ids like every other
  portal read. **Gated on `pledges.boardId` + its five column ids** — no Pledges board exists in
  the migration design yet (same situation the Change Requests board was in before v2), so the
  page shows a "not available yet" state until staff design one and an operator fills in the
  config. The board needs: a connect-boards column to Donors, two number/formula columns
  (pledged and fulfilled amounts — a mirror of linked payments works, anything whose text
  renders a number), a status column, and a date column.
* **Employer matching-gift lookup** (`GET /:locale/portal/matching-gifts`): always renders —
  generic "ask your HR team whether gifts are matched" guidance is useful with no vendor at
  all, plus SVBC's EIN once `taxLetter.ein` is signed off. **The embedded Double the Donation
  employer-search widget is gated on `matchingGifts.doubleTheDonationPublicKey`** (null until
  SVBC buys a DTD subscription, which it currently has not — the board item notes this was
  "discussed, not prioritized"). This is the only portal page that may load third-party
  JavaScript, so it deliberately renders **zero donor PII** and ships the app's only
  Content-Security-Policy — the load-bearing directive is `connect-src` excluding `'self'`, so
  a compromised widget script can't fetch sibling `/portal` pages (which carry the session
  cookie on same-origin requests) and exfiltrate donor data. Keep both properties; the embed
  shape carries a verify-before-deploy NOTE in `src/matchingGifts/matchingGiftViews.ts`, since
  it couldn't be checked against a live DTD account — verify the widget under the CSP at the
  same time. No Subresource Integrity hash on the DTD script by their design (mutable
  unversioned URL); the PII-free page plus the CSP are the compensating controls.

**Upgrading an existing deployment (forks included):** config validation requires the
`pledges` and `matchingGifts` stanzas to *exist* before v4 code will serve any request — a
config predating v4 fails validation on every request, queue batch, and cron run, not just on
the new pages. Copy both stanzas from this repo's `config/svbc.json` (placeholder/null values
are fine; both features then ship gated off) before deploying v4 code over an older config.

Operator setup for v4, in addition to the v1 steps — each feature independently optional:

1. Pledges: create the Pledges board, grant the portal's integration user **read** access to
   it, and fill in `pledges.boardId` and all five `pledges.columns` ids in `config/svbc.json`.
2. Matching gifts: obtain a Double the Donation subscription, then set
   `matchingGifts.doubleTheDonationPublicKey` to the **public** plugin key (never a private API
   key — this value is served to every logged-in browser), after verifying the embed snippet
   against DTD's current docs.

## Future candidates

The candidate list from the v2 brainstorm (discussed 2026-08-24) is no longer tracked here —
each un-built idea is filed as a Feature Request on the
[IT Requests board](https://bikesiliconvalley.monday.com/boards/8846215481) ("Donor portal: …"
items). None are scheduled; each needs its own scoping pass before build.

**Considered and ruled out:** peer-to-peer fundraising pages and DAF tooling (Funraise's job;
heavy build, low value at SVBC's scale), and full self-serve profile editing (the review-queue
model won for rollback safety and audit trail — revisit direct writes only if the queue proves
pure overhead). Two standing architecture decisions to preserve: letters render live from
Monday (no stored PDFs to go stale after a data correction), and Cloudflare Access stays ruled
out for donor auth (free tier caps at 50 users; magic-link auth is the scope match).

## Sources

* `migration-plan.md` (private planning repo) — Integrations: Donor self-service portal
* `docs/06-staff-process-guide.md` (private planning repo) §§1, 2, 8
* [Cloudflare Email Service docs](https://developers.cloudflare.com/email-service/)
* [MailChannels — End of Life Notice (Cloudflare Workers free integration)](https://support.mailchannels.com/hc/en-us/articles/26814255454093-End-of-Life-Notice-Cloudflare-Workers)
