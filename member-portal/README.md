# member-portal

**Staff UAT script:** [`docs/uat/member-portal.md`](../docs/uat/member-portal.md) — what a non-technical tester can try in the sandbox and what they should see. Keep it in step with this README.

**Status:** Production config filled 2026-11-02 (813261b: People, Donations, Organizations and
Volunteers ids from the Donors & Contacts workspace, 18201685), and the Change Requests and
letter boards (`changeRequests`, `letterCron`) are filled too. `svbc-member-portal` and
`svbc-member-portal-writer` are deployed in production (checked 2026-11-19). Still placeholders in
`config/svbc.json`, each a feature gate rather than a deploy blocker: `preferredLanguage`, the
email/SMS opt-out columns, `eventRegistrations`, `pledges`, `taxLetter.benefitStatement` and
`funraise.renewMembershipUrl`. Code-complete through v8 (the
sections below); the first production deploy follows [DEPLOY.md](DEPLOY.md) and the root
[production deploy checklist](../docs/production-deploy-checklist.md). The sandbox environment is
live at `member.sandbox.bikesiliconvalley.org` (see "Sending the email"). Donation history is
date-gated (see "v7 — Clean-start donation history"): hidden until 2027-01-01, and from then on
showing only gifts dated 2026-01-01 or later.
**Priority:** Post-migration, non-blocking on the October cutover.
**Owner:** David (decided 2026-10-09).
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
Donor visits the portal (a subdomain, e.g. member.bikesiliconvalley.org), enters their email
  ▼
Cloudflare Worker (Hono + TypeScript, D1 for tokens/sessions)
  │  looks up the email against the Donors board via Monday's GraphQL API
  │  generates a random, single-use token (short expiry — 15 min) and stores its SHA-256 in D1
  │  emails a magic link containing the token
  ▼
Donor clicks the link
  │  GET only renders a "Continue to your portal" button (no script, no auto-submit) — mail
  │  scanners (Safe Links, Mimecast, Proofpoint) prefetch links, and a consuming GET burned
  │  the token before the donor arrived (issue #31)
  ▼
Donor presses the button (a same-origin POST, CSRF-checked like every other form)
  │  Worker verifies the token against D1 (single-use — invalidate on first use), issues an
  │  opaque random session token in an httpOnly, Secure, SameSite=Lax cookie
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

## Portal layout: member card and tabs

Every signed-in page shares one frame (`src/home/homeView.ts`): each person's member card with
their totals (Total given, Hours volunteered, Member since), the status line with at most one gold
button, then a tab bar. Tabs are links, one page each, with `aria-current` on the active one; on
a phone they wrap as pills. A small script (`src/assets/portalTabs.ts`, served as a hashed
same-origin asset) fetches the clicked tab's page and swaps in its panel and tab bar, so the page
never scrolls on a tab click; Back and Forward work the same way. Without the script, or on any
unexpected response, the link loads normally and its `#tabs` fragment lands on the tab bar. Design history: the card-first home with "doors"
(`docs/superpowers/specs/2026-11-18-member-portal-home-design.md`) became this tabbed layout on
2026-11-19.

The frame's loader (`src/home/loadHomeData.ts`) runs on every tab and reads membership, donations
(only once `historyVisibleFromISO` has passed, so Total given stays hidden until then), completed
volunteer shifts (when volunteer history is configured), the discount list, card tokens and, from
Jan 1 to `home.taxLetterUntil`, last year's letter. Benefits, Your giving and Volunteering render
from that read; Events and Profile add their own. A total that isn't available is left off the
card rather than shown as zero.

**States** (`src/home/homeState.ts`, a pure resolver; highest first). Each person gets one; the
page shows the highest any person holds, and its button.

| State | When | Button |
|---|---|---|
| Tax letter | a letter exists for last year and today (Pacific) is on or before `home.taxLetterUntil` (`04-15`) | Your giving, `#tax-letters` |
| Renew | Lapsed, or Member Until already past (the card then greys out and reads "Ended MM/YYYY"); or never a member (no status, no tier); or the membership ends within `home.renewalWarningDays` (30) days. Lifetime never renews, whatever its status | Funraise renewal link (the donate page until `funraise.renewMembershipUrl` is set) |
| New member | Member Type is New and Member Since is within `home.newMemberDays` (60) days | Benefits, `#discounts` |
| Default | anything else | none |

**Tabs**, each behind the session; a signed-out visit returns to the tab after sign-in. For a
household each tab groups by person.

| Tab | Path | Shows | Shown when | Old paths that land here |
|---|---|---|---|---|
| Benefits | `/:locale/portal` | discount list, "Regenerate card" per card, organizations the session manages | always | `/portal/card`, `/portal/card/:id` |
| Your giving | `/:locale/portal/giving` | history and total (behind `historyVisibleFromISO`; until then a note gives that date), impact, tax letters (`#tax-letters`, while letters are enabled), Funraise links, pledges, matching gifts | always | `/portal/letters` |
| Events | `/:locale/portal/events` | registrations (upcoming, past), Get involved meeting and event links | events configured, or a non-volunteer Get involved link | `/portal/activity` |
| Volunteering | `/:locale/portal/volunteering` | completed shifts and total, volunteer Get involved links | volunteer history configured, or a volunteer link | |
| Profile | `/:locale/portal/info` | change-request form, communication preferences, email addresses | always | `/portal/change-request` (query kept, so `?field=employer` still preselects Employer) |

A hidden tab's path redirects to Benefits. A session with no people (an organization rep only)
sees Benefits with just its organizations; every other tab sends it there.

The change-request and preferences POSTs keep their paths; their result pages link back to
Profile. A failed Monday read costs that person or that section, with the "some records could not
be loaded" note in the frame, never the page; only when no one loads does a tab show its error
page.

**Email addresses on Profile** (`src/doors/emailLabels.ts`). Each shown address carries a text
label: **Bounced** when its consent column (Personal Email Consent / Household Email Consent) says
Cleaned; else **Verified** when `verified_emails` holds that address for that person; else
**Subscribed** when the consent column says Subscribed; else **On file**. Which addresses show:

* A person's **Personal Email** shows only when the session was signed in with that address.
* A person's **Household Email** shows when the session was signed in with it, or with that
  person's Personal Email.
* The rule is the same for one person or several. One person signed in with their Household
  Email sees only that address. Signed in with a shared Household Email, Jordan and Sam each see
  that address; neither sees the other's Personal Email.
* A session that doesn't know its address (a letter-ready link, or a session from before
  migration 0008) shows no addresses, whatever its size, just a note to sign in again with an
  email address.

That needs the session's sign-in address: `sessions.email_hash` (migration 0008, see
Development), compared with each address hashed the way sign-in hashes it (trimmed, lowercased,
SHA-256). The change form's current-details list no longer shows an email, for the same reason.
Household Email and both consent columns are gated placeholders: until configured, only the
Personal Email shows, labeled Verified or On file.

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

