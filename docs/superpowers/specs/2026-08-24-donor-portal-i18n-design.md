# Donor Portal — Localization

**Date:** 2026-08-24
**Status:** Draft for review
**Worker:** `donor-portal` (extends v1 + v2; no new Worker)
**Prior art:** `2026-08-22-donor-portal-design.md` (v1), `2026-08-24-donor-portal-v2-design.md`
(v2 — tax letters + change requests), `donor-portal/README.md`

## Context

The Bay Area donor base speaks more languages than English. The portal should be available in the
nine languages the org wants to support day one, with a maintained (not live-DOM-rewritten)
translation for each — this is a public page showing someone their own financial history, so
accuracy and a proper `<html lang>` matter more than a drop-in widget would give us.

Decided during design:

* **Real translated content, not a Google Translate widget.** Strings live in the app, rendered
  server-side per language.
* **Scope is this Worker only.** Any future marketing/main-site localization is a separate project.
* **Preferred language is a property of the donor**, stored on their Monday Donor record — not
  just a client-side/cookie preference — so it's consistent across the login email, the portal,
  and any future channel that looks up a donor.
* **Translations are AI-drafted and shipped without a human review pass**, except the tax letter
  body (see Non-goals) — a deliberate quality tradeoff the org is accepting to ship all nine
  languages now rather than gate on translator availability.

## Languages

| Monday dropdown label     | Locale code |
| -------------------------- | ----------- |
| (default / unset)          | `en`        |
| Chinese (Simplified)        | `zh-Hans`   |
| Chinese (Traditional)        | `zh-Hant`   |
| Filipino                    | `fil`       |
| Hindi                        | `hi`        |
| Japanese                     | `ja`        |
| Korean                        | `ko`        |
| Portuguese (Brazil)            | `pt-BR`     |
| Spanish                      | `es`        |
| Vietnamese                    | `vi`        |

The Monday column stores the human-readable label (what staff pick from a dropdown); the app maps
label → locale code in one place (`config/svbc.json`, alongside the other SVBC-specific mappings).

## Goals

1. Every donor-facing page (login form, check-email, error, portal, letters, change-request) is
   available in all nine languages plus English, each served with the correct `<html lang>`.
2. A donor's preferred language lives on their Monday Donor record and drives the login email and
   every authenticated page — not just a per-browser cookie.
3. The only place cookie/`Accept-Language` guessing happens is the pre-identity login flow, where
   the app doesn't yet know who's asking.
4. A donor can change their displayed language from inside the portal; doing so queues a change
   request (same reviewed mechanism as address/email/phone) rather than writing straight to Monday.

## Non-goals (deliberate cuts)

* **Translating the tax letter body.** The letter is an official document a donor may keep as
  their IRS record. Its acknowledgment text (`config/svbc.json`'s `taxLetter` block, per the v2
  design) stays English-only. The portal chrome *around* the letter (page title, "print or save",
  "back to portal") is translated like everything else; the letter itself carries a
  per-language note: "This official document is issued in English."
* **Human review of translations.** Explicit tradeoff — see Context.
* **Localizing anything outside `donor-portal`.**
* **A translation-management UI or CMS.** Locale files are plain TypeScript, edited like code.

## Locale infrastructure

```
src/i18n/
  locales/
    en.ts        # source of truth — every key used anywhere in the app
    es.ts
    zh-Hans.ts
    zh-Hant.ts
    fil.ts
    hi.ts
    ja.ts
    ko.ts
    pt-BR.ts
    vi.ts
  t.ts           # t(locale, key, vars?) — flat key lookup + {{var}} interpolation,
                 # falls back to en.ts on a missing key so a partial locale file never 404s a page
  locales.ts     # SUPPORTED_LOCALES list + label↔code mapping (mirrors config/svbc.json)
```

Every view function (`loginFormView`, `checkEmailView`, `errorView`, the portal/donation views,
`changeRequestViews`, `lettersListView`, letter chrome) takes the resolved `t` instead of
hardcoding English strings. `page()` in `views.ts` sets `<html lang="{locale}">` from the request's
resolved locale instead of the current hardcoded `"en"`.

## Routing

Two zones, split by whether the app knows who's asking yet:

**Pre-identity** (`GET/POST /login`, `GET /auth/callback` before the token verifies): no locale in
the URL.

```
Request → locale middleware:
  lang cookie present? → use it
  else Accept-Language header → best-effort match against SUPPORTED_LOCALES
  else → en
```

A language `<select>` on the login form posts to `GET /lang/:code` (sets the cookie, redirects
back to the referring page) so a donor can override the guess before they've even entered an
email. The redirect target is validated against a fixed allowlist of in-app paths (`/login`,
`/portal`, etc.) rather than trusting an arbitrary `Referer`/query value, so this route can't be
turned into an open redirect.

