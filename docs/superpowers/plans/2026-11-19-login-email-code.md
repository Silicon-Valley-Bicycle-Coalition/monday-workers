# Login Email One-Time Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The member-portal login email carries a browser-bound 6-digit code that Apple AutoFill can fill on the "check your email" page, alongside the existing magic link.

**Architecture:** `POST /` sets a `__Host-login-request` cookie (random request id) for every submission; the deferred `requestLogin` stores `sha256(requestId)` and `sha256(requestId:code)` on the same `magic_link_tokens` row as the link token. A new `POST /auth/code` checks the code against that cookie's rows, at most 5 checks, and signs in exactly as `POST /auth/callback` does. Everything is behind `auth.loginCodeEnabled`.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1, Vitest (`@cloudflare/vitest-pool-workers`).

**Spec:** `docs/superpowers/specs/2026-11-19-login-email-code-design.md`

All commands run from `member-portal/`. Worker tests need the sandbox disabled (workerd binds a port).

## Global Constraints

- Every response of `POST /` is identical for matched, unmatched, malformed and rate-limited addresses, including the `Set-Cookie` attributes. No D1 write in its response path.
- Every failure of `POST /auth/code` (no cookie, bad format, wrong, expired, used, attempts spent, IP-limited, switch off) renders the same check-email page with the same error, status 200.
- Code: exactly 6 digits, uniform, leading zeros kept. Max **5** code checks per request id.
- Cookie: `__Host-login-request`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age = magicLinkTtlMinutes * 60`, value 64 lowercase hex chars.
- Never log the code, request id or email (`node ../scripts/check-log-safety.mjs`).
- Every new i18n key goes into all 10 locales in the same task (`en es fil hi ja ko pt-BR vi zh-Hans zh-Hant`); the per-locale tests fail otherwise.
- `auth.loginCodeEnabled`: `false` in `config/svbc.json`, `true` in `config/sandbox.json` and `config/local.json`. `auth.displayTimeZone`: `"America/Los_Angeles"` in all three.
- Letter-ready emails (`processLetterSendBatch`) and test accounts are unchanged.
- Type-check with `npm run typecheck`, never bare `tsc`.

## Review Focus

- Code typed with spaces or pasted as `123 456`: whitespace stripped before the format check (Task 7 test `accepts a code with spaces`).
- Back button or reload resubmits `POST /` inside the 60 s cooldown: the existing request id is kept, so the first email's code still works (Task 7 test `keeps the request id on a repeat request`).
- Double-tap on "Sign in" sends the right code twice: one sign-in, the second gets the generic error, never a 500 (Task 3 test `consumeCode succeeds once`).
- Donor taps **Send again** before the first email arrives (inside the cooldown): same page, no second email, the first code still works (Task 7 test `resend goes through the cooldown`).
- Non-English donor: expiry time formats in their locale without throwing (Task 4 test `formats in every supported locale`).

---

### Task 1: Config keys

**Files:**
- Modify: `src/types.ts` (the `auth` block, ~line 261), `src/config.ts` (`REQUIRED_AUTH_KEYS` and the `auth` validation, ~line 209), `config/svbc.json`, `config/sandbox.json`, `config/local.json`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces: `config.auth.loginCodeEnabled: boolean`, `config.auth.displayTimeZone: string`.

- [ ] **Step 1: Write failing tests** in `src/config.test.ts`:
  - `rejects a non-boolean auth.loginCodeEnabled` → `loadConfig` (or the file's existing validator entry point) throws matching `/auth.loginCodeEnabled/`.
  - `rejects an unknown auth.displayTimeZone` (`"Mars/Base"`) → throws matching `/auth.displayTimeZone/`.
  - `ships the login code off in production and on in sandbox` → `svbc.json` `false`, `sandbox.json` `true`, both zones `"America/Los_Angeles"`.
- [ ] **Step 2:** `npm test -- src/config.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Add both keys to `REQUIRED_AUTH_KEYS` and the type (comment: what the switch hides; zone is for the email's expiry line). Validate the zone with `new Intl.DateTimeFormat('en', { timeZone })` inside try/catch. Add values to the three JSON files.
- [ ] **Step 4:** `npm test -- src/config.test.ts config/split.test.ts` → PASS; `npm run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(member-portal): config switch and display zone for login codes`.

### Task 2: Code primitives

**Files:**
- Create: `src/auth/loginCode.ts`
- Test: `src/auth/loginCode.test.ts`

**Interfaces:**
- Produces:
  - `generateLoginCode(): string` — 6 digits.
  - `normalizeLoginCode(input: unknown): string | null` — strips all whitespace; returns the string if `/^[0-9]{6}$/`, else `null`.
  - `isRequestId(value: unknown): value is string` — `/^[0-9a-f]{64}$/`.
  - `hashLoginCode(requestId: string, code: string): Promise<string>` — `sha256Hex(`${requestId}:${code}`)`.
  - `LOGIN_CODE_MAX_ATTEMPTS = 5`.

- [ ] **Step 1: Write failing tests:** `generateLoginCode` returns `/^[0-9]{6}$/` over 1,000 draws and yields at least one code starting with `0` over 10,000 draws; `normalizeLoginCode(' 012 345 ')` → `'012345'`, `('12345')` → `null`, `('1234567')` → `null`, `('12a456')` → `null`, `(42)` → `null`; `isRequestId` accepts `generateToken()` output and rejects `'abc'`; `hashLoginCode('r','123456')` equals `sha256Hex('r:123456')`.
- [ ] **Step 2:** `npm test -- src/auth/loginCode.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Generation draws a `Uint32Array(1)` and rejects values `>= 4_294_000_000` (the largest multiple of 10⁶ below 2³²), then `% 1_000_000` and `padStart(6, '0')`.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5: Commit** `feat(member-portal): login code generation and hashing`.

### Task 3: Migration and token store

**Files:**
- Create: `migrations/0007_login_codes.sql`
- Modify: `src/db/tokens.ts`
- Test: `src/db/tokens.test.ts`

**Interfaces:**
- Consumes: `LOGIN_CODE_MAX_ATTEMPTS` (Task 2).
- Produces:
  - `NewMagicLinkToken` gains optional `requestHash?: string`, `codeHash?: string`, `locale?: Locale`.
  - `MagicLinkTokenStore.consumeCode(requestHash: string, codeHash: string, nowISO: string): Promise<{ donorItemIds: string[]; locale: Locale | null } | null>`.

- [ ] **Step 1: Write the migration** (additive): `request_hash TEXT`, `code_hash TEXT`, `code_attempts INTEGER NOT NULL DEFAULT 0`, `locale TEXT` on `magic_link_tokens`, and `CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_request_hash ON magic_link_tokens (request_hash)`. Comment header in the style of `0005`.
- [ ] **Step 2: Write failing tests** in `src/db/tokens.test.ts`:
  - `consumeCode succeeds once` → right code returns `{ donorItemIds, locale: 'es' }`, a second call with the right code returns `null`.
  - `consumeCode burns the link` → after it, `consumeToken(tokenHash)` returns `null`; and `consumeToken burns the code` the other way round.
  - `consumeCode stops after 5 checks` → 5 wrong calls then the right code → `null`.
  - `consumeCode matches any live row for the request` → two rows with one `requestHash`, different codes; the first row's code succeeds.
  - `consumeCode ignores expired rows` and `returns null for an unknown request`.
  - `concurrent wrong guesses cannot exceed 5` → `Promise.all` of 8 wrong calls, then read `code_attempts` directly: every row `<= 5`.
  - A row created without code fields (letter-ready) is never matched by `consumeCode`.
- [ ] **Step 3:** `npm test -- src/db/tokens.test.ts` → FAIL.
- [ ] **Step 4: Implement.** `createToken` binds the new columns (null when absent). `consumeCode` runs two statements:
  1. `UPDATE magic_link_tokens SET code_attempts = code_attempts + 1 WHERE request_hash = ?1 AND used_at IS NULL AND expires_at > ?2 AND code_attempts < 5`; if `meta.changes === 0`, return `null`.
  2. `UPDATE magic_link_tokens SET used_at = ?2 WHERE request_hash = ?1 AND code_hash = ?3 AND used_at IS NULL AND expires_at > ?2 AND code_attempts <= 5 RETURNING donor_item_ids, locale`; no row → `null`. Read `locale` through `isLocale`, else `null`.
- [ ] **Step 5:** Tests PASS.
- [ ] **Step 6: Commit** `feat(member-portal): store and check login codes on magic-link rows`.

### Task 4: Login email with code

**Files:**
- Create: `src/email/expiryTime.ts`
- Modify: `src/email/types.ts`, `src/email/cloudflareEmail.ts`, `src/email/devEmail.ts`, `src/i18n/locales/*.ts` (all 10)
- Test: `src/email/expiryTime.test.ts`, `src/email/cloudflareEmail.test.ts`

**Interfaces:**
- Produces:
  - `formatExpiryTime(expiresAtISO: string, locale: Locale, timeZone: string): string` — `Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' })`.
  - `SendLoginEmailParams.loginCode?: { code: string; expiresAt: string; timeZone: string; domain: string }`. Absent → today's email exactly.
- i18n keys (en copy; translate the meaning): `email.subjectWithCode` = `{{code}} is your SVBC member portal code`; `email.codeIntro` = `Your login code:`; `email.codeOrLink` = `Enter it on the page where you asked to log in, or use the link below.`; `email.codeExpiry` = `This code and link expire at {{time}}.`

- [ ] **Step 1: Write failing tests:**
  - `formatExpiryTime('2026-11-19T23:15:00.000Z', 'en', 'America/Los_Angeles').replace(/\s/g, ' ')` → `'3:15 PM PST'`.
  - `formats in every supported locale` → for each locale, a non-empty string containing `15`.
  - Login email with `loginCode`: subject `🚴 012345 is your SVBC member portal code`; HTML and text both contain `012345`, the link and the expiry line; the **text** body's last non-empty line is exactly `@member.bikesiliconvalley.org #012345`, and the HTML body ends with that line too (in its own `<p>`, after the layout's content and before the footer, whatever `renderEmailLayout` allows; if the layout appends a footer, put the line in `bodyText`'s end and assert on the text body only).
  - Without `loginCode`: subject and bodies equal today's output (existing tests stay green unchanged).
- [ ] **Step 2:** `npm test -- src/email` → FAIL.
- [ ] **Step 3: Implement.** Code in HTML: its own paragraph, monospace, letter-spaced, sized per `docs/design-system/tokens.json`. `devEmail.ts` also prints the code. Add the four keys to all 10 locales.
- [ ] **Step 4:** `npm test -- src/email src/i18n` → PASS.
- [ ] **Step 5: Commit** `feat(member-portal): put the login code and expiry in the login email`.

### Task 5: requestLogin generates and stores the code

**Files:**
- Modify: `src/auth/requestLogin.ts`
- Test: `src/auth/requestLogin.test.ts`

**Interfaces:**
- Consumes: Task 2 primitives, Task 3 `createToken` fields, Task 4 `loginCode` param.
- Produces: `RequestLoginDeps` gains `displayTimeZone: string`; `requestLogin(email, localeHint, deps, next = null, requestId: string | null = null)`.

- [ ] **Step 1: Write failing tests:**
  - With `requestId`: `createToken` gets `requestHash = sha256Hex(requestId)`, `codeHash = hashLoginCode(requestId, sentCode)` and the resolved `locale`; `sendLoginEmail` gets `loginCode` with that code, the row's `expiresAt`, `displayTimeZone`, and `domain = new URL(portalBaseUrl).host`.
  - Without `requestId`: no code fields, no `loginCode` (today's behaviour).
  - Unmatched email with `requestId`: no write, no send.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(member-portal): issue a login code with each login link`.

### Task 6: Check-email page with code form

**Files:**
- Modify: `src/views.ts` (`checkEmailView`), `src/i18n/locales/*.ts` (all 10)
- Test: `src/views.test.ts`

**Interfaces:**
- Produces: `checkEmailView(locale: Locale, options: { codeForm?: { next: string | null; error: boolean }; resend?: { email: string; next: string | null; delaySeconds: number } } = {}): string`.
- i18n keys: `checkEmail.codeLabel` = `6-digit code`; `checkEmail.codeSubmit` = `Log in`; `checkEmail.codeHelp` = `Enter the 6-digit code from the email, or use its link.`; `checkEmail.codeError` = `That code didn't work or has expired. Check the email again, or use its link.`; `checkEmail.resendHelp` = `Didn't get it? Check your spam folder, or send it again.`; `checkEmail.resend` = `Send again`

- [ ] **Step 1: Write failing tests:** with a form: `<form method="post" action="/auth/code">`, an input with `name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required` and a `<label for>` matching its `id`, hidden `lang`, hidden `next` only when non-null (escaped); `error: true` renders `checkEmail.codeError` in an element with `role="alert"`; `{}` renders today's page exactly. With `resend`: help text always visible; a `<form method="post" action="/">` with hidden `email` (escaped: test with `a"<b@x.org`), hidden `next` when non-null, hidden `lang`, and a `Send again` button inside an element whose inline `style` carries `animation-duration: 60s` for `delaySeconds: 60`; the page CSS defines the keyframes with `0% { visibility: hidden }` and `steps(1, end)`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; add keys to all 10 locales. **Step 4:** `npm test -- src/views.test.ts src/i18n` → PASS.
- [ ] **Step 5: Commit** `feat(member-portal): code form on the check-email page`.

### Task 7: Routes

**Files:**
- Modify: `src/routes.ts` (`POST /` ~line 379, new `POST /auth/code` after `POST /auth/callback` ~line 518)
- Test: `src/routes.test.ts` (use the existing `makeDeps`)

**Interfaces:**
- Consumes: everything above.
- Produces: `LOGIN_REQUEST_COOKIE = '__Host-login-request'`; route `POST /auth/code` (CSRF-checked, not in `CSRF_EXEMPT`).
- The check-email page (from `POST /` and from `POST /auth/code` errors) passes `resend: { email, next, delaySeconds: config.rateLimit.emailCooldownSeconds }` whenever the submitted email passed `isPlausibleEmail`, regardless of `loginCodeEnabled`, and sets `Cache-Control: NO_STORE`. `POST /auth/code` has no email to resend unless the code form carries it: add a hidden `email` to the code form too (Task 6 renders it when `resend` is given).

- [ ] **Step 1: Write failing tests:**
  - `sets the request cookie identically for every address` → matched, unmatched, malformed and rate-limited submissions each return one `__Host-login-request` with the attributes in Global Constraints; bodies identical; no request id in the HTML.
  - `keeps the request id on a repeat request` → a second `POST /` carrying a valid cookie re-sets the same value; an invalid-format cookie gets a fresh one.
  - `passes the request id to requestLogin` → the stored `request_hash` equals `sha256Hex(cookie value)`.
  - `signs in with the emailed code` → `POST /auth/code` with the cookie and the code from the fake email sender: 303 to `next` (or `/<row locale>/portal`), `__Host-session` set, `__Host-login-request` deleted, in the row's locale even when the form's `lang` differs.
  - `accepts a code with spaces`.
  - `code without cookie shows generic error with link hint`, plus wrong code, expired, used via link, sixth attempt with right code, IP-limited (`ipLimiter.limit` called with `code:<ip>`): each 200 with the `checkEmail.codeError` text and the form re-rendered; no session cookie.
  - `switch off` (`loginCodeEnabled: false`): `POST /` sets no request cookie and shows no form; `POST /auth/code` renders the generic error.
  - Test accounts and the write-gate `unavailable` response set no request cookie.
  - `offers resend with the submitted email` → `POST /` with a plausible address renders the resend form carrying it, with `Cache-Control: no-store`, identically for matched and unmatched; a malformed address renders no resend form; with `loginCodeEnabled: false` the resend form still renders.
  - `resend goes through the cooldown` → two `POST /` 10 s apart for a matched address send one email and render identical pages.
- [ ] **Step 2:** `npm test -- src/routes.test.ts` → FAIL.
- [ ] **Step 3: Implement `POST /`.** When `loginCodeEnabled`, before the email branch: reuse `getCookie(LOGIN_REQUEST_COOKIE)` if `isRequestId`, else `generateToken()`; set the cookie on every path that renders the check-email page (including the catch). Pass it to `requestLogin` and `displayTimeZone` into deps; render `checkEmailView(locale, { codeForm: { next, error: false }, resend })`.
- [ ] **Step 4: Implement `POST /auth/code`.** Order: switch off → error page; `ipLimiter.limit(`code:${ip}`)` → error page; `isRequestId(cookie)` and `normalizeLoginCode(body.code)` → else error page; `consumeCode(sha256Hex(id), hashLoginCode(id, code), now)` → null = error page; then create the session as `verifyLogin` does (extract a shared `createSessionFor(donorItemIds)` helper from `verifyLogin.ts` rather than duplicating it), `setSessionCookie`, `deleteCookie(LOGIN_REQUEST_COOKIE, { path: '/', secure: true })`, redirect as `POST /auth/callback` does using the row's locale. Wrap D1 errors: log `errorText(err)` only, render the error page. Error page re-renders the form with the posted `next` (through `portalReturnPath`) and the form's `lang`.
- [ ] **Step 5:** `npm test` (whole Worker) → PASS; `npm run typecheck` → clean; `node ../scripts/check-log-safety.mjs` → clean.
- [ ] **Step 6: Commit** `feat(member-portal): sign in with the emailed code`.

### Task 8: Docs and rollout notes

**Files:**
- Modify: `member-portal/README.md` (login section), root `README.md` status table only if it lists member-portal features.

- [ ] **Step 1:** Document the code flow, the cookie, the switch, migration `0007` (apply with `wrangler d1 migrations apply` for both envs **before** deploying the code), and the production AutoFill check from the spec's "Manual verification" section.
- [ ] **Step 2:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 3: Commit** `docs(member-portal): login code flow and rollout`.