**Return-to after sign-in.** A signed-out GET of any `/<locale>/portal/...` page other than the
home page redirects to `/?next=<that path>`. The sign-in form, the emailed link
(`/auth/callback?lang=…&next=…#token=…`) and the confirm page carry `next` through, and the
callback redirects there (its locale segment rewritten to the link's `lang`) instead of to the
home page. `next` is accepted only when it parses as a same-origin path in the `/<locale>/portal`
tree, with the language switcher's parser (issue [GL#32](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/32)); anything else is dropped. The footer
language picker sends `location.pathname + location.search` as `to`, so switching language on the
sign-in page keeps `next`.

**Cloudflare Access (Zero Trust) was considered and ruled out for this specific use.** It's the
right fit for gating small internal tools to a handful of staff — it's licensed per seat, for
members of an organization — but this needs to serve every donor with an email on file, not a
small team. Custom magic-link auth is the correct scope match here, not a shortcut around a
better-fit product. (Project Galileo makes Access available to SVBC for staff-facing tools, such
as gating the sandbox hostnames; that doesn't change the donor-auth decision.)

**Rate-limit login requests** (per email and per IP) to blunt abuse of the email-sending step —
this is the one place this Worker can be used to spam an inbox if left unguarded. Per IP: the
`LOGIN_RATE_LIMITER` binding. Per address (`rateLimit` in config, issue [GL#62](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/62)): at most one login
email per `emailCooldownSeconds` (60), `emailMaxAttempts` (5) per `emailWindowSeconds` (900), and
`emailDailyMax` (10) per rolling 24 hours. One atomic D1 statement checks and records
(`src/db/loginAttempts.ts`), and only a request it lets through is recorded — so someone rotating
IPs can send an address at most `emailDailyMax` emails a day, each with a working link, and can't
stretch a lockout by retrying.

**Sign-in code.** The same email carries a 6-digit code beside the link, for a donor who reads
mail on one device and signs in on another (or whose mail app opens links in a browser without
their portal session). Each `POST /` makes a request id, sends it to the browser in the
`__Host-login-request` cookie (HttpOnly, Secure, SameSite=Lax, Path=/, 15 minutes) and binds the
code to it: the stored hash is of `<request id>:<code>`, so the code is useless without that
browser's cookie. The check-email page posts the code to `POST /auth/code`, which strips spaces,
requires six digits and signs the donor in exactly as the link does (same session cookie, same
`next` redirect), then clears the request cookie. The link and the code are one row in
`magic_link_tokens` and share `used_at`: whichever is used first spends both. The cookie is set
whether or not the address matched, or was even well-formed, so the response reveals nothing; it
is withheld only when a rate limit (per IP or per address) denied the request, since no code was
sent. Two caps guard guessing: each request's code gets `MAX_CODE_ATTEMPTS` (5) tries, right or
wrong, and each address gets `rateLimit.codeFailuresPerAddressDaily` (10) wrong guesses per
rolling 24 hours across all its requests (`code_failures`). One D1 batch counts the try and
reserves the failure slot before the comparison, and a request that matched no donor runs the
same batch and hashes the code too, so response time doesn't tell whether an address is on file.
The IP limiter also covers `POST /auth/code` (`code:<ip>` keys). Every refusal is one generic
page.

**AutoFill and Send again.** The email's subject leads with the code, and the last line of its
text part (also the last paragraph of the HTML) is WebKit's origin-bound one-time-code form,
`@member.bikesiliconvalley.org #123456` (the host comes from `auth.portalBaseUrl`), so Apple Mail
and Safari offer the code above the keyboard on the check-email page without the donor switching
apps. Seeing the code in a notification is harmless: it only works with the requesting browser's
cookie. Whenever the typed address was well-formed (on file or not), the check-email page also
offers **Send again**: a form that re-posts the address to `POST /`, held hidden by a CSS animation
for `rateLimit.emailCooldownSeconds` (no script; with animations off it shows at once and the
cooldown still applies). The page echoes the address, so it is served `no-store`.

**Household Email.** Sign-in matches an address against a donor's Household Email as well as
their own, so a shared household address signs in every person on it; the session covers all
of them, labeled as above.

**Verified addresses.** A correct code or a used link proves control of the address, so the
`verified_emails` table (`email_hash`, `person_item_id`, first and last verified) records the
address against each person the session covers. Hashes only; no raw address is stored.

## Sandbox test accounts

In the sandbox (and `npm run dev:local`), a fixed set of `test-*@example.org` addresses signs in
at once on `POST /`, with no magic link, rate limit or write-switch check, and reads dummy
personas instead of Monday: one per membership state (Active Member, Active Lifetime, Lapsed,
never joined), plus a renewal-window member, a shared household inbox and a Spanish speaker who
just joined (the home page's new-member state). An organization rep, `test-orgrep@`, has a
Current, Portal-access Affiliation to a test organization (`src/testAccounts/testOrgs.ts`: a
donation and a sponsorship last year, an employee match, a gift this year), and that
Affiliation's Work Email, `test-orgrep-work@`, signs in to the organization alone. Their grants
come from `resolveOrgGrants`, answered by `withTestAccounts`, so they pass the same checks a real
rep's do. The
list lives in `src/testAccounts/personas.ts` (staff copy: `docs/uat/member-portal.md`); dates are
relative to the request's clock.

- **Never in production.** `src/index.ts` turns it on from `ENVIRONMENT === 'sandbox'`, not from
  config, so no config edit can enable it.
- **Isolated from Monday.** Persona ids start with `test-` (Monday ids are all digits), and
  `withTestAccounts` answers those ids itself, passing every other id to the real client. Their
  change requests run every check, then go to a discarding store and queue, so nothing reaches
  D1's `change_requests`, the writer or the Change Requests board. Card tokens are written to D1
  as usual, so `/verify` works for a test card, and the session stores the sign-in address's hash
  like any other, so Profile shows that address (the household's under each person).
- **Not an enumeration leak.** The addresses are published to staff, and the reserved
  `example.org` domain can't belong to a donor.

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

**Read-only portal, separate writer.** Monday access comes from the `svbc-monday-auth` OAuth
broker, not a stored token (`MONDAY_AUTH` service binding; `tokenProviderFor` in
`src/monday/graphql.ts` falls back to a `MONDAY_API_TOKEN` secret only while that binding is
absent). The portal binds the broker's **`PortalToken`** entrypoint (read scope) and never calls a
Monday mutation: it enqueues change requests to `member-portal-change-requests` and does not
consume that queue. **`svbc-member-portal-writer`** (`wrangler.writer.jsonc`, entry
`src/writer.ts`; sandbox `svbc-member-portal-writer-sandbox`) is the sole consumer: it binds
**`SyncToken`**, shares the portal's D1 database and `FLAGS` namespace (so the same write switch
governs it), serves no traffic, and throws on any other queue. The portal keeps the letter-emails
consumer, which only reads Monday. Deploy the portal first, then the writer
(`npm run deploy:writer` / `deploy:writer:sandbox`): Cloudflare Queues allows one consumer
Worker per queue, so the writer can't attach while the sandbox portal still consumes the queue.
Change requests wait in the queue between the two deploys (see `DEPLOY.md` for the one-time
sandbox detach);
`config/split.test.ts` and `src/index.test.ts` pin the split.

**Sandbox environment — inbound only, no outbound data.** `npm run deploy:sandbox` deploys
`svbc-member-portal-sandbox` (`wrangler.jsonc` `env.sandbox`) against the CRM Sandbox boards
(`config/sandbox.json`, chosen at request time by the `ENVIRONMENT` var — see
`src/environment.ts`). In the sandbox every email goes to `sandbox@bikesiliconvalley.org`, and
nowhere else, two ways at once: the `EMAIL` binding is declared with
`allowed_destination_addresses` of that one address, so Cloudflare rejects any other recipient
with `E_RECIPIENT_NOT_ALLOWED`; and `src/email/sandboxBinding.ts` rewrites every recipient to
it, prefixing the subject with `[sandbox → <original recipient>]` and prepending a notice. Local development against the sandbox uses `npm run dev:sandbox`; `npm run dev` targets the production config and, once production secrets exist in `.dev.vars`, would write to production sinks. Staff
can therefore request a login link as any real donor to test the portal end to end. The
production and sandbox configs are kept apart by `config/split.test.ts`, which fails if they ever
share a sink, a board id, or a column id (the id checks are latent until production boards exist
and start biting at cutover). What the sandbox cannot exercise today, because the CRM Sandbox has
no board or column for it: event registrations, pledges, and the communication-preference
checkboxes — each stays hidden by its own config gate. Design:
`../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`.

**Sandbox provisioned and verified 2026-09-22**: `svbc-member-portal-sandbox` is deployed and
live at `member.sandbox.bikesiliconvalley.org` in the SVBC Cloudflare account (D1 migrated, all
four queues + DLQs created, both secrets set, `sandbox@bikesiliconvalley.org` a verified Email
Routing destination). A live login-link request for a real sandbox People record produced a
`sandboxOutbound` log line with the correct `[sandbox → …]` subject and no delivery errors.

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
* **Donation Status on the Donations board** (`monday.columns.donationStatus`) — every donation
  read is filtered to the labels in `donations.countableStatuses` (SVBC:
  `["Received", "Received (Historical)"]` — migrated historical gifts are real gifts; the
  board's remaining labels, `Failed` and `Pending`, are not). The filter lives in the Monday
  client, so portal history, tax-letter gift lists and totals, and the January letter sweep all
  see only countable gifts. Both keys are deploy-blocking config, not gated: a portal that
  can't tell a Failed gift from a received one would overstate donors' deductible totals.

## Security notes

* Session and magic-link tokens: 256 random bits from `crypto.getRandomValues` (not signed — there
  is no signing key; the server looks each one up), single-use for the magic link, short expiry
  (the letter-ready link's is `auth.letterLinkTtlHours`), stored in D1 keyed to a SHA-256 of the
  token (not the raw token) so a D1 read doesn't itself leak a usable credential. Membership-card tokens are the exception — stored in plaintext because the card's
  QR code is redrawn from them on every portal page load; see "v3 — Digital membership card" for
  why that tradeoff was kept.
* The emailed login link carries its token in the URL fragment
  (`/auth/callback?lang=en#token=…`, issue [GL#61](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/61)): browsers never send a fragment, so the token stays out of request URLs and Workers Logs, where
  anyone with log access could otherwise redeem an unclicked link (a letter link lives a week).
  `GET /auth/callback` stays inert — an inline script copies the token into the confirm form and
  strips it from the address bar, without submitting, under a CSP that allows only that script by
  hash; the `POST` consumes it. Without JavaScript the form posts no token and the donor sees the
  invalid-link page. Links sent before [GL#61](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/61) (`?token=…`) still work until they expire; drop that
  branch in `routes.ts` once `auth.letterLinkTtlHours` has passed since the [GL#61](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/61) deploy. Workers
  Logs still hold other URL secrets (`/webhooks/monday/letters?secret=`, `/verify/<card token>`),
  so keep log access (Workers observability, Logpush destinations) to the people who need it.
* Session cookies get an explicit server-side TTL too (hours to low days, not indefinite) —
  sessions live in D1, so expiry and logout are server-enforced, not cookie-only.
* Retention: the daily cron deletes expired `sessions` and `magic_link_tokens` rows, and
  `login_attempts` rows (one per login email allowed, donor or not, keyed by a SHA-256 of the
  lowercased address since migration `0006`) older than `rateLimit.attemptRetentionHours` (24;
  validated to cover the 24-hour daily cap). Deletes are batched and capped per run
  (`src/db/authRetention.ts`); indexes in migrations `0005`/`0006`. The hash is unkeyed: it keeps
  addresses out of D1 dumps, not out of reach of someone testing a known address.
* The Worker's Monday token comes from the `monday-auth` broker's Portal app (`PortalToken`,
  `boards:read` and `me:read` only), authorized by the SVBC Integration user — never a staff
  member's personal token. It cannot write. It can, however, **read every board SVBC Integration
  can see**, not only the ones this portal displays: an accepted risk, mitigated by keeping
  sensitive boards private and the integration user off private boards it doesn't need. See
  `../README.md`'s least-privilege-token note and `monday-auth/README.md`, "Accepted risk".
* Every data read is scoped server-side to the authenticated session's Donor item id — the portal
  never accepts a donor-id or email as a client-supplied parameter for "whose data to show."
* HTTPS only, on its own subdomain, separate from any staff-facing tooling.
* CSRF: every state-changing form POST (login, sign-in code, logout, change requests, preferences, card
  regenerate) passes Hono's `csrf()` — `Sec-Fetch-Site: same-origin` or an `Origin` exactly equal
  to `auth.portalBaseUrl`'s origin, else 403. `SameSite=Lax` alone isn't enough here: it still
  sends the session cookie on POSTs from sibling `*.bikesiliconvalley.org` hosts (same-site,
  cross-origin). `config/split.test.ts` pins each environment's `portalBaseUrl` to its
  `wrangler.jsonc` custom domain, so the allowed origin is exactly the served one. The Monday
  webhook is exempt (server-to-server, no `Origin`; it authenticates with its shared secret).
* Response headers on every route (`src/securityHeaders.ts`, Hono `secureHeaders()`): no framing
  (`X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` — nothing embeds the portal), a
  baseline CSP of `frame-ancestors`/`base-uri`/`object-src`/`form-action` only (the pages use
  an inline `<style>` and inline event handlers, so a `script-src`/`style-src` policy needs a
  nonce refactor first), `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and
  `Strict-Transport-Security: max-age=31536000` **without** `includeSubDomains` or `preload` —
  this is one host under a domain whose apex and siblings are run elsewhere, and preload is
  only possible for the apex. `/email/logo.png` alone is `Cross-Origin-Resource-Policy:
  cross-origin`, since webmail clients load it from their own origins.
* Third-party JavaScript never runs on the portal's origin (issue [GL#102](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/102)). The one third-party
  script, Double the Donation's `ddplugin.js`, is served only in
  `GET /:locale/portal/matching-gifts/search`. That document's CSP starts with
  `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`, with no
  `allow-same-origin`, so the browser gives it an opaque origin even when it is opened top-level.
  A compromised `ddplugin.js` there therefore:
  * can't read a same-origin popup of `/portal`, because the popup is cross-origin to it;
  * can't post a form the CSRF check accepts, because its `Origin` is `null` and it also has
    `form-action 'none'`;
  * can't reach the session cookie.

  The matching-gifts page frames it with the same `sandbox` attribute and keeps the baseline
  CSP. The search document is the only response with `X-Frame-Options: SAMEORIGIN` and
  `frame-ancestors 'self'`. Never add `allow-same-origin` to `SEARCH_SANDBOX_FLAGS`.
* No permanent duplicate of donation records in D1 — read live from Monday (or cache with a short
  TTL, e.g. a few minutes, purely for rate-limit headroom against Monday's API), so Monday stays
  the single place donation data actually lives.

## v2 — Year-end tax letters and change requests

Design: `../docs/superpowers/specs/2026-08-24-member-portal-v2-design.md`. Two independent,
config-gated features:

* **Tax letters** (`GET /:locale/portal/letters`, `GET /:locale/portal/letters/:donorItemId/:year`): a
  consolidated per-year giving letter rendered live from the Donations board as HTML with print
  CSS — the browser's Print → Save as PDF is the delivery mechanism; nothing is generated or
  stored server-side. Only completed calendar years with at least one donation get a letter.
  **Printed on the 2026 letterhead** (Box: SVBC Letter 2026): the sand band down the right edge
  with the logo, contact lines, board and executive director, the gold tagline and 501(c)(3) line
  at the foot of page one, and "· page N" after (`src/letters/letterViews.ts`, shared with the
  organization statement). The band's text is `taxLetter.letterhead` in config — update the board
  there when the Box template changes; without that block the band shows the logo and
  `officeAddress`. Print relies on a fixed element repeating on every page and on `@page` margin
  boxes; checked in Chrome's Save as PDF, not yet in Safari or Firefox.
  **Gift Types treated differently** (`monday.columns.donationDescription` is the board's Gift Type
  column; labels compare without case or punctuation): `taxLetter.excludedGiftTypes` (Event Ticket,
  Sponsorship, In Kind Donation / Sponsorship, Matching Donation, Grants, Contracts) are left off and
  never earn a letter or a January email on their own. `taxLetter.separateGiftTypes` (Donor Advised Fund) are listed after the total under
  `taxLetter.separateGiftsStatement`, outside the total and away from the no-goods sentence; a donor
  with only those gets a letter with no contributions table, total, statement or tax-records line.
  Any other label, or a blank, is an ordinary contribution. A DAF gift only counts as one once its
  Gift Type says so: one entered as Donation is an ordinary contribution. The portal's giving
  history still shows every gift.
  **Gated on `taxLetter` config:** every string in it ships as `REPLACE_AFTER_SIGNOFF` and the
  feature shows a friendly "not available yet" state until SVBC signs off on the IRS
  acknowledgment language (both the plain no-goods-or-services statement and the
  benefit/quid-pro-quo variant used for tiers listed in `taxLetter.benefitTiers`) and an
  operator fills in the real wording.
* **Change requests** (`GET`/`POST /:locale/portal/change-request`): a donor submits a new address,
  email, or phone; the Worker records it in D1 (dedupe window:
  `changeRequests.dedupeWindowHours`) and a queue consumer (the separate
  `svbc-member-portal-writer` Worker, below) creates an item on a staff-owned
  Change Requests board (donor link, field, old value, new value, submitted-at). Staff apply
  approved changes to the Donors board by hand — the portal never writes donor records.
  **Gated on `changeRequests.boardId`** plus its column ids and the `donorAddress`/`donorPhone`
  Donors-board column ids in config.

Operator setup for v2, in addition to the v1 steps: create the Change Requests board (five
columns: connect-boards to Donors, three text, one date) and fill in
`changeRequests.boardId`/`columns`; fill in `monday.columns.donorAddress` and
`monday.columns.donorPhone`; grant the broker's Staff Sync (`SyncToken`) identity **write access to the Change
Requests board** (the portal's own `PortalToken` is read-only); create the `member-portal-change-requests` queue and its
`member-portal-change-requests-dlq` dead-letter queue before deploying; apply D1 migration
`0002_create_change_requests.sql`; and, once the letter language is signed off, replace every
`REPLACE_AFTER_SIGNOFF` in `taxLetter`.

## v2.1 — Staff-triggered letter-ready emails

Design: `../docs/superpowers/specs/2026-08-24-donor-letter-emails-design.md`. A Button column on
the Donors board lets staff email a donor a "your letter is ready" notification — a magic link to
the portal home, not the letter content itself. That link's single-use token lives
`auth.letterLinkTtlHours` (168 — a week; validated to at most 168), not the interactive login
link's 15-minute `auth.magicLinkTtlMinutes`: donors open this email whenever they get to it, and a
15-minute link was dead by then (issue [GL#31](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/31)). Always sends the most recently completed year with
gifts; a donor+year is only ever sent once (tracked in the `letter_sends` D1 table). Inert until
`taxLetter` is signed off, same as the portal-facing letters.

This ships the send primitive (`POST /webhooks/monday/letters` → `member-portal-letter-emails`
queue → `processLetterSendBatch`) that the automatic January cron (v2.3 below) reuses without
rework.

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

   **Why a query param, and what it costs.** Monday doesn't sign these deliveries, and the
   automation's webhook action takes only a URL — no custom headers — so the shared secret has
   to ride in the URL. The Worker compares it in constant time, but a URL secret also lands
   wherever request URLs are recorded: Workers observability logs (the dashboard's invocation
   log shows the full URL), and the automation's own config and run history in Monday. Treat
   read access to both as access to the secret; rotate it (new `wrangler secret put`, then
   update the automation's URL) if logs are ever exported or shared, or someone with Monday
   board-admin access leaves. The blast radius is bounded: a leaked secret can only trigger
   "your letter is ready" emails for donors with gifts, each donor+year at most once
   (`letter_sends` dedupe), never read data. Callers that *can* set a header (a hand replay,
   future tooling) should send `X-Webhook-Secret: <secret>` instead, which keeps it out of the
   URL; when that header is present it's the only value checked.
4. Create the `member-portal-letter-emails` queue and its `member-portal-letter-emails-dlq` dead-letter
   queue before deploying (`wrangler queues create member-portal-letter-emails` and
   `wrangler queues create member-portal-letter-emails-dlq`).
5. Apply D1 migration `0004_create_letter_sends.sql`.

## v2.2 — Communication preferences

From [IT Requests #12893526579](https://bikesiliconvalley.monday.com/boards/8846215481/pulses/12893526579).
A "Communication preferences" section on Profile (formerly the change-request page) lets a donor set three
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
## v2.3 — Automatic January letter emails, staff-controlled from a Monday board

The scheduled follow-on to v2.1 (IT Requests item 12893503099): once a year, every donor with
gifts in the just-completed calendar year gets the same letter-ready email the staff button
sends — no button-clicking through the whole Donors board. Staff control it entirely from a
**Letter Settings board** in Monday, so arming, pausing, and timing never need a deploy:

* **Auto-send** (checkbox) — the master switch. While unchecked, the cron never sends.
* **Auto-send start date** (date) — the cron only sends on or after this date. It re-arms each
  January for the newly completed year (the date is a floor, not a one-shot), so staff move the
  date forward — or uncheck Auto-send — to delay or sit out a season.
* **Email body template** (long text) — the letter-ready email body, plain text with
  `{{donorName}}`, `{{year}}`, `{{loginUrl}}` placeholders. Applies to **all** letter-ready
  emails, button-triggered and cron alike; blank falls back to the built-in copy. Pasted markup
  is escaped, never rendered, so the board can't become an HTML-injection vector into donor
  email.
* **Per-locale templates** — one optional "Email body template (Spanish)"-style column per
  supported non-English locale (`letterCron.columns.bodyTemplatesByLocale`). Each donor's email
  resolves their Monday Preferred Language, then picks their locale's template → the default
  template → the built-in copy *in their language* (`letterReady.*` keys exist across all ten
  locales). The subject line always follows the donor's language, and the magic link carries
  `&lang=<locale>` so the portal opens localized — same resolution as the login email.
* **Employer ask ([GL#127](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/127))** — while the portal's Employer field is on (`employerAnswerEnabled`),
  every letter-ready email ends with one localized line, "Does your employer match gifts? Tell
  us where you work.", linking to `/<locale>/portal/change-request?field=employer`. It's
  appended after the body, built-in or template, so a template doesn't need (and can't drop) it.
  The page is session-gated: a donor who clicks it before the login link signs in first and then
  lands on the Employer field (return-to after sign-in, below).

How it runs (`src/letters/runLetterCron.ts`, called from the existing daily `scheduled()`
handler — no separate cron trigger): every day the Worker reads the settings board (one cheap
query; on most days that's the whole run). Once armed and past the start date, it sweeps the
Donations board for donors with gifts dated in the prior year
(`listDonorIdsWithDonationsInYear` — one ids-only paginated query, so lapsed donors never get
old-year letters), drops donors already in `letter_sends` for that year (one D1 read, zero
Monday cost per handled donor), and calls the same `triggerLetterSend` primitive as the button
for the remainder — sequentially, capped at `letterCron.maxTriggersPerRun` per run to respect
Monday's complexity budget. Daily reruns through January make the job self-healing: transient
failures retry the next day, late-entered gifts still get letters, and the donor+year dedupe
makes completed donors free. One deliberate limit: a donor the queue consumer marked
**`skipped`** (no email on file, or gifts vanished before sending) is not retried by the cron —
the dedupe treats any existing row as handled. Once the underlying data is fixed, the staff
button is the retry path (it requeues skipped rows).

Sends are **at most once** per donor+year (issue [GL#31](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/31)): the consumer claims the row
(`queued` → `sending`) before emailing and marks it `sent` after. If the send itself fails, the
claim is released and the queue retries; if the email went out but the `sent` write failed, the
row stays `sending` and nothing resends it — neither the retry, the cron, nor the staff button.
A row stuck in `sending` with no email received (the Worker died between claim and send, or a failed send's claim couldn't be released — both rare and logged)
needs a manual `UPDATE letter_sends SET status = 'queued' WHERE id = …` and a button click.

Gates, all required before a single email goes out: `letterCron` config filled in,
`taxLetter` signed off (`lettersEnabled`), Auto-send checked, start date reached.

Operator setup, in addition to v1/v2/v2.1 steps:

1. Create the Letter Settings board:
   `MONDAY_API_TOKEN=... node scripts/create-letter-settings-board.mjs --workspace <id>` (run as
   an admin user — board creation needs more permission than the portal's integration user
   holds). The script creates the checkbox/date/long-text columns, seeds the single
   "Letter emails" settings item with the built-in template, deletes Monday's board-template
   default items, and prints the `letterCron` config block to paste into `config/svbc.json`.
   A fresh board also gets the nine per-locale template columns. Already run against the CRM
   Sandbox: board `18439574433` ("Member Portal Letter Settings (sandbox)", locale columns added
   via `--add-locale-columns 18439574433` — the idempotent upgrade mode for boards created
   before those columns existed); re-run the same command against the production workspace at
   rollout.
2. Grant the portal's integration user **read** access to the new board (it never writes to it).
3. Paste the printed `letterCron` block into `config/svbc.json`, commit, deploy.
4. When SVBC wants the January send armed: check Auto-send and set the start date on the board.
   Nothing sends before `taxLetter` sign-off regardless.

## v3 — Digital membership card

Design: `../docs/superpowers/specs/2026-08-24-digital-membership-card-design.md`. A donor views a
live card (a widget per donor in the header of every portal tab, with "Regenerate card" on
Benefits, `GET /:locale/portal`, where the old `/:locale/portal/card` and `/card/:donorItemId`
pages now redirect) — name, member number, tier, status, expiry — with a
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
fresh one any time from the card widget's "Regenerate card" button.

Operator setup for v3, in addition to the v1/v2 steps: add a Membership Expiry (date) column to
the Donors board and fill in `monday.columns.membershipExpiry`; apply D1 migration
`0003_create_card_tokens.sql`. No new Monday write access, no new queue, no new secret.

**Card tokens are stored in plaintext in D1 — deliberately, unlike session and magic-link
tokens** (issue [GL#32](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/32)). The difference is that a card token is re-displayed: every portal page load
redraws the card's QR code from the active token, so the Worker needs the token itself back, not
just a way to recognize it. Session and login tokens are only ever *checked*, so a hash suffices.
Storing card tokens hashed would therefore mean deriving or decrypting them from a new Worker
secret (HMAC-derived tokens, or AES-GCM ciphertext plus a hash column for lookup). Considered and
not done, because:

* **What a leaked table unlocks is small, and D1 already holds more.** A card token opens only
  `/verify/:token`: name, tier, membership status and expiry — the same facts printed on the
  card the donor shows at a shop counter. Anyone who can read `card_tokens` can read
  `change_requests` in the same database, which holds donors' old and new addresses, emails and
  phone numbers in plaintext.
* **HMAC re-derivation would break every card already issued.** Existing tokens are random, so
  no key can re-derive them; switching would force a regenerate for every donor and silently
  invalidate each Wallet pass donors created from the old QR code. The encryption route avoids
  that (existing rows can be encrypted lazily on first read) but adds a key whose rotation also
  invalidates every card.
* **Existing controls cover the realistic leak.** Tokens are revocable by the donor
  ("Regenerate card"), revoked rows are purged, `/verify` is rate-limited, and the `cardEnabled`
  kill switch stops every token at once.

Revisit if `/verify` ever starts showing more than the card itself does, or if `change_requests`
stops holding plaintext PII: the encrypt-plus-lookup-hash design is then the migration path, and
it keeps issued cards working.

**Revoked tokens don't linger:** the daily retention cron (same one that purges `change_requests`
— see `src/index.ts`'s `scheduled` handler) also deletes `card_tokens` rows past
`cardTokens.retentionDays` once `revoked_at` is set — a revoked token is a dead bearer credential
for donor PII with no purpose once superseded. Active tokens (`revoked_at IS NULL`) are never
touched, regardless of age.

## v3.1 — Funraise deep links (recurring gifts & membership renewal)

From the v2 brainstorm's candidate list (IT Requests item "Member portal: recurring-gift
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
`https://give.funraise.org/login` — Funraise's member portal is a shared surface, not
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
("Member portal: pledge tracking / employer matching-gift lookup"). Two independent, config-gated
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
  employer-search widget is gated on `matchingGifts.doubleTheDonationPublicKey`** (SVBC subscribed to
  DTD's Workplace Giving Platform – Standard, quoted 2026-07-07 for two years, and DTD confirmed
  onboarding complete 2026-08-20; the public plugin key is set in `config/sandbox.json` and
  `config/svbc.json`, `null` in `config/local.json`). This is the only portal page
  that shows third-party JavaScript, and the widget runs only in a sandboxed, opaque-origin
  iframe (`/:locale/portal/matching-gifts/search`; see Security notes), never on the portal's
  own origin. The page also still renders **zero donor PII**, as a second line of defence.
  Keep both properties. The embed
  in `src/matchingGifts/matchingGiftViews.ts` matches DTD's "Standard Javascript Embed using
  Shadow DOM Encapsulation" snippet as of 2026-11-03. The remaining operator step is checking the
  widget inside the sandbox on the sandbox deploy:
  * the search loads;
  * a company search returns results;
  * a company's guidance link opens in a new tab;
  * the console shows no CSP or sandbox errors.

  DTD's script has no Subresource Integrity hash because DTD serves it from a mutable,
  unversioned URL. The sandbox is the compensating control.

**Upgrading an existing deployment (forks included):** config validation requires the
`pledges` and `matchingGifts` stanzas to *exist* before v4 code will serve any request — a
config predating v4 fails validation on every request, queue batch, and cron run, not just on
the new pages. Copy both stanzas from this repo's `config/svbc.json` (placeholder/null values
are fine; both features then ship gated off) before deploying v4 code over an older config.

Operator setup for v4, in addition to the v1 steps — each feature independently optional:

1. Pledges: create the Pledges board, grant the portal's integration user **read** access to
   it, and fill in `pledges.boardId` and all five `pledges.columns` ids in `config/svbc.json`.
2. Matching gifts: get the public plugin key from SVBC's Double the Donation account (development
   staff hold it; a fork needs its own subscription), then set
   `matchingGifts.doubleTheDonationPublicKey` to that **public** plugin key (never a private API
   key — this value is served to every logged-in browser). Done for SVBC; a fork sets its own.
## v4.1 — Donor-supplied employer

Design: `../docs/superpowers/specs/2026-11-16-donor-employer-answer-design.md` (issue [GL#127](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/127)). A
donor can tell SVBC where they work, and an answer that names a known Organization becomes their
employer affiliation without a staff step.

* **Where:** an **Employer** option on the change-request page, beside Address, Email and Phone.
  The current value shown is People → Employer Name. `/:locale/portal/change-request?field=employer`
  preselects it; the matching-gifts page links there ("Tell us where you work…") but never shows
  the donor's employer, so that page stays free of donor data.
* **Submit:** the same path as every change request (D1 row, dedupe window, queue, write switch).
  The D1 `field` is `employer`; no migration.
* **Apply (writer):** `src/changeRequests/applyEmployer.ts`. The typed name is normalised (case,
  punctuation, one trailing `Inc`/`LLC`/`Ltd`/`Corp`/`Corporation`/`Co`/`Company` dropped) and
  looked up on Organizations by exact name, together with the common suffix spellings
  (`Google` also finds `Google, LLC`). Then:
  * **exactly one match:** that person's affiliation to it becomes Current and Primary (reused if
    one exists, created otherwise). Any *other* Primary affiliation loses Primary only; its
    Status never changes, because Primary on imported data is NPSP's general flag, not
    "employer", and `contact-roles` reads Current affiliations. `donation-rollups`' `employerSync`
    then sets People → Employer Name. The writer never writes Employer Name itself.
  * **none, or several:** nothing is applied.
* **Staff see every answer** on the Change Requests board, as an item named
  `Employer change — <donor> (#<id>)` whose Field is one of `Employer (applied)` (New Value names
  the Organization and any `(previous Primary: <org> (<its Status>))` for staff to mark Former if the
  donor left), `Employer (no change)`, or `Employer (needs an Organization)` (the typed name, or
  the matching Organizations when there are several). The log item is the last write, so a
  retry after a partial run re-reads Monday and finishes rather than repeats.
* **Write switch:** under `off` the Organization and affiliation reads still run and the
  affiliation and log writes are skip lines; `hold` waits on the queue like any change request.
* **Config** (`config/*.json`): `monday.columns.donorEmployer` (People → Employer Name) and
  `changeRequests.employer` = `{ affiliationsBoardId, affiliationColumns: { personLink,
  organizationLink, status, primary }, currentStatusLabel, personAffiliationsLink }` (People →
  Affiliations link), the same ids `donation-rollups` uses. **Gated on `employerAnswerEnabled`:**
  change requests on, the block non-null, `monday.organizationsBoardId` set and `donorEmployer`
  not a placeholder. `local.json` ships it off.
* **Access:** the writer's `SyncToken` identity now also writes the Affiliations board and reads
  Organizations and Affiliations. It's the one integration user, so no setup step, but the
  writer is no longer write-only-to-Change-Requests.
* **Sandbox check, before turning it on in production:** with a test person whose Current,
  Primary affiliation is at org A, submit org B's exact name, then a made-up name. Expect B
  Current and Primary, A still Current with Primary off, Employer Name updated by
  `employerSync`, and two Change Requests items (`applied` naming A, `needs an Organization`).
  This also confirms the unverified write shapes: a status `{ label }`, a checkbox
  `{ checked: "true" }`, and clearing a checkbox with `null`. **Also confirm the mirror column:**
  open the new affiliation for B and check it appears in the test person's Affiliations column
  (`personAffiliationsLink`) straight away. The writer's only guard against a duplicate
  affiliation on a retry is reading that column, so it must be the two-way mirror of the
  affiliation's Person column (`personLink`) and must not lag past the queue's 60 s retry delay.
  Archived and deleted affiliations are ignored, as in `donation-rollups`.
* **Sandbox check result (2026-11-17): passed, after one Monday fix.** The People → Affiliations
  column the Salesforce import made was one-way (the import filled both sides itself), so an
  affiliation created later never appeared in it: Employer Name didn't move and the duplicate
  guard was blind. Fix: turn on two-way connection (`allowCreateReflectionColumn: true` via
  `update_column`, in place) on the Affiliations board's Person column. Monday adds a reverse
  column on People and People (Historical), already filled from every existing link (sandbox:
  identical to the old column for all 1,765 + 3,471 linked people). Rename the old column to
  `Affiliations (old one-way)` and the new one to `Affiliations` (title lookups such as
  `link-employers-to-organizations.mjs` find it by name), then point `personAffiliationsLink`
  here and `donation-rollups`' `employerSync.ownerColumnsByBoard.*.affiliationsLink` at the new
  ids. Re-run: the same answer twice gave `no change` with no duplicate, a new employer moved
  Primary, and `employerSync` set Employer Name within 30 s. **Production done the same way
  (2026-11-17):** new columns People `board_relation_mm96jvj6`, People (Historical)
  `board_relation_mm96q5g6`. They add links the old columns had missed (27 + 1 people) and drop
  one: Alex McIntyre's City of San Bruno affiliation points its Person at his People (Historical)
  record, not the People copy made on 2026-11-13, which the old column alone listed (staff to
  decide whether to move it). Delete the `Affiliations (old one-way)` columns once production is
  verified.

## v5 — Event registrations

From the IT Requests board (["Member portal: event
registrations"](https://bikesiliconvalley.monday.com/boards/8846215481/pulses/12893527106),
scoped 2026-08-25). Read-only, on the Events tab (`GET /:locale/portal/events`; the retired
`/:locale/portal/activity` redirects there), listing the logged-in donor's event registrations, split into **Upcoming** (event date today or
later, soonest first) and **Past** (latest first; past rows show Attended/Registered from the
board's checkbox, and undated registrations sort last). Same multi-donor-household rule as the
rest of the portal: one explicitly labeled section per matched donor item. No D1 tables, no
queues, no writes — reads live from Monday like everything else here.

**Data source:** the **Event Registrations** board — the post-migration rename of today's
hand-maintained Event Participation board, rebuilt at cutover to match the CRM Sandbox rehearsal
(`salesforce-import`'s `Fundraising_Event_Registration` output: Attendee board-relation → People,
Event board-relation → Events board, Attended checkbox). The event's name and date come from the
linked Events-board item, resolved in a second query. Registrations whose Attendee relation was
never matched to a People item (name/email captured only as fallback text) can't be tied to a
logged-in donor and simply don't appear. The Eventbrite repoint (see the migration plan) is what
will keep this board current for *future* events — it isn't a precondition for showing the
migrated history, which is why this shipped ahead of it.

**Deliberately excluded: ticket and deductible amounts.** Both columns exist on the board, but
surfacing dollar figures here would blur the portal's carefully-drawn "this is not a tax
document" line — the deductible-portion story belongs to the tax-letter feature and its
signed-off IRS language, not an event list.

**Gated on `eventRegistrations` config** (same placeholder-tolerant treatment as
`changeRequests`): the page shows a "not available yet" state until an operator fills in real
ids. Operator setup, in addition to the v1 steps, once the post-cutover board exists:

1. Fill in `eventRegistrations.boardId` (Event Registrations board) and its `columns` —
   `attendeeLink` (Attendee board-relation), `eventLink` (Event board-relation), `attended`
   (Attended checkbox).
2. Fill in `eventRegistrations.eventDateColumnId` — the **Events board's** Date column id (the
   registration board has no date of its own; dates live on the linked event item).
3. Grant the portal's integration user **read access to the Event Registrations and Events
   boards** (it stays read-only everywhere except Change Requests).

No new secrets, queues, or D1 migrations.

## v6 — Volunteer history

From the IT Requests board Feature Request "Member portal: volunteer history" (filed from the
2026-08-24 v2 brainstorm): show volunteer hours/shifts alongside donations. Each donor's portal
Volunteering tab shows total hours plus a date/activity/hours table, and the card shows the hours — read
live from the Volunteers board, filtered to shifts whose status is in
`volunteerHistory.completedStatuses` (default `["Completed"]`, so no-shows and un-worked signups
don't inflate a donor's hours; set it to `[]` to include every status). The block renders only
for donors with at least one qualifying shift — donors who never volunteered see no change.

**Gated on `monday.volunteersBoardId` + the `volunteer*` column ids:** the ticket's blocker
("volunteer data doesn't live in Monday until post-migration") is handled by shipping dark — the
feature is invisible, and the Volunteers board is never queried, until an operator fills in the
board id and all five `monday.columns.volunteer*` ids (same treatment as v2's
`donorAddress`/`donorPhone` and v3's `membershipExpiry`). The expected board shape is exactly
what `../salesforce-import` loads from GW Volunteers: a connect-boards link to the Donors/People
board (`volunteerDonorLink`), Hours number (`volunteerHours`), Date (`volunteerDate`), Job text
(`volunteerJob`), and Status (`volunteerStatus`).

An optional sixth id, `volunteerTicketType` ([GL#115](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/115)), names eventbrite-sync's Ticket Type column.
When set, a shift's Job reads "Bike to Work Day — Shift 1", so one person's two shifts at one
event show as two rather than as a duplicate row. Absent or `REPLACE_WITH_COLUMN_ID` shows the
Job alone and doesn't gate the feature. Canceled sign-ups never show: they aren't in
`volunteerHistory.completedStatuses`.

Operator setup for v6, in addition to the v1 steps: after the Volunteers board exists
post-migration, fill in `monday.volunteersBoardId` and the five `volunteer*` column ids in
`config/svbc.json`; confirm `volunteerHistory.completedStatuses` matches the board's actual
"worked this shift" status label(s); and grant the portal's integration user **read access to the
Volunteers board**. No new D1 migration, no new queue, no new secret, no Monday write access.

**Upgrading an existing deployment (forks included):** same rule as v4's stanzas — config
validation requires the `volunteerHistory` stanza and `monday.volunteersBoardId` key to *exist*
before v6 code will serve any request. Copy them from this repo's `config/svbc.json` (null/
placeholder values are fine; the feature then ships gated off) before deploying v6 code over an
older config.

## v7 — Clean-start donation history

Decided 2026-09-11: rather than show migrated Salesforce giving history (which is already
truncated at the Donations board's archive window — gifts before July 2025 are archived in place
and invisible to the portal's board queries), the portal starts clean. Two calendar-date keys in
the `donations` stanza, both required, each `"YYYY-MM-DD"` or `null`:

* **`historyStartISO`** — the gift floor. Every donation read in the Monday client drops gifts
  dated earlier, and undated gifts (they can't be shown to be on or after the floor), in the same
  strict spirit as `countableStatuses`. So portal history, tax-letter year listings and totals,
  the staff letter button, and the January letter sweep all agree without their own logic. With
  a floor set, the giving tab's total (and the card's Total given) is the sum of the gifts shown rather than the Lifetime
  Giving rollup, so it never exceeds the rows under it. `null` means no floor. SVBC:
  `"2026-01-01"`.
* **`historyVisibleFromISO`** — the launch gate. Donation history on the giving tab, and Total given on the card, render only once
  the current UTC date reaches it; until then no portal page shows or queries giving history
  (the home page never does). Organization pages (v10) do read Donations to list their statement
  years, but show no giving history before that date. `null` means never shown —
  the default for a fresh fork, and how this ships ahead of launch so the rest of the portal can
  be tested. Date-gated rather than a boolean so January needs no deploy. SVBC: `"2027-01-01"`,
  the first day of the first full calendar year after the clean start. `config/local.json` sets a
  past date so history is visible in local testing.

The January letter cron skips (`year-before-history-floor`) when the floor is at or after
January 1 of the year following its target year — SVBC's first automatic letters are for 2026,
sent January 2027. Letter routes stay reachable throughout; with the SVBC floor they simply list
no completed years until 2027. Lifetime Giving, First Gift, and Gift Count on the Donor item are
unaffected — they remain full-history stewardship rollups for staff.

**Upgrading an existing deployment (forks included):** config validation requires both keys to
*exist*. Copy them from this repo's `config/svbc.json` — `null` for both keeps the previous
always-on, no-floor behavior... except that `historyVisibleFromISO: null` hides history, so a
fork that wants history visible immediately should set it to any past date.

## v8 — Impact summary

From the IT Requests board Feature Request "Donor portal: impact summary" (item 12893527105,
filed from the 2026-08-24 v2 brainstorm): tell a donor what their giving supported. Each donor's
section of the giving tab gains a "Your 2026 impact" block under their history — a short list of org-wide
statements for one calendar year, shown only to a donor who has a countable gift dated in that
year, so "your giving in 2026" is always true of the person reading it.

The statements are static config, not Monday data — the `impact` stanza:

```json
"impact": {
  "statementsByYear": {
    "2026": {
      "en": ["Taught bike safety to 4,200 students", "Won 12 miles of protected bike lanes"],
      "es": ["Enseñamos seguridad ciclista a 4,200 estudiantes"]
    }
  }
}
```

* **Which year a donor sees:** the most recent year that has statements *and* holds one of that
  donor's gifts (`src/impact/impact.ts`). One year only. A donor who gave in 2026 keeps seeing
  the 2026 statements through 2027 until 2027's statements are added *and* they have a 2027
  gift; a donor whose only gifts fall in years without statements sees nothing. A household
  login checks each donor section against that donor's own gifts.
* **Locales:** `en` is required for every year. Any other supported locale is optional and
  falls back to the English list as a whole — a year's list is never mixed across languages.
* **Validation at startup:** year keys must be four digits, locale keys must be supported
  locales, and each list must be non-empty with no blank strings.

**Gated two ways, both already in place.** An empty `statementsByYear` (`{}`, how
`config/svbc.json` ships) renders nothing. And the block reads the gifts already loaded for
donation history, so it follows v7's date gate: nothing shows before
`donations.historyVisibleFromISO` (SVBC: 2027-01-01), and only gifts on or after
`historyStartISO` count. For SVBC the first statements anyone can see are 2026's, in January
2027. It costs no extra Monday read, no D1 migration, no queue and no secret.

Operator setup for v8: once staff have written a year's statements (after the year closes), add
them under that year in `config/svbc.json`, commit, and deploy. `config/sandbox.json` and
`config/local.json` carry statements marked "[Sample for testing]" so the block can be seen
before any real ones exist.

**Upgrading an existing deployment (forks included):** config validation requires the `impact`
stanza to *exist*. Copy `"impact": { "statementsByYear": {} }` from this repo's
`config/svbc.json` before deploying v8 code over an older config; the feature then stays off.

## v9 — Get involved links

A "Get involved" section on the Events and Volunteering tabs (`GET /:locale/portal/events`, `/volunteering`; volunteer links on the latter) links every member to the
public meetings where South Bay bike decisions get made and to SVBC's own calendar, grouped as
city bike/pedestrian committees, transit-agency committees (BART, Caltrain), SVBC events and
volunteer opportunities. The list lives in `config/*.json`'s `getInvolved.links`, one entry per
link: `category` (`civic`, `transit`, `events` or `volunteer`), the public meeting page `url`,
an optional `calendarUrl`, and a `label`. Committee names are proper nouns and stay untranslated,
so `civic` and `transit` links must have a `label`. An `events` or `volunteer` link without one
gets translated link text instead. Every URL must be https.

Each `calendarUrl` is the matching `svbc-calendars` ICS feed
(`https://committees.bikesiliconvalley.org/calendars/<feed-id>.ics`), so adding a committee here
usually means adding its source there too. The links are public pages, not donor data, so
sandbox and local configs carry the same list. The section is the same for every member: the
tab doesn't load a donor's address, so it isn't filtered by city. It costs no Monday read.

**Upgrading an existing deployment (forks included):** config validation requires the
`getInvolved` stanza to exist. `"getInvolved": { "links": [] }` keeps the section off.

## v10 — Organization reps

A person who acts for an organization (a sponsor's contact, an employer's giving lead) can sign in
and see that organization's page and year-end statement. Spec:
`../docs/superpowers/specs/2026-11-19-member-portal-organization-reps-design.md`. Code: `src/orgs/*`
(`grants.ts` resolves access, `loadOrgData.ts` and `statement.ts` build the page and statement,
`orgViews.ts` renders them, `runOrgStatementPass.ts` and `processOrgStatementSend.ts` are the
January email), `src/db/orgStatementSends.ts`.

**Access.** Staff tick **Portal access** on a person's Current Affiliation. The rep then signs in
with the person's Personal Email (every organization they hold a granting Affiliation for opens)
or with that Affiliation's Work Email (only that one organization opens, and the home page lists
just it, with no personal records). A shared Household Email never carries Affiliations. Grants are
resolved at sign-in, stored as `org_grants` JSON on `magic_link_tokens` and `sessions` (NULL = none),
and re-checked live on every organization page: untick the box or mark the Affiliation Former and
the next organization page load is a not-found. The home list is built from the session's grants
and can lag up to 24 h (the session's cached copy).

**What the statement shows.** Everything the organization gave: donations, sponsorships, grants,
contracts, in-kind gifts, event tickets, employee matching, and employee volunteering as an
aggregate that is hidden when fewer than `volunteerFloor` (3) people contributed. No employee
names appear, and Donations item names are not shown. Only the acknowledgment section counts
deductible gifts. The volunteering line counts people affiliated with the organization today
(Current Affiliations), not whoever was affiliated when they volunteered.

**Employee matching needs `monday.columns.donationMatchedBy`.** The org page and statement find an
organization's employee matches through the Donations **Matched By** column. Sandbox has it
(`board_relation_mm8hs607`); **production doesn't yet** (still `REPLACE_WITH_COLUMN_ID` in
`config/svbc.json`), so there an organization's matches read as none, and an organization whose
only activity is matching gets no statement or January email. Setting it alone does not turn on the
person-side Double the Donation match lines, which still need all four DTD columns.

**Config.** Each `config/*.json` has an `organizations` block:

| Key | Meaning |
|---|---|
| `portalAccessColumn` | The Affiliations board's **Portal access** checkbox id. `REPLACE_WITH_COLUMN_ID` keeps the whole feature off. |
| `workEmailColumn` | The Affiliations **Work Email** column id. Unset: Work Email sign-in is off. |
| `addressColumns` | Organizations board address columns for the statement heading. |
| `acknowledgmentSignedOff` | Accountant sign-off switch for the acknowledgment wording (below). |
| `volunteerFloor` | Minimum distinct volunteers before volunteering is shown (3). |

Gates in `src/config.ts`: `orgAccessEnabled` (a real Portal access column, the
`changeRequests.employer` block, and an Organizations board id) turns on grants, pages and the
January pass; `workEmailSignInEnabled` adds a real Work Email column; `orgAcknowledgmentEnabled`
adds `acknowledgmentSignedOff: true` and a signed-off EIN. The Portal access checkbox exists on both
Affiliations boards: sandbox `boolean_mm986pxt` (configured in `config/sandbox.json`, so the
feature is **on in the sandbox**), production `boolean_mm9859qh` (in `config/svbc.json` since 2026-11-19, so it is **on in
production** too; nothing shows until staff tick the box on a Current Affiliation).

**Migration `0009_organization_reps.sql`** adds `org_grants` to `magic_link_tokens` and `sessions`
and creates `org_statement_sends`. Apply it to the sandbox and production D1 databases **before**
deploying code that reads it (`getSession` selects the new column), as for 0007/0008:

```sh
npx wrangler d1 migrations apply svbc-member-portal-sandbox --remote --env sandbox
npx wrangler d1 migrations apply svbc-member-portal --remote
```

**Acknowledgment switch.** The organization acknowledgment section (the only part that counts
deductible gifts) stays off while `organizations.acknowledgmentSignedOff` is `false`, which is its
state in both configs until the accountant signs off the wording. Flip it to `true` (with the EIN
signed off in `taxLetter`) and redeploy. Statements and everything else work without it.

**January organization pass.** The daily letter cron (`runLetterCron`) runs
`runOrgStatementPass` after the person pass whenever `orgAccessEnabled`, even if the tax letter
isn't signed off. For each organization with activity in the prior year it reads the Affiliations
and queues one statement email per Current, Portal-access rep (to the Work Email when set, else the
person's Personal Email). It shares `letterCron.maxTriggersPerRun` with the person pass (what that
pass leaves over); the rest wait for the next day. `org_statement_sends` has a unique index on
`(org_item_id, affiliation_item_id, year)`, so a rerun never sends twice and a rep added later gets
theirs on the next run. The write switch applies as for letters: nothing sends under `hold`,
`unknown` or `off`. The consumer re-checks access at send time and marks the row `skipped` (config
gate off, access removed, no statement, or no email on file); it claims `queued` → `sending`
before emailing, as letters do.

**Retrying a row.** The cron treats any existing row as handled, so neither a `skipped` nor a
stuck `sending` row is retried by it. Find the row, then delete it: the next daily run queues a
fresh one (or, for a row stuck in `sending` where the rep got no email, the same fix). Check first
that the rep's email did not go out.

```sh
npx wrangler d1 execute svbc-member-portal --remote --command \
  "SELECT id, org_item_id, affiliation_item_id, year, status, sent_at FROM org_statement_sends WHERE status IN ('skipped','sending')"
# e.g. staff added a Work Email after a "no email on file" skip. Delete by id; add --env sandbox / the sandbox database name for the sandbox.
npx wrangler d1 execute svbc-member-portal --remote --command "DELETE FROM org_statement_sends WHERE id = <id>"
```

**Translations.** The nine non-English locales' organization strings are drafts and need a native
speaker's check before real organizations see them.

Staff steps are in [`docs/uat/member-portal.md`](../docs/uat/member-portal.md#give-a-rep-portal-access).

## Deploying: the write switch

Every write the portal makes on a donor's behalf is gated by the shared write switch (spec
`../docs/superpowers/specs/2026-10-26-write-switch-design.md`; this Worker holds the canonical
`src/flags.ts`, and its gating is `src/writeSwitch.ts`), read from the `FLAGS` KV namespace
(`wrangler.jsonc` binds both namespace ids, `FLAGS` and `sandbox-FLAGS`):

- `member-portal:writes` — `on` writes normally; `hold` writes nothing and keeps messages on the
  queues (retrying at 1 minute doubling to an hour); `off` runs both consumers against recording
  proxies, logging one `"writeSwitch":"skipped"` line per would-be Monday create or email and
  acking. **A missing key means `off`**; a KV read error behaves like hold (queues not paused).

- `member-portal:log` — `debug` adds redacted payloads to those lines (names, contact details,
  old/new values and login links masked).

| Path | `on` | `hold` | `off` | KV error |
|---|---|---|---|---|
| `POST /` (login link), both change-request POSTs, card regenerate | live | 503 "temporarily unavailable" page | 503 | 503 |
| Every GET, `POST /auth/callback`, `POST /auth/code`, `POST /logout` | live | live | live | live |
| `POST /webhooks/monday/letters` | live | live (row + message; the queue is paused) | skip line, 200, no `letter_sends` row | 503 (Monday retries) |
| Letter cron | runs | skip line | skip line | skip line |
| Retention purges (scheduled) | run | run | run | run |

Under `off` neither the webhook nor the cron creates a `letter_sends` row: a `queued` row that is
never sent would block that donor's letter for good, since the cron skips any donor with a row.
A dry-run letter mints no magic-link token and changes no `letter_sends` row; a dry-run change
request leaves its row `queued`. Nothing re-enqueues either automatically, so neither is written
later unless staff click the letter button again or the donor re-submits. A message queued before
this build has no stamp and is written under `on`. Both main queues retry 100 times (about four
days) before dead-lettering. Set the switch with the operator CLI at the repo root, never by hand —
`writes hold`/`on` also pauses and resumes the queues:

```sh
node scripts/flags.mjs member-portal writes on --env sandbox     # or --env production
node scripts/flags.mjs status --env sandbox
```

**Set `writes on` before deploying** a build that carries the switch, or donors can't sign in.

## Resetting for new board ids

When the People board is deleted and rebuilt (a cutover retry — private runbook, Rollback step 8
— or a sandbox rebuild), every `donor_item_id` in D1 names an item that no longer exists. Reset
D1 before deploying against the new boards, with the custom domain removed (or the Worker
otherwise unreachable) and the letters automation off. The Change Requests and Letter Settings
boards are staff-created and may survive; D1 holds no ids for either.

```sh
# 1. Export, to somewhere outside the repo — change requests hold donors' contact details. The
#    database is unavailable while the export runs (seconds).
npx wrangler d1 export svbc-member-portal --remote --output <dir>/svbc-member-portal.sql

# 2. Change requests donors submitted that never reached the board. Hand any real ones to staff
#    (keep the output out of tickets and chat); they can't be replayed after the reset.
npx wrangler d1 execute svbc-member-portal --remote --command \
  "SELECT id, donor_name, field, old_value, new_value, created_at FROM change_requests WHERE status = 'queued' ORDER BY created_at"

# 3. Reset. -y answers any wrangler confirmation prompt; unanswered without a TTY, one cancels
#    silently with exit 0.
npx wrangler d1 execute svbc-member-portal --remote -y --command \
  "DELETE FROM sessions; DELETE FROM magic_link_tokens; DELETE FROM card_tokens; DELETE FROM change_requests;"

# 4. Check: 0 for each cleared table, and what letter_sends still holds.
npx wrangler d1 execute svbc-member-portal --remote --command \
  "SELECT 'sessions' AS t, COUNT(*) AS n FROM sessions UNION ALL SELECT 'magic_link_tokens', COUNT(*) FROM magic_link_tokens UNION ALL SELECT 'card_tokens', COUNT(*) FROM card_tokens UNION ALL SELECT 'change_requests', COUNT(*) FROM change_requests"
npx wrangler d1 execute svbc-member-portal --remote --command \
  "SELECT year, status, COUNT(*) AS n FROM letter_sends GROUP BY year, status"
```

Sandbox: `svbc-member-portal-sandbox`, with `--env sandbox` on every command. (The check is two
queries because D1 caps a compound `SELECT` at five terms.)

| Table | Reset | Why |
|---|---|---|
| `sessions`, `magic_link_tokens` | cleared | `donor_item_ids` are People items on the old board; a session that outlived the reset would load items that are gone. Donors sign in again. |
| `card_tokens` | cleared | Each token resolves to an old People item, so `/verify` can only fail. A new token is minted on the donor's next portal visit; a card saved before the reset stops verifying. |
| `change_requests` | cleared, after step 2 | `written` rows are spent audit rows; a `queued` row can't be replayed because its donor link is an old item. |
| `letter_sends` | **kept** | The record of letter emails that went out, which a board rebuild doesn't undo. It can no longer dedupe: its key is the old item id, so a donor with a `sent` row for the year being sent gets the email again on the next trigger. If step 4 shows any, settle that with staff before re-arming the send. |
| `login_attempts` | kept | No item ids; rate-limit history the daily cron purges. |

Tested 2026-09-30 on a copy of the sandbox database (the export from step 1 loaded into a
local D1, plus one seeded row per table): the four tables cleared, `letter_sends` kept. Not run
on the deployed sandbox D1, whose boards hadn't changed.

## Development

**Migrations 0007 and 0008 must be applied before this code reaches `main`.** `0007_sign_in_codes.sql`
(sign-in code columns on `magic_link_tokens`, `verified_emails`, `code_failures`) and
`0008_session_email_hash.sql` (`sessions.email_hash`, which `getSession` selects) have to be on
**both** D1 databases before the branch that adds sign-in codes merges. The `deploy-sandbox` job in
`.github/workflows/workers.yml` deploys on every push to `main` and never applies migrations, and
without 0007 every sign-in fails, existing emailed links and letter-ready links included, because
`consumeToken` selects `email_hash`. From `member-portal/`:

```sh
npx wrangler d1 migrations apply svbc-member-portal-sandbox --remote --env sandbox
npx wrangler d1 migrations apply svbc-member-portal --remote
```

The same holds for any later migration: apply it to both databases before merging the code that
reads it (DEPLOY.md, "Schema migrations").

```sh
npm install
npm test            # vitest in workerd (@cloudflare/vitest-plugin), D1 migrations applied per run
npm run typecheck   # wrangler types, then tsc --noEmit — the only supported typecheck
```

Type-check with `npm run typecheck`, never a bare `tsc --noEmit`. Binding types (`DB`, the queues,
`LOGIN_RATE_LIMITER`, `REQUEST_RATE_LIMITER`, …) come from `worker-configuration.d.ts`, which
`wrangler types` generates from `wrangler.jsonc` and which is deliberately not committed (root
`.gitignore`: it can absorb local `.dev.vars` names, and every Worker here regenerates it). A bare
`tsc` reads whatever copy is on disk — missing on a fresh clone, stale after a binding is added —
and fails with errors like `Property 'REQUEST_RATE_LIMITER' does not exist on type 'Env'` that
say nothing about the code. CI (`.github/workflows/workers.yml`) already runs `npm test` and
`npm run typecheck`. The local preview's driver is `.claude/skills/run-member-portal/`.

## Future candidates

The candidate list from the v2 brainstorm (discussed 2026-08-24) is no longer tracked here —
each un-built idea is filed as a Feature Request on the
[IT Requests board](https://bikesiliconvalley.monday.com/boards/8846215481) ("Member portal: …"
items). None are scheduled; each needs its own scoping pass before build.

**Considered and ruled out:** peer-to-peer fundraising pages and DAF tooling (Funraise's job;
heavy build, low value at SVBC's scale), and full self-serve profile editing (the review-queue
model won for rollback safety and audit trail — revisit direct writes only if the queue proves
pure overhead). Two standing architecture decisions to preserve: letters render live from
Monday (no stored PDFs to go stale after a data correction), and Cloudflare Access stays ruled
out for donor auth (it's a per-seat staff tool; magic-link auth is the scope match).

## Sources

* `migration-plan.md` (private planning repo) — Integrations: Donor self-service portal
* `docs/06-staff-process-guide.md` (private planning repo) §§1, 2, 8
* [Cloudflare Email Service docs](https://developers.cloudflare.com/email-service/)
* [MailChannels — End of Life Notice (Cloudflare Workers free integration)](https://support.mailchannels.com/hc/en-us/articles/26814255454093-End-of-Life-Notice-Cloudflare-Workers)