**Post-auth** (everything under `/portal`): locale-prefixed, e.g. `/:locale/portal`,
`/:locale/portal/letters`, `/:locale/portal/letters/:donorItemId/:year`,
`/:locale/portal/change-request`. A route middleware validates `:locale` against
`SUPPORTED_LOCALES` (unknown value → treat as `en`, don't 404 — a stale bookmark or a manually
edited URL shouldn't break the portal).

**Bridging the two zones:** `requestLogin` (in `src/auth/requestLogin.ts`) already looks up the
donor by email before sending the magic-link email. It now also reads that donor's stored
`preferredLanguage`:

```
requestLogin(email, locale_hint):
  matches = monday.findDonorsByEmail(email)      # now also returns preferredLanguage per match
  locale = matches[0]?.preferredLanguage || locale_hint || 'en'
    # locale_hint is whatever the pre-identity cookie/Accept-Language guess resolved to on the
    # login-form request — used only when Monday has nothing on file (every existing donor,
    # until they're prompted to set one)
  ...generate token, store...
  loginUrl = `${portalBaseUrl}/auth/callback?token=${rawToken}&lang=${locale}`
  emailSender.sendLoginEmail({ to: email, loginUrl, locale })   # subject/body now localized
```

`/auth/callback` verifies the token, creates the session, and redirects to `/${locale}/portal`
using the `lang` query param carried on the callback URL.

If a shared email matches multiple donor records with different stored languages, the first
match's value wins — a documented default, not expected to come up often.

## Language switcher inside the portal

A `<select>` in the authenticated page chrome. Choosing a new language:

1. Navigates to the `/:locale/` equivalent of the current page (client-side — just a different
   link/redirect target, no page-load penalty).
2. Submits a change request for a new `language` field:
   * `ChangeRequestField` (in `src/db/changeRequests.ts` / `submitChangeRequest.ts`) gains
     `'language'` alongside `'address' | 'email' | 'phone'`.
   * `FIELD_LABELS.language = 'Preferred Language'`.
   * `getDonorContactInfo` (in `src/monday/client.ts`) returns `preferredLanguage` alongside
     `address`/`phone` so `submitChangeRequest` can record the old value.
   * Old/new values are the Monday dropdown *labels* (e.g. `"Spanish"`), matching what staff see
     when reviewing every other change request on the Change Requests board — not raw locale
     codes.

This reuses v2's existing queued/staff-reviewed write path (`src/changeRequests/`) — no new write
mechanism, and the portal's "nothing writes directly to Monday" posture (README, v1 design) holds:
the donor's browsing language for *this visit* changes immediately via the URL; what's on file in
Monday changes only after staff approve it, exactly like an address correction today.

## Config additions (`config/svbc.json`)

```jsonc
"i18n": {
  "defaultLocale": "en",
  "localeLabels": {
    "en": "English",
    "es": "Spanish",
    "zh-Hans": "Chinese (Simplified)",
    "zh-Hant": "Chinese (Traditional)",
    "fil": "Filipino",
    "hi": "Hindi",
    "ja": "Japanese",
    "ko": "Korean",
    "pt-BR": "Portuguese (Brazil)",
    "vi": "Vietnamese"
  }
}
```

`MondayColumns` (in `src/types.ts`) gains `preferredLanguage: string` (the new Donors-board column
id), validated at startup like every other configured column, consistent with `src/config.ts`'s
existing null/placeholder checks.

## Monday schema change

New column on the Donors board: **Preferred Language**, a dropdown/status column with the nine
labels above (English is "unset," not an explicit option, matching how existing donors have no
value today). This is an external change staff make in Monday directly — not something this
Worker provisions — and is a rollout dependency (see below).

## Error handling

* Missing translation key → falls back to the English string (`t()`'s default behavior), not a
  broken page. This also means an incompletely-drafted locale file degrades gracefully rather than
  blocking a deploy.
* Unknown/malformed `:locale` path segment → treated as `en`, not a 404.
* `Accept-Language` header with no match among `SUPPORTED_LOCALES` → `en`.

## Testing (vitest, per existing per-module convention)

* `i18n/t.ts`: interpolation, fallback-to-English on missing key, fallback on missing locale file.
* Locale-detection middleware: cookie precedence over header, header parsing/best-match, default.
* Each view function: one non-English snapshot (to confirm `t()` wiring, not to review translation
  prose) plus the existing English case.
* `requestLogin`: locale resolution order (Monday value → hint → `en`), magic-link URL carries
  `lang`, `sendLoginEmail` receives the resolved locale.
* `submitChangeRequest`: `'language'` accepted as a valid field, old/new values recorded as labels.

## Dependencies and rollout order

1. **Monday:** staff add the Preferred Language column to the Donors board (gates nothing else —
   the app works with it entirely unset, defaulting everyone to `en`/cookie-guessed).
2. **Locale files:** all nine drafted up front (this is the bulk of the diff by line count, but
   mechanically independent of the routing/plumbing work).
3. Routing, `requestLogin`/email localization, and the change-request field addition can all land
   before the Monday column exists — they simply see every donor as "unset" until staff fill it in.
