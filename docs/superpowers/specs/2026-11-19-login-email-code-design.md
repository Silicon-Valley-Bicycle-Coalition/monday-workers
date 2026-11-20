# Login email one-time code (member-portal)

Status: design, 2026-11-19. Worker: `member-portal`.

## Why

A donor who asks for a login link has to leave the browser they're in, open Mail, and tap a link
that may open in a different browser or app. The goal is to **keep the donor in the page they
started on**: the login email also carries a 6-digit code, and the "check your email" page gets a
code box. On Apple devices (iOS 17+ / macOS Sonoma+, Safari; iOS 26 widens this), Password
AutoFill reads codes from Mail and offers them above the keyboard, so signing in takes one tap
with no app switch. Elsewhere the donor types the code, or just uses the link as today.

Apple publishes no format spec for email codes (only the domain-bound SMS format). Detection is
heuristic, so the email follows the SMS convention and common practice, and is verified by hand in
Apple Mail.

## Goals

- The login email carries a 6-digit numeric code and the existing link; either one signs in.
- The "check your email" page shows a code form that Apple AutoFill fills
  (`autocomplete="one-time-code"`).
- Using either the code or the link uses up both.
- The email says when the code and link expire, as a printed time.
- The check-email page offers a **Send again** button once the email has had time to arrive.

## Non-goals

- Letter-ready emails (`processLetterSendBatch`) stay link-only: no requesting browser to type
  into.
- No SMS, WebOTP, passkeys or "remember this device".
- No live "Expired" state in the email. Email CSS can't tell time; animation delays restart on
  each open, and a server-rendered status image is frozen by Apple Mail Privacy Protection and
  Gmail's image proxy (and would be an open tracker).
- Test accounts (`deps.testAccounts`) are unchanged: they sign in instantly and never see the
  code page.

## Anti-goals (a failure even if it works)

- **Anything that reveals whether an email is on file.** `POST /` today returns the same page for
  every address and defers the D1 write and send past the response (latency guard). The code page,
  the cookie, and every code-check response must be identical for matched, unmatched,
  rate-limited and malformed addresses.
- **A code usable from any browser but the one that asked.** A 6-digit code is only safe because
  it's bound to the requesting browser.
- **A per-address limit that blocks signing in.** GL#62 closed a hole where an attacker could keep
  a donor from getting login emails. The daily code-guess limit below is allowed only because it
  never touches the link: a donor whose codes are spent for the day still signs in by link.

## Approaches considered

- **A. Browser-bound code (chosen).** `POST /` sets a short-lived cookie with a random request
  id; the code only verifies alongside that cookie, 5 tries, then burned. A 6-digit code is safe
  (no remote guessing), it's the format AutoFill expects, and the donor sees nothing extra.
- **B. Email-bound code.** Verify (email, code). No cookie, but guessable from anywhere, and the
  attempt limit becomes a per-address lockout lever. Rejected.
- **C. Longer unbound code (8+ chars).** Typing cost is moot (the link is the fallback), but long
  alphanumeric codes risk not being detected by AutoFill, and an unbound 8-digit numeric code is
  guessable across all live codes at once. Rejected.

## Design

### Flow

1. **`POST /`** (login form). For **every** submission that reaches the check-email page
   (matched, unmatched, malformed, rate-limited, request failure), generate a 32-byte random
   request id and set it as `__Host-login-request`: `HttpOnly`, `Secure`, `SameSite=Lax`,
   `Path=/`, `Max-Age` = `magicLinkTtlMinutes * 60`. No D1 write happens in the response path.
   The deferred `requestLogin` work receives the request id. When the address matches, it stores
   `request_hash = sha256(requestId)` and the code hash on the same `magic_link_tokens` row as the
   link token. Unmatched addresses write nothing, as today.
   - The write-gate `unavailable` response and test-account sign-in don't set the cookie (they
     don't render the check-email page).
