# Member portal sign-in: a code beside the link, every personal address, verified addresses

Date: 2026-11-18. Worker: `member-portal`. Status: design, approved approaches (below).

First of two pieces of the member portal rework. The second, the "card first" home page and
navigation, follows this one and is designed separately.

## Why

The portal's two visits that matter most are the **welcome after a first gift** (the Mailchimp
welcome Journey links to it) and the **January tax-letter visit**. Both start at sign-in, and
sign-in is where they fail:

* **Two emails before anything shows.** The welcome email sends the member to the portal, which
  sends a second email with a link. Someone who asked on a laptop but reads mail on a phone opens
  the link on the wrong device. A code they can type where they asked fixes that; Givebutter,
  WeGive and HelpYouSponsor pair a code with (or instead of) a link for this reason.
* **Only one address works.** Sign-in searches People's Personal Email only. A member who types
  their Household Email gets the generic "check your email" page and nothing ever arrives
  (the page deliberately can't say "not found"), so the portal just looks broken.
* **We never learn which addresses are real.** Nothing records that a person proved control of an
  address. Mailchimp "Subscribed" means "may email", not "theirs": most contacts were imported,
  and donors who never subscribed aren't in Mailchimp at all. A completed portal sign-in is the
  one signal that covers every member, and the welcome visit is when most members would produce
  it.

## Goals

1. Every sign-in email carries a 6-digit code as well as the link. Either one signs the member
   in; using one spends both.
2. A member can request sign-in with their **Personal Email or Household Email**.
3. Each completed sign-in records the address it was sent to as **verified** for the person (or
   people) it signed in.

## Non-goals

* **Work Email** (on Affiliations). Excluded on purpose: a work address outlives the job, so a
  former employer could sign in as the member.
* **Other Emails.** It exists only in the 2026-09-08 email-model spec, not on the production
  People board. Add it to the lookup if and when the column exists.
* **Organizations** signing in for their own gifts. Out of scope.
* **Showing** verified status to members or staff. The "Your info & emails" page that labels
  addresses (Verified / Subscribed / On file) is part of the home-page piece. No Monday column.
* **Mailchimp double opt-in** as a second verification source (`ip_opt` / `timestamp_opt`). Later,
  if it turns out to matter.
* **Letter-ready emails** (`sendLetterReadyEmail`). They stay link-only: they aren't started from
  a browser, so there is no request cookie for a code to bind to, and their links live up to
  `letterLinkTtlHours` (168 h), far too long for a 6-digit code.
* A personal sign-in link inside the Mailchimp welcome email. Rejected: the token would sit in a
  Mailchimp merge field, live for weeks, and work for anyone the email is forwarded to.

## Anti-goals (would make this a failure even if it works)

* **Breaking the enumeration guard.** `POST /` must stay indistinguishable for matching and
  non-matching addresses: same page, same cookies, same timing (the lookup and send stay deferred
  through `waitUntil`).
* **A guessable code.** A 6-digit code is safe only bound to one request and capped on attempts.
* **Locking out a first-time donor.** Whatever finds the person must see an item created minutes
  ago, so the welcome email works the same day.

## Constraints (from the existing Worker)

* No JavaScript on portal pages beyond the confirm page's one hashed script; forms post to the
  server; CSRF check on every POST (`CSRF_EXEMPT` stays as it is).
* Every string localized in all ten locales (`src/i18n`), AI-drafted as with existing strings.
* D1 holds only hashes of tokens and addresses (issues #62, GL#61). Magic-link TTL is
  `auth.magicLinkTtlMinutes` (15).
* Config, not hardcoding: a new column id goes in `config/svbc.json` and `config/sandbox.json`,
  gated on the `REPLACE_WITH_COLUMN_ID` placeholder like `preferredLanguage`.
* Sandbox environment and the write switch apply as they do today: `POST /` is already gated by
  `writeGate`; the code-verification POST is not, matching `POST /auth/callback` (neither writes
  to Monday).

## Approaches considered

**Finding the person from either address**

* **A — chosen: one live Monday search over both columns.** `findDonorsByEmail` gains a second
  rule (Household Email) with `operator: or`, and the existing exact-match filter (GL#62) keeps an
  item if either column equals the submitted address. Always current; a small change in one
  function.
* B — read `impact-attribution`'s `email_index` (D1). Rejected: rebuilt nightly at 11:00 UTC, so a
  same-day first-time donor isn't found, breaking the welcome visit; and it couples the public
  portal to another Worker's database.

**Binding a typed code to its request**

* **A — chosen: a short-lived request cookie.** `POST /` sets an opaque request id in an httpOnly
  cookie; the "check your email" page asks only for the 6 digits. Covers asking on a laptop,
  reading on a phone, typing the code back on the laptop. Asking on one device and typing on
  another isn't covered; that member clicks the link.
* B — ask for email and code together. Rejected: an extra field at the exact moment people drop
  off, plus a separate per-address guessing limit.

## Design

### Lookup

* New config column `donorHouseholdEmail` (People's Household Email; production and sandbox ids
  to be read from the boards). While it is the placeholder, the query is exactly today's
  Personal-Email-only search.
* Match = Personal Email **or** Household Email equals the address (trimmed, lowercased).
  Household Email may match several people: that is the existing shared-address case, and every
  match is signed in together, labeled by name, as today.
* The preferred-language rule is unchanged (first match's preference, else the page's locale).

### Request (`POST /`)

1. Whenever the request gets past the rate limiters (match or not, valid address or not),
   generate a random **request id** and set cookie `login_request`: httpOnly, Secure,
   SameSite=Lax, path `/`, max-age = magic-link TTL. Setting it regardless of match keeps the
   guard.
   **When a rate limiter denies the request, leave any existing cookie alone** (builder-check
   call). Otherwise a double-click, a refresh or "it didn't arrive, try again" inside the 60 s
   cooldown would replace the cookie with one pointing at nothing, and the one code that does
   arrive would fail. This doesn't leak a match: a denial depends on earlier requests for that
   address or IP, never on whether it matched anyone.
2. Pass the request id to the deferred `requestLogin`. On a match it generates the link token and a
   **6-digit code** (uniform 000000–999999 from `crypto.getRandomValues`, rejection-sampled), and
   writes one `magic_link_tokens` row holding:
   `token_hash`, `request_hash` (SHA-256 of the request id), `code_hash` (SHA-256 of
   `request id + ':' + code`), `email_hash` (SHA-256 of the lowercased address, as
   `login_attempts` hashes it), `donor_item_ids`, `expires_at`, `failed_code_attempts` (0),
   `used_at`.
3. The email shows the code large, above the link, in both the HTML and the text part, with
   one line saying it works on the page where they asked.
4. No match: no row, no email. The cookie still points nowhere, so a code typed against it fails
   like a wrong code.

A new request overwrites the cookie; the earlier request's link still works, its code no longer
can from that browser.

### "Check your email" page

Adds a form under the existing message: one input (`inputmode="numeric"`,
`autocomplete="one-time-code"`, `maxlength=6`), a submit button, and a hidden `next` carried from
the sign-in form so return-to-after-sign-in (#127) works for codes too. Posts to a new
`POST /auth/code`. A wrong code re-renders this page with a short error ("That code didn't work.
Check it, or ask for a new email.") and the form.

### Verifying a code (`POST /auth/code`)

* CSRF-checked like every form. Rate-limited per IP with the existing `ipLimiter`.
* Read `login_request` cookie → `request_hash`. Missing cookie → the same wrong-code page.
* **Per-request cap: 5 tries.** Count the attempt and check the cap in one statement, so parallel
  guesses can't slip past it: increment `failed_code_attempts` for the `request_hash` only while
  it is under 5 and the row is unused and unexpired, then claim (`SET used_at = now`) only if
  `code_hash` matches (a correct try also counts; that's harmless, since the row is then spent,
  but the per-address count below should count only wrong tries). After 5 the code is dead; the **link** stays
  valid until it expires (it isn't guessable).
* **Per-address cap: 10 wrong codes per 24 h** (builder-check call; config
  `rateLimit.codeFailuresPerAddressDaily`). Without it, someone can request sign-ins for a
  donor's address from their own browser and guess: 10 requests a day × 5 tries is about 1 in
  20,000 a day, roughly 2 % a year, and rotating IPs beats the per-IP limiter. Counted over
  `magic_link_tokens.failed_code_attempts` by `email_hash`. Once reached, codes for that address
  are refused (same wrong-code page) until the window passes; links still work, so a member is
  never locked out.
* After a code sign-in the redirect uses the page's locale (there is no link `lang` on this
  path).
* On success: create the session and redirect exactly as `POST /auth/callback` does (same
  cookie, same `next` handling, 303), and clear `login_request`.
* The link path (`POST /auth/callback`) is unchanged except that consuming the row also spends
  the code (same `used_at`), and it records verification (below).

### Verified addresses

New D1 table `verified_emails (email_hash, person_item_id, first_verified_at, last_verified_at,
PRIMARY KEY (email_hash, person_item_id))`. Every successful sign-in, by link or code, upserts
one row per id in the request's `donor_item_ids` with the request's `email_hash`. Not purged by
`purgeExpiredAuth`: it is the durable record. A failure writing it is logged and does not block
the sign-in.

Letter-ready links write a `magic_link_tokens` row too; those have no `email_hash` and record
nothing (the address wasn't chosen by the member, though clicking does show control — revisit if
the home-page piece wants it).

### Migration and rollout

* One D1 migration: add `request_hash`, `code_hash`, `email_hash`, `failed_code_attempts` to
  `magic_link_tokens` (nullable, so letter rows and pre-deploy rows keep working), index
  `request_hash`, create `verified_emails`. Apply before deploying the build that reads it.
* Fill `donorHouseholdEmail` in both configs; until then lookup is Personal-only and the rest
  ships.
* Update the staff UAT script (`docs/uat/member-portal.md`) and the README's Auth section.

## Left to the builder

Names of functions, files, i18n keys and the migration number; exact copy within the meaning
above; test layout (unit tests for code generation, the claim/attempt SQL, lookup with both
columns, the unconditional cookie, verification upserts; route tests for the code POST including
a missing cookie, an expired row, the fifth failure and a used link); whether the per-IP limit on
`POST /auth/code` reuses the login limiter's namespace or needs its own (if its own, add it to
`check-rate-limit-namespaces.mjs`'s uniqueness rules).