2. **Check-email page** (`checkEmailView`) gains a form posting to `POST /auth/code`:
   - `<input name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}"
     maxlength="6" required>` with a visible label, plus a hidden `next` (the already-validated
     `portalReturnPath`) and `lang`.
   - Copy (en; final wording is the builder's): "Enter the 6-digit code from the email, or use
     its link."
   - **Resend** (added 2026-11-19 at David's request): below the code form, "Didn't get it? Check
     your spam folder, or send it again." and a **Send again** button. It is a small form that
     re-POSTs `/` with the same `email` (hidden field, the donor's own input echoed back,
     escaped) and `next`, so it goes through the same rate limits, the same deferred send and the
     same identical response. The repeat-request rule below keeps the browser's request id, so
     the codes from both emails work.
     - The button appears after `rateLimit.emailCooldownSeconds` (60 s), the point where a resend
       would no longer be refused by the cooldown. No script: a CSS animation keeps it
       `visibility: hidden` for that delay (`animation: <name> <delay>s steps(1, end)`, keyframe
       `0% { visibility: hidden }`), so if animations are disabled it simply shows at once and
       the server-side cooldown still applies. Hidden content isn't announced, so the help text
       stays visible throughout.
     - Because the page now holds the email address, the check-email response sets
       `Cache-Control: no-store` (the existing `NO_STORE` constant).
     - Not behind `loginCodeEnabled` (my call): it helps link-only donors too and changes nothing
       about the email. A malformed address renders no resend form (nothing to resend); this
       varies with the input's format only, never with whether it's on file.
3. **`POST /auth/code`** (new; covered by the app-wide CSRF check, not exempt):
   - Read the cookie. Missing cookie, malformed code, unknown request, wrong code, expired, used,
     or attempts spent: **all** re-render the check-email page with one generic error ("That code
     didn't work or has expired. Check the email again, or use its link.") and status 200.
   - Rate-limit by IP with the existing limiter binding under a distinct key prefix (the
     change-request routes do the same), checked before touching D1. A denied request gets the
     same generic error.
   - Attempts: at most **5 code checks per browser request id** (see "Repeat requests" below),
     enforced atomically in D1 (the count only increases while a row is unused and unexpired; once
     it reaches 5, no code can succeed even with the right digits). Links stay usable after the
     codes are burned, until they expire.
   - Success: mark the row used (`used_at`, which also kills the link), create a session exactly as
     `verifyLogin` does, set `__Host-session`, delete `__Host-login-request`, redirect to `next`
     or the portal home in the row's stored locale, same as `POST /auth/callback`.
   - The write gate: behave as `POST /auth/callback` does today (signing in isn't a Monday
     write).
4. **`POST /auth/callback`** (link) is unchanged except that consuming the token also makes the
   code unusable. It already does, because both live on one row and `used_at` gates both.

**Repeat requests from one browser** (my call). If `POST /` arrives with a valid-format
`__Host-login-request` already present, it **keeps that request id** and re-sets the cookie with a
fresh `Max-Age`, rather than minting a new one; otherwise it mints one. Every response still sets
the cookie with identical attributes, so nothing varies by address. The reason: the per-address
cooldown (60 s) refuses a quick second request without sending, and a fresh id there would orphan
the first email's code. With one id per browser, several rows can share a `request_hash`, and a
code check matches against any unused, unexpired row for it. The 5-attempt cap is **per browser
request id**: each check increments `code_attempts` on every live row for that hash, and a row
whose count has reached 5 can't succeed. Any code from that browser's recent emails works, so
the copy says "the code from the email" rather than "the newest email".

**Attacker-started requests and the daily guess limit** (added 2026-11-19 after review). The
browser binding stops guessing at *someone else's* request, but an attacker can type a donor's
address into the login form in their own browser: the code goes to the donor, the cookie to the
attacker. So, decided with David:

- **Per request:** at most 5 checks across all of a request's rows. A row created for a request
  that already has live rows starts at their current count, so a resend never buys fresh guesses
  at older codes; and a check only matches rows it counted against.
- **Per address:** at most **10 code checks per 24 hours** for an address, across every browser,
  counted in a new `login_code_checks (email_hash, checked_at)` table (`email_hash` =
  `sha256` of the lowercased address, as in `login_attempts`). Over the limit, every code for that
  address fails with the usual generic error until the oldest check is 24 hours old; links are
  unaffected. Bound: about 10 guesses a day per targeted donor, roughly 1 in 100,000 per day.
- **One address per request:** `magic_link_tokens` gains `email_hash`. Creating a code row for a
  request marks any live rows of that request with a *different* `email_hash` as used, so a
  browser asking for two addresses can't charge guesses at one address to the other's budget.
- The purge deletes `login_code_checks` rows older than `rateLimit.attemptRetentionHours`
  (validated to be at least 24).

**Language** (my call): `requestLogin` stores the locale it resolved (Monday preference over the
browser hint) on the row in a new `locale` column. `POST /auth/code` lands the donor in that
locale, as the link does, not in the form's `lang`; the form's `lang` is used only to render
error responses.

**Switch** (my call): a new `auth.loginCodeEnabled` config flag (`svbc.json`, `sandbox.json`).
When `false`, `POST /` sets no request cookie, the check-email page shows no code form,
`POST /auth/code` re-renders the generic error, and the email is today's (no code in the subject,
body or last line). The code ships enabled in sandbox and disabled in production until the
AutoFill check below passes. The flag lives in config, so flipping it is a deploy (my call: no
KV flag, since it isn't an outage control).

### Code generation and storage

- 6 digits, uniformly random (`crypto.getRandomValues` with rejection sampling, no modulo bias),
  leading zeros kept.
- `code_hash = sha256(requestId + ':' + code)`. The raw request id exists only in the cookie, so a
  leaked table can't be brute-forced over the 10⁶ code space. Neither the code, the request id
  nor the email is ever logged (`check-log-safety`).
- Migration `0007_login_codes.sql`, additive:
  `ALTER TABLE magic_link_tokens ADD COLUMN request_hash TEXT;`
  `ALTER TABLE magic_link_tokens ADD COLUMN code_hash TEXT;`
  `ALTER TABLE magic_link_tokens ADD COLUMN code_attempts INTEGER NOT NULL DEFAULT 0;`
  `ALTER TABLE magic_link_tokens ADD COLUMN locale TEXT;`
  `ALTER TABLE magic_link_tokens ADD COLUMN email_hash TEXT;`
  `CREATE TABLE login_code_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, email_hash TEXT NOT NULL, checked_at TEXT NOT NULL);`
  with indexes on `(email_hash, checked_at)` and `(checked_at)`,
  plus an index on `request_hash`. Letter-ready rows leave the new columns null. The retention
  purge needs no change (it deletes by `expires_at`).

### The email

- **Subject** (my call; easy to drop): `🚴 123456 is your SVBC member portal code`, translated.
  The code in the subject makes it visible in notifications and Mail's list, and is the common
  shape AutoFill recognises. Lock-screen exposure is acceptable because the code is useless
  without the requesting browser's cookie.
- **Body**, HTML and text alike: the intro, the code shown large and selectable (HTML: its own
  paragraph, monospace, letter-spaced; no images), the "Log in" link as today, then the expiry
  line, and as the **last line** the domain-bound form
  `@member.bikesiliconvalley.org #123456` (host from `portalBaseUrl`, so the sandbox gets its own).
- **Expiry line:** "This code and link expire at 3:15 PM Pacific time." The time is
  `expiresAt` formatted with `Intl.DateTimeFormat` in the donor's locale and a new config value
  `auth.displayTimeZone` (`America/Los_Angeles` in `svbc.json` and `sandbox.json`; validated as an
  IANA zone at startup). The zone's display name comes from `Intl`, not a hard-coded "Pacific".
- `SendLoginEmailParams` gains `code` and `expiresAt`. `devEmail.ts` and the sandbox binding pass
  them through.

### Translations

Every new string (check-email form label, button, help, error, email subject, code intro, expiry
line) goes into all 10 locales (`en`, `es`, `fil`, `hi`, `ja`, `ko`, `pt-BR`, `vi`, `zh-Hans`,
`zh-Hant`), following the existing per-locale test pattern.

### Tests

- `POST /` sets `__Host-login-request` with identical attributes for matched, unmatched,
  malformed and rate-limited addresses, and returns byte-identical bodies apart from nothing
  request-specific (no request id in the HTML).
- `POST /auth/code`: right code signs in and redirects to `next`; wrong code, no cookie, other
  browser's cookie, expired, already used via link, 6th attempt with the right code: all the same
  generic page.
- Using the code burns the link, and using the link burns the code.
- Concurrent wrong guesses can't exceed 5 checks.
- Code generator: always 6 digits, leading zeros possible, no modulo bias (sampled distribution).
- Email: code in subject, body (HTML and text), last line is the domain-bound form, expiry time
  rendered in the configured zone per locale.
- `config/split.test.ts` still passes with the new config key.

### Manual verification (can't be automated)

Run in **production**, against David's own donor record, after deploy with
`auth.loginCodeEnabled` still `false`:

1. Set `loginCodeEnabled: true` in `config/svbc.json` and deploy.
2. Request a login for David's address in Safari on iOS and on macOS, with that mailbox in Apple
   Mail. Confirm AutoFill offers the code on the check-email page, and note any delay.
3. If it works, leave it on. If not, set it back to `false` and deploy. While it's on, every
   donor gets the code email; its link works either way, so a failed check costs nothing.

The sandbox exercises everything else (it ships enabled there), but its subject prefix and notice
paragraph make it unreliable for the AutoFill check. Record the result in the PR.

## Left to the builder

- Exact D1 statements for the atomic attempt-and-claim, and whether it's one statement or two.
- Final copy in English (meaning as above), and the code's HTML styling within
  `docs/design-system/` tokens.
- Whether the code form autofocuses its input (fine here: no token on this page, unlike
  `/auth/callback`).
