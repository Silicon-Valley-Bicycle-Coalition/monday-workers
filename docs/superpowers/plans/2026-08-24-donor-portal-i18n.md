# Donor Portal Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve every donor-facing page in `donor-portal` (login, portal, letters, change-request,
membership card, and the public `/verify` page) in English plus nine languages, with a donor's
preferred language stored on their Monday Donor record driving the authenticated experience and
login email.

**Architecture:** A small in-repo `src/i18n/` module (flat key→string tables per locale, a `t()`
lookup with English fallback) replaces every hardcoded string in the view layer. Two locale zones:
pre-identity pages (`/login`, `/lang/:code`, `/verify`) resolve locale from a cookie +
`Accept-Language`; authenticated pages live under a `/:locale/portal/*` path prefix whose value
originates from the donor's Monday-stored preference (falling back to the pre-identity guess for
donors with nothing on file). Switching language in the portal queues a change request through the
existing reviewed write-back path rather than writing to Monday directly.

**Tech Stack:** Hono + TypeScript (existing), Vitest, no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-24-donor-portal-i18n-design.md` — read it alongside this
plan; this plan also covers the membership-card/`verify` surfaces that merged into `main` after
that spec was approved (confirmed in chat: include both, `verify` uses the pre-identity
cookie/header locale, never the donor's stored preference, since its viewer is shop staff, not the
donor).

## Global Constraints

- Locale codes (exactly these ten, from the spec): `en` (default), `es`, `zh-Hans`, `zh-Hant`,
  `fil`, `hi`, `ja`, `ko`, `pt-BR`, `vi`.
- A missing translation key always falls back to the English string — never throw, never render
  empty.
- An unknown/malformed locale (bad cookie value, bad `:locale` path segment, unmatched
  `Accept-Language`) is treated as `en` — never a 404 or 500.
- The tax letter *body* (`letterView`'s donor-facing acknowledgment content) stays English-only per
  the spec's non-goal — only its surrounding chrome (nav links, print button, and a new
  English-only disclaimer note) is translated.
- Translations are AI-drafted with no separate human review pass (explicit, approved tradeoff) —
  translate for a general, non-technical donor audience; keep financial/membership terms precise
  (e.g. "donation" is a charitable gift, not a generic "give"; "membership tier" refers to the
  donor's SVBC membership level).
- Every `{{var}}`-style interpolation placeholder in an English string must appear, unchanged, in
  every translated version of that string.
- The `/lang/:code` redirect target is validated against a fixed allowlist of in-app paths — never
  trust an arbitrary `Referer`/query value (open-redirect guard, per spec).
- `getSessionDonorIds`, the `NO_STORE` cache header, and the enumeration-safe timing behavior of
  `POST /login` (see `src/routes.ts`'s existing comments) are untouched by this work — don't
  refactor them as part of these tasks.

---

## Task 1: i18n core — locale registry + lookup helper

**Files:**
- Create: `donor-portal/src/i18n/locales.ts`
- Create: `donor-portal/src/i18n/locales.test.ts`
- Create: `donor-portal/src/i18n/t.ts`
- Create: `donor-portal/src/i18n/t.test.ts`
- Create: `donor-portal/src/i18n/locales/en.ts` (stub for this task — full key set added in Task 2)

**Interfaces:**
- Produces: `SUPPORTED_LOCALES: readonly Locale[]`, `type Locale`, `DEFAULT_LOCALE: Locale`,
  `isLocale(value: string): value is Locale`, `LOCALE_LABELS: Record<Locale, string>`,
  `localeFromMondayLabel(label: string): Locale | null`, `t(locale: Locale, key: TranslationKey,
  vars?: Record<string, string>): string`, `type TranslationKey`.

- [ ] **Step 1: Write the failing test for the locale registry**

```typescript
// donor-portal/src/i18n/locales.test.ts
import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, isLocale, LOCALE_LABELS, localeFromMondayLabel } from './locales';

describe('locales', () => {
  it('lists exactly the ten supported locales, English first', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'es', 'zh-Hans', 'zh-Hant', 'fil', 'hi', 'ja', 'ko', 'pt-BR', 'vi']);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('isLocale accepts every supported code and rejects anything else', () => {
    for (const locale of SUPPORTED_LOCALES) expect(isLocale(locale)).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale('')).toBe(false);
  });

  it('has a human-readable Monday dropdown label for every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(LOCALE_LABELS[locale].length).toBeGreaterThan(0);
    }
    expect(LOCALE_LABELS.es).toBe('Spanish');
    expect(LOCALE_LABELS['pt-BR']).toBe('Portuguese (Brazil)');
  });

  it('localeFromMondayLabel reverses LOCALE_LABELS, case-sensitively exact', () => {
    expect(localeFromMondayLabel('Spanish')).toBe('es');
    expect(localeFromMondayLabel('Chinese (Simplified)')).toBe('zh-Hans');
    expect(localeFromMondayLabel('Klingon')).toBeNull();
    expect(localeFromMondayLabel('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/i18n/locales.test.ts`
Expected: FAIL — `./locales` has no exported member.

- [ ] **Step 3: Implement the locale registry**

```typescript
// donor-portal/src/i18n/locales.ts
export const SUPPORTED_LOCALES = ['en', 'es', 'zh-Hans', 'zh-Hant', 'fil', 'hi', 'ja', 'ko', 'pt-BR', 'vi'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

// The label staff pick from the Preferred Language dropdown on the Donors board — kept here,
// alongside the locale codes it maps to, so the two never drift apart.
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Spanish',
  'zh-Hans': 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)',
  fil: 'Filipino',
  hi: 'Hindi',
  ja: 'Japanese',
  ko: 'Korean',
  'pt-BR': 'Portuguese (Brazil)',
  vi: 'Vietnamese',
};

const LABEL_TO_LOCALE: Record<string, Locale> = Object.fromEntries(
  SUPPORTED_LOCALES.map((locale) => [LOCALE_LABELS[locale], locale])
) as Record<string, Locale>;

// Monday stores the human-readable label (what staff picked), not the locale code — this is the
// one place that raw label text gets turned back into a Locale. Returns null for empty/unset or
// an unrecognized value (a label staff typed that isn't one of the dropdown options).
export function localeFromMondayLabel(label: string): Locale | null {
  return LABEL_TO_LOCALE[label] ?? null;
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/i18n/locales.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for `t()`**

```typescript
// donor-portal/src/i18n/t.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('t', () => {
  it('returns the English string for the en locale', async () => {
    const { t } = await import('./t');
    expect(t('en', 'checkEmail.heading')).toBe('Check your email');
  });

  it('interpolates {{var}} placeholders', async () => {
    const { t } = await import('./t');
    expect(t('en', 'letters.yearLink', { year: '2025' })).toBe('2025 tax letter');
  });

  it('never throws for a known key', async () => {
    const { t } = await import('./t');
    expect(() => t('en', 'checkEmail.heading')).not.toThrow();
  });
});

// This suite mocks the es locale module to an intentionally-incomplete table, independent of
// whatever real Spanish content Task 15 ships — that decouples "does the fallback mechanism
// work" from "is this specific locale file complete right now", which would otherwise silently
// break the moment a translation task finishes covering every key (fallback becomes untestable
// through any real, fully-translated locale).
describe('t — fallback to English on a missing key', () => {
  it('falls back when the locale table has no entry for the key', async () => {
    vi.resetModules();
    vi.doMock('./locales/es', () => ({ es: {} }));
    const { t } = await import('./t');
    expect(t('es', 'checkEmail.heading')).toBe('Check your email');
    vi.doUnmock('./locales/es');
    vi.resetModules();
  });
});
```

- [ ] **Step 6: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/i18n/t.test.ts`
Expected: FAIL — `./t` has no exported member `t`, or `en.ts` has no `checkEmail.heading`/
`letters.yearLink` keys yet.

- [ ] **Step 7: Stub `en.ts` with just the two keys this test needs (Task 2 fills in the rest)**

```typescript
// donor-portal/src/i18n/locales/en.ts
export const en = {
  'checkEmail.heading': 'Check your email',
  'letters.yearLink': '{{year}} tax letter',
} as const;
```

- [ ] **Step 8: Implement `t()`**

```typescript
// donor-portal/src/i18n/t.ts
import { en } from './locales/en';
import type { Locale } from './locales';

export type TranslationKey = keyof typeof en;
type Table = Partial<Record<TranslationKey, string>>;

// Every locale module default-exports a Table keyed by the same TranslationKey union as en.ts.
// Locales other than 'en' may be a Partial (an in-progress translation) — t() falls back to the
// English string for any key a locale's table doesn't have.
import { es } from './locales/es';
import { zhHans } from './locales/zh-Hans';
import { zhHant } from './locales/zh-Hant';
import { fil } from './locales/fil';
import { hi } from './locales/hi';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { ptBR } from './locales/pt-BR';
import { vi } from './locales/vi';

const TABLES: Record<Locale, Table> = {
  en,
  es,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
  fil,
  hi,
  ja,
  ko,
  'pt-BR': ptBR,
  vi,
};

export function t(locale: Locale, key: TranslationKey, vars?: Record<string, string>): string {
  const raw = TABLES[locale][key] ?? en[key];
  if (!vars) return raw;
  return Object.entries(vars).reduce((acc, [name, value]) => acc.replaceAll(`{{${name}}}`, value), raw);
}
```

- [ ] **Step 9: Stub the other nine locale files so the import above compiles**

```typescript
// donor-portal/src/i18n/locales/es.ts (and identically-shaped stubs for zh-Hans.ts, zh-Hant.ts,
// fil.ts, hi.ts, ja.ts, ko.ts, pt-BR.ts, vi.ts — only the exported const name differs per file:
// zhHans, zhHant, fil, hi, ja, ko, ptBR, vi, matching the imports in t.ts above)
import type { TranslationKey } from '../t';
export const es: Partial<Record<TranslationKey, string>> = {};
```

(Create the other eight files with the same one-line body, swapping only the exported identifier
to match the import name used in `t.ts`: `zhHans`, `zhHant`, `fil`, `hi`, `ja`, `ko`, `ptBR`, `vi`.)

- [ ] **Step 10: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/i18n/t.test.ts`
Expected: PASS

- [ ] **Step 11: Typecheck and commit**

Run: `cd donor-portal && npm run typecheck`
Expected: no errors

```bash
git add donor-portal/src/i18n/
git commit -m "feat(donor-portal): add i18n locale registry and t() lookup with English fallback"
```

---

## Task 2: The canonical English strings

**Files:**
- Modify: `donor-portal/src/i18n/locales/en.ts` (replace the Task-1 stub with the full key set)
- Modify: `donor-portal/src/i18n/t.test.ts` (add coverage for a representative key from each area)

**Interfaces:**
- Produces: the complete `TranslationKey` union (all ~70 keys below) that every other task's view
  changes and every translated locale file (Tasks 15–23) depend on. **Nothing may add a new key to
  `en.ts` in a later task** — if a later task needs new UI copy, extend this file first and note it
  as amending this task, since every translated locale file must stay in sync with this key set.

- [ ] **Step 1: Write the failing test**

```typescript
// append to donor-portal/src/i18n/t.test.ts
import type { TranslationKey } from './t';

describe('t — full English key set', () => {
  it('has a string for every key used across the app', async () => {
    const { t } = await import('./t');
    const sample: TranslationKey[] = [
      'site.title', 'login.prompt', 'login.submit', 'languagePicker.label',
      'error.invalidLink', 'portal.heading', 'portal.membership', 'letters.listHeading',
      'changeRequest.fieldLanguage', 'card.regenerate', 'verify.notValid', 'email.subject',
    ];
    for (const key of sample) {
      expect(t('en', key).length).toBeGreaterThan(0);
    }
  });
});
```

Add the `import type { TranslationKey } from './t';` line shown above alongside this file's other
top-of-file imports (Task 1 left this file with per-test dynamic `await import('./t')` calls, not
a static `import { t }` — a type-only import is unaffected by that and can sit at the top normally).

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/i18n/t.test.ts`
Expected: FAIL — most of these keys don't exist in the Task-1 stub.

- [ ] **Step 3: Replace `en.ts` with the full key set**

```typescript
// donor-portal/src/i18n/locales/en.ts
export const en = {
  // Site-wide
  'site.title': 'SVBC Donor Portal',
  'languagePicker.label': 'Language',

  // Page <title> suffixes (rendered as "{title.x} — {site.title}")
  'title.login': 'Log In',
  'title.checkEmail': 'Check Your Email',
  'title.error': 'Something Went Wrong',
  'title.portal': 'Your Donor Portal',
  'title.lettersList': 'Tax Documents',
  'title.changeRequest': 'Request a Change',
  'title.card': 'Your Membership Card',
  'title.verify': 'Membership Verification',

  // Login
  'login.prompt': 'Enter your email to receive a login link.',
  'login.submit': 'Send login link',

  // Check email
  'checkEmail.heading': 'Check your email',
  'checkEmail.body': 'Please check your email: if that address is on file, a login link is on its way. It expires soon and can only be used once.',

  // Error page + route-level error messages
  'error.heading': 'Something went wrong',
  'error.requestNewLink': 'Request a new login link',
  'error.invalidLink': 'This link is invalid. Please request a new one.',
  'error.expiredLink': 'This link has expired or was already used. Please request a new one.',
  'error.lettersLoadFailed': 'We could not load your letters right now. Please try again in a few minutes.',
  'error.letterNotFound': 'That letter does not exist.',
  'error.letterLoadFailed': 'We could not load your letter right now. Please try again in a few minutes.',
  'error.rateLimited': 'Too many requests — please try again in a minute.',
  'error.cardNotFound': 'That card does not exist.',
  'error.cardLoadFailed': 'We could not load your card right now. Please try again in a few minutes.',
  'error.cardRegenerateFailed': 'We could not regenerate your card right now. Please try again in a few minutes.',
  'error.verifyLoadFailed': 'We could not verify this card right now. Please try again in a few minutes.',
  'error.generic': 'Something went wrong. Please try logging in again.',

  // Portal
  'portal.heading': 'Your donor portal',
  'portal.membership': 'Membership: {{status}} ({{tier}})',
  'portal.totalDonated': 'Total donated: {{total}}',
  'portal.membershipCardLink': 'Membership card',
  'portal.tableDate': 'Date',
  'portal.tableAmount': 'Amount',
  'portal.tableDescription': 'Description',
  'portal.discountsHeading': 'Bike shop discounts',
  'portal.taxDocumentsLink': 'Tax documents',
  'portal.changeRequestLink': 'Request a change to your details',
  'portal.logout': 'Log out',

  // Letters
  'letters.listHeading': 'Tax documents',
  'letters.listIntro': "Each letter is a consolidated acknowledgment of the donations our records show for that calendar year. Open a letter and use your browser's Print option to print it or save it as a PDF.",
  'letters.noneYet': 'No letters are available yet for {{name}} — letters cover completed calendar years with at least one donation.',
  'letters.yearLink': '{{year}} tax letter',
  'letters.backToPortal': 'Back to your portal',
  'letters.unavailable': 'Year-end tax letters are not available yet. Please check back soon, or contact us if you need a giving summary in the meantime.',
  'letters.backToLetters': 'Back to tax documents',
  'letters.print': 'Print or save as PDF',
  'letters.englishOnlyNote': 'This official document is issued in English.',

  // Change request
  'changeRequest.formHeading': 'Request a change to your details',
  'changeRequest.formIntro': "Submit the new value below. SVBC staff review every request before it's applied — you'll see the update once they've processed it.",
  'changeRequest.currentDetailsHeading': '{{name}} — current details',
  'changeRequest.fieldAddress': 'Address',
  'changeRequest.fieldEmail': 'Email',
  'changeRequest.fieldPhone': 'Phone',
  'changeRequest.fieldLanguage': 'Preferred Language',
  'changeRequest.whoseRecord': 'Whose record',
  'changeRequest.whatToChange': 'What to change',
  'changeRequest.newValue': 'New value',
  'changeRequest.submit': 'Submit for review',
  'changeRequest.emailNote': 'An email change takes effect for portal login once staff apply it.',
  'changeRequest.submittedHeading': 'Request received',
  'changeRequest.submittedBody': 'Thanks — SVBC staff will review your request and apply the change. This usually takes a few business days.',
  'changeRequest.duplicateHeading': 'Already submitted',
  'changeRequest.duplicateBody': 'We already have this exact request on file — staff will get to it soon. No need to submit it again.',
  'changeRequest.invalidHeading': 'Something needs fixing',
  'changeRequest.backToForm': 'Back to the form',
  'changeRequest.unavailableHeading': 'Request a change',
  'changeRequest.unavailableBody': "Self-service change requests are not available yet. Please contact SVBC and we'll update your details for you.",

  // Membership card + public verify page
  'card.heading': 'Your membership card',
  'card.tier': 'Tier: {{tier}}',
  'card.status': 'Status: {{status}}',
  'card.expires': 'Expires: {{expiry}}',
  'card.scanHint': 'Show this card, or let a shop scan the QR code or open the link above, to confirm your membership.',
  'card.regenerate': 'Regenerate card',
  'card.regenerateHint': 'Regenerating invalidates the old QR code and link immediately — use this if you think your card link has leaked.',
  'card.unavailable': 'Digital membership cards are not available yet. Please check back soon.',
  'verify.heading': 'Membership verification',
  'verify.disclaimer': 'This information is fetched live from our records.',
  'verify.notValid': 'This card is not valid. It may have been regenerated or is no longer active.',

  // Login email (src/email/resend.ts)
  'email.subject': 'Your SVBC donor portal login link',
  'email.bodyIntro': 'Click below to log in to the donor portal. This link expires soon and can only be used once.',
  'email.loginButton': 'Log in',
} as const;
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/i18n/t.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `cd donor-portal && npm run typecheck`

```bash
git add donor-portal/src/i18n/locales/en.ts donor-portal/src/i18n/t.test.ts
git commit -m "feat(donor-portal): define the full English translation key set"
```

---

## Task 3: Locale detection middleware + `/lang/:code` switcher route

**Files:**
- Create: `donor-portal/src/i18n/detectLocale.ts`
- Create: `donor-portal/src/i18n/detectLocale.test.ts`
- Modify: `donor-portal/src/routes.ts` (add the `/lang/:code` route)
- Modify: `donor-portal/src/routes.test.ts`

**Interfaces:**
- Consumes: `Locale`, `isLocale`, `SUPPORTED_LOCALES`, `DEFAULT_LOCALE` from `./locales` (Task 1).
- Produces: `LANG_COOKIE: string`, `bestAcceptLanguageMatch(header: string | undefined): Locale |
  null`, `detectLocale(c: Context): Locale` — used by every pre-identity route in later tasks.

- [ ] **Step 1: Write the failing test**

```typescript
// donor-portal/src/i18n/detectLocale.test.ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { bestAcceptLanguageMatch, detectLocale, LANG_COOKIE } from './detectLocale';

describe('bestAcceptLanguageMatch', () => {
  it('matches an exact supported tag', () => {
    expect(bestAcceptLanguageMatch('es')).toBe('es');
  });
  it('matches on the base language when the exact tag is unsupported', () => {
    expect(bestAcceptLanguageMatch('es-MX,es;q=0.9')).toBe('es');
  });
  it('matches a hyphenated locale like pt-BR from a bare base tag', () => {
    expect(bestAcceptLanguageMatch('pt-BR,pt;q=0.9')).toBe('pt-BR');
  });
  it('returns null when nothing in the header matches', () => {
    expect(bestAcceptLanguageMatch('fr-FR,fr;q=0.9')).toBeNull();
  });
  it('returns null for an absent header', () => {
    expect(bestAcceptLanguageMatch(undefined)).toBeNull();
  });
});

describe('detectLocale', () => {
  it('prefers a valid lang cookie over the Accept-Language header', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text(detectLocale(c)));
    const res = await app.request('/', { headers: { cookie: `${LANG_COOKIE}=vi`, 'accept-language': 'es' } });
    expect(await res.text()).toBe('vi');
  });

  it('ignores an invalid cookie value and falls back to the header', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text(detectLocale(c)));
    const res = await app.request('/', { headers: { cookie: `${LANG_COOKIE}=bogus`, 'accept-language': 'ja' } });
    expect(await res.text()).toBe('ja');
  });

  it('falls back to en when neither cookie nor header match', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text(detectLocale(c)));
    const res = await app.request('/');
    expect(await res.text()).toBe('en');
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/i18n/detectLocale.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

```typescript
// donor-portal/src/i18n/detectLocale.ts
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { DEFAULT_LOCALE, isLocale, SUPPORTED_LOCALES, type Locale } from './locales';

export const LANG_COOKIE = 'lang';

// Accept-Language sends comma-separated, ;q=-weighted tags in preference order (e.g.
// "es-MX,es;q=0.9,en;q=0.8"). This app only needs "which of our ten locales is the best match",
// not full RFC 4647 weighted negotiation — first-listed-tag-that-matches is good enough, and
// matches the header's own preference ordering.
export function bestAcceptLanguageMatch(header: string | undefined): Locale | null {
  if (!header) return null;
  const tags = header.split(',').map((part) => part.split(';')[0]!.trim());
  for (const tag of tags) {
    if (isLocale(tag)) return tag;
    const base = tag.split('-')[0]!.toLowerCase();
    const match = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === base || locale.split('-')[0]!.toLowerCase() === base);
    if (match) return match;
  }
  return null;
}

export function detectLocale(c: Context): Locale {
  const cookieValue = getCookie(c, LANG_COOKIE);
  if (cookieValue && isLocale(cookieValue)) return cookieValue;
  return bestAcceptLanguageMatch(c.req.header('accept-language')) ?? DEFAULT_LOCALE;
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/i18n/detectLocale.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for `/lang/:code`**

```typescript
// add to donor-portal/src/routes.test.ts, in the existing describe block that exercises createApp
it('GET /lang/:code sets the lang cookie and redirects to an allowlisted path', async () => {
  const app = createApp(baseDeps());
  const res = await app.request('/lang/es?to=%2Flogin', { redirect: 'manual' });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/login');
  expect(res.headers.get('set-cookie')).toContain('lang=es');
});

it('GET /lang/:code with an unsupported code falls back to en', async () => {
  const app = createApp(baseDeps());
  const res = await app.request('/lang/xx?to=%2Flogin', { redirect: 'manual' });
  expect(res.headers.get('set-cookie')).toContain('lang=en');
});

it('GET /lang/:code ignores a non-allowlisted "to" and redirects to /login', async () => {
  const app = createApp(baseDeps());
  const res = await app.request('/lang/es?to=https%3A%2F%2Fevil.example', { redirect: 'manual' });
  expect(res.headers.get('location')).toBe('/login');
});
```

Add a `baseDeps()` helper near the top of the file if one doesn't already exist, returning the same
`AppDeps` shape the existing tests construct inline — check the file first; if every existing test
already builds deps inline per-test, add `baseDeps()` as a small factory reusing those same fakes so
this task's three tests aren't the only ones duplicating that wiring, and leave other tests as-is
(don't refactor unrelated passing tests in this task).

- [ ] **Step 6: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/routes.test.ts`
Expected: FAIL — no route matches `/lang/:code`.

- [ ] **Step 7: Add the route**

```typescript
// donor-portal/src/routes.ts — add near the top-level imports
import { LANG_COOKIE } from './i18n/detectLocale';
import { isLocale, DEFAULT_LOCALE } from './i18n/locales';

// donor-portal/src/routes.ts — add inside createApp(), before app.get('/login', ...)
const LANG_REDIRECT_ALLOWLIST = ['/login', '/portal'];

app.get('/lang/:code', (c) => {
  const code = c.req.param('code');
  const locale = isLocale(code) ? code : DEFAULT_LOCALE;
  setCookie(c, LANG_COOKIE, locale, { httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: 365 * 24 * 3600 });
  const requestedTo = c.req.query('to') ?? '/login';
  const to = LANG_REDIRECT_ALLOWLIST.includes(requestedTo) ? requestedTo : '/login';
  return c.redirect(to);
});
```

`httpOnly: false` is deliberate: this cookie holds a UI preference, not a credential, and a future
client-side language picker (e.g. auto-submitting on `<select>` change) may need to read it.

- [ ] **Step 8: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/routes.test.ts`
Expected: PASS

- [ ] **Step 9: Typecheck and commit**

Run: `cd donor-portal && npm run typecheck`

```bash
git add donor-portal/src/i18n/detectLocale.ts donor-portal/src/i18n/detectLocale.test.ts donor-portal/src/routes.ts donor-portal/src/routes.test.ts
git commit -m "feat(donor-portal): add Accept-Language/cookie locale detection and /lang switcher route"
```

---

## Task 4: Pre-identity views speak every language

**Files:**
- Modify: `donor-portal/src/views.ts:15-53` (`page`, `loginFormView`, `checkEmailView`, `errorView`)
- Modify: `donor-portal/src/views.test.ts`

**Interfaces:**
- Consumes: `Locale`, `SUPPORTED_LOCALES`, `LOCALE_LABELS` (Task 1); `t`, `TranslationKey` (Task 1/2).
- Produces: `page(title: string, body: string, locale: Locale): string`; `loginFormView(locale:
  Locale): string`; `checkEmailView(locale: Locale): string`; `errorView(messageKey:
  TranslationKey, locale: Locale): string` — **note the signature change**: `errorView` now takes a
  translation key, not a pre-built message string, so every call site (routes.ts, later tasks)
  passes e.g. `'error.invalidLink'` instead of `'This link is invalid...'`.

- [ ] **Step 1: Write the failing tests**

```typescript
// replace the existing page/loginFormView/checkEmailView/errorView describe blocks in
// donor-portal/src/views.test.ts
import { describe, it, expect } from 'vitest';
import { checkEmailView, errorView, loginFormView, page, portalView } from './views';
import type { PortalView } from './types';

describe('page', () => {
  it('wraps the body in a document with charset, viewport, the given title, and the locale as <html lang>', () => {
    const html = page('Check Your Email — SVBC Donor Portal', '<h1>Check your email</h1>', 'es');
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<title>Check Your Email — SVBC Donor Portal</title>');
    expect(html).toContain('<h1>Check your email</h1>');
  });

  it('escapes a title containing markup', () => {
    const html = page('<script>alert(1)</script>', '<p>body</p>', 'en');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('loginFormView', () => {
  it('renders a form posting to /login with an email field and a language picker', () => {
    const html = loginFormView('en');
    expect(html).toContain('action="/login"');
    expect(html).toContain('name="email"');
    expect(html).toContain('Send login link');
    // one option per supported locale, each linking through /lang/:code
    expect(html).toContain('/lang/es');
    expect(html).toContain('/lang/vi');
  });

  it('renders the prompt in the requested locale when translated (fallback to English otherwise)', () => {
    const html = loginFormView('en');
    expect(html).toContain('Enter your email to receive a login link.');
  });
});

describe('checkEmailView', () => {
  it('renders the same generic message regardless of caller state', () => {
    const html = checkEmailView('en');
    expect(html).toContain('check your email');
  });
});

describe('errorView', () => {
  it('renders the message for the given translation key, escaped', () => {
    const html = errorView('error.invalidLink', 'en');
    expect(html).toContain('This link is invalid');
  });

  it('links back to /login for a new link', () => {
    const html = errorView('error.invalidLink', 'en');
    expect(html).toContain('href="/login"');
  });
});
```

(Leave the existing `describe('portalView', ...)` block in this file untouched for now — Task 5
updates it.)

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/views.test.ts`
Expected: FAIL — current signatures don't take a `locale` param, `errorView` takes a raw string.

- [ ] **Step 3: Implement the changes**

```typescript
// donor-portal/src/views.ts:1-53 — replace entirely with:
import type { PortalView } from './types';
import { SUPPORTED_LOCALES, LOCALE_LABELS, type Locale } from './i18n/locales';
import { t, type TranslationKey } from './i18n/t';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Wraps a view's HTML fragment in a minimal document so the browser has a real <title> and
// viewport meta — without it, browsers fall back to printing the bare URL in default print
// headers/footers, which is how the tax letter page used to print (see letterViews.letterView).
export function page(title: string, body: string, locale: Locale): string {
  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

// Shared by every pre-identity view (login, check-email, error, verify): a plain link per
// supported locale, each pointing at /lang/:code?to=<current path> so picking one applies
// immediately and returns the visitor to where they were.
export function languagePicker(currentPath: string, locale: Locale): string {
  const options = SUPPORTED_LOCALES.map(
    (code) => `<a href="/lang/${code}?to=${encodeURIComponent(currentPath)}">${escapeHtml(LOCALE_LABELS[code])}</a>`
  ).join(' · ');
  return `<nav aria-label="${escapeHtml(t(locale, 'languagePicker.label'))}">${options}</nav>`;
}

export function loginFormView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'site.title'))}</h1>
    ${languagePicker('/login', locale)}
    <p>${escapeHtml(t(locale, 'login.prompt'))}</p>
    <form action="/login" method="post">
      <input type="email" name="email" required />
      <button type="submit">${escapeHtml(t(locale, 'login.submit'))}</button>
    </form>
  `;
}

export function checkEmailView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'checkEmail.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'checkEmail.body'))}</p>
  `;
}

export function errorView(messageKey: TranslationKey, locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'error.heading'))}</h1>
    <p>${escapeHtml(t(locale, messageKey))}</p>
    <p><a href="/login">${escapeHtml(t(locale, 'error.requestNewLink'))}</a></p>
  `;
}
```

(The `donationRow`, `donorSection`, `discountRow`, and `portalView` functions below this point in
the file are untouched here — Task 5 updates them.)

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/views.test.ts`
Expected: PASS for the four updated describe blocks (the untouched `portalView` block will now
fail to compile against the new `PortalView` type only if Task 5 hasn't run yet — since this task
doesn't change `PortalView` or `portalView`'s signature, it still passes as-is).

- [ ] **Step 5: Update every call site in `routes.ts`**

`routes.ts` currently calls `page(title, body)` (2 args) and `errorView(message)` (1 arg, a raw
string) in ~15 places. This task updates only the pre-identity call sites; Task 5–8 update the
rest as they touch each route. Update these specific lines now:

```typescript
// routes.ts — app.onError handler
app.onError((err, c) => {
  console.error(`donor-portal unhandled error: ${err instanceof Error ? err.message : String(err)}`);
  const locale = detectLocale(c);
  return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.generic', locale), locale), 500);
});

app.get('/login', (c) => {
  const locale = detectLocale(c);
  return c.html(page(t(locale, 'title.login') + ' — ' + t(locale, 'site.title'), loginFormView(locale), locale));
});
```

In `POST /login`, capture the locale once at the top of the handler (it's also needed by Task 11
to pass a hint into `requestLogin`) and use it for the `checkEmailView` response:

```typescript
app.post('/login', async (c) => {
  const locale = detectLocale(c);
  // ...existing body-parsing/rate-limit logic is unchanged here...
  return c.html(page(t(locale, 'title.checkEmail') + ' — ' + t(locale, 'site.title'), checkEmailView(locale), locale));
});
```

In `GET /auth/callback`, both `errorView('This link is invalid...')` and `errorView('This link has
expired...')` calls become:

```typescript
app.get('/auth/callback', async (c) => {
  const locale = detectLocale(c);
  const token = c.req.query('token');
  if (!token) {
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.invalidLink', locale), locale));
  }
  // ... (verifyLogin call unchanged) ...
  // both catch/null branches below become:
  return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.expiredLink', locale), locale));
  // (Task 11 changes this route's success path — the redirect to /portal — separately.)
});
```

Add the two new imports this requires at the top of `routes.ts`:

```typescript
import { detectLocale } from './i18n/detectLocale';
import { t } from './i18n/t';
```

Every other `page(...)`/`errorView(...)` call site in `routes.ts` (the `/portal/*`, `/verify`, and
card routes) is deliberately left broken by this task — Tasks 5–8 fix each one as they add locale
routing to that section. Do not attempt to fix them here.

- [ ] **Step 6: Run the full suite to confirm only the expected routes still fail**

Run: `cd donor-portal && npm run typecheck`
Expected: type errors only in the `routes.ts` call sites Tasks 5–8 will touch (the ones still
calling `page`/`errorView` with the old 2-arg/string-message signatures). If a call site outside
those routes also errors, fix it now — it means Step 5 missed one of the pre-identity routes.

- [ ] **Step 7: Commit**

```bash
git add donor-portal/src/views.ts donor-portal/src/views.test.ts donor-portal/src/routes.ts
git commit -m "feat(donor-portal): localize login, check-email, and error pages; add language picker"
```

---

## Task 5: Portal page + membership-card link, under `/:locale/portal`

**Files:**
- Modify: `donor-portal/src/views.ts` (`donationRow`, `donorSection`, `discountRow`, `portalView`)
- Modify: `donor-portal/src/views.test.ts` (`portalView` describe block)
- Modify: `donor-portal/src/routes.ts` (`GET /portal` → `GET /:locale/portal`, plus a bare-`/portal`
  back-compat redirect)
- Modify: `donor-portal/src/routes.test.ts`

**Interfaces:**
- Consumes: `t`, `Locale` (Task 1/2); `detectLocale` is *not* used here — the authenticated zone's
  locale comes from the `:locale` path param, resolved by a small helper this task adds.
- Produces: `resolvePathLocale(c: Context): Locale` (in `routes.ts`, used by every task from here
  on for authenticated routes) — reads `c.req.param('locale')`, returns it if valid, else `en`.
  `portalView(data: PortalView, locale: Locale): string`.

- [ ] **Step 1: Write the failing tests**

```typescript
// replace the portalView describe block in donor-portal/src/views.test.ts
describe('portalView', () => {
  const data: PortalView = {
    donors: [
      { id: 'donor-1', name: 'Jane Donor', membershipStatus: 'Active', membershipTier: 'Member', totalDonated: '500', donations: [{ date: '2026-01-01', amount: '100', description: 'Annual gift' }], membershipExpiry: '' },
      { id: 'donor-2', name: 'Jane Also', membershipStatus: 'Active', membershipTier: 'Lifetime', totalDonated: '2500', donations: [], membershipExpiry: '' },
    ],
    discounts: [{ name: 'Local Bikes', discountOffered: '10% off' }],
  };

  it('renders each donor under its own name header, never a single merged view', () => {
    const html = portalView(data, 'en');
    expect(html).toContain('Jane Donor');
    expect(html).toContain('Jane Also');
    expect(html).toContain('Annual gift');
    expect(html).toContain('Local Bikes');
  });

  it('escapes donor-sourced text instead of rendering it raw', () => {
    const maliciousData: PortalView = {
      donors: [{ id: 'donor-3', name: '<img src=x onerror=alert(1)>', membershipStatus: 'Active', membershipTier: 'Member', totalDonated: '0', donations: [], membershipExpiry: '' }],
      discounts: [],
    };
    const html = portalView(maliciousData, 'en');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('links each donor to their own membership card, locale-prefixed', () => {
    const html = portalView(data, 'es');
    expect(html).toContain('/es/portal/card/donor-1');
    expect(html).toContain('/es/portal/card/donor-2');
  });

  it('links tax documents and change-request under the same locale prefix', () => {
    const html = portalView(data, 'vi');
    expect(html).toContain('href="/vi/portal/letters"');
    expect(html).toContain('href="/vi/portal/change-request"');
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/views.test.ts`
Expected: FAIL — `portalView` doesn't take a `locale` argument yet and links aren't locale-prefixed.

- [ ] **Step 3: Update the view functions**

```typescript
// donor-portal/src/views.ts — replace donationRow through portalView (the bottom half of the file)
function donationRow(donation: PortalView['donors'][number]['donations'][number], locale: Locale): string {
  return `
    <tr>
      <td>${escapeHtml(donation.date)}</td>
      <td>${escapeHtml(donation.amount)}</td>
      <td>${escapeHtml(donation.description)}</td>
    </tr>
  `;
}

function donorSection(donor: PortalView['donors'][number], locale: Locale): string {
  return `
    <section>
      <h2>${escapeHtml(donor.name)}</h2>
      <p>${escapeHtml(t(locale, 'portal.membership', { status: donor.membershipStatus, tier: donor.membershipTier }))}</p>
      <p>${escapeHtml(t(locale, 'portal.totalDonated', { total: donor.totalDonated }))}</p>
      <p><a href="/${locale}/portal/card/${encodeURIComponent(donor.id)}">${escapeHtml(t(locale, 'portal.membershipCardLink'))}</a></p>
      <table>
        <thead>
          <tr><th>${escapeHtml(t(locale, 'portal.tableDate'))}</th><th>${escapeHtml(t(locale, 'portal.tableAmount'))}</th><th>${escapeHtml(t(locale, 'portal.tableDescription'))}</th></tr>
        </thead>
        <tbody>
          ${donor.donations.map((d) => donationRow(d, locale)).join('')}
        </tbody>
      </table>
    </section>
  `;
}

function discountRow(discount: PortalView['discounts'][number]): string {
  return `<li>${escapeHtml(discount.name)}: ${escapeHtml(discount.discountOffered)}</li>`;
}

export function portalView(data: PortalView, locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'portal.heading'))}</h1>
    ${data.donors.map((donor) => donorSection(donor, locale)).join('')}
    <section>
      <h2>${escapeHtml(t(locale, 'portal.discountsHeading'))}</h2>
      <ul>
        ${data.discounts.map(discountRow).join('')}
      </ul>
    </section>
    <p><a href="/${locale}/portal/letters">${escapeHtml(t(locale, 'portal.taxDocumentsLink'))}</a></p>
    <p><a href="/${locale}/portal/change-request">${escapeHtml(t(locale, 'portal.changeRequestLink'))}</a></p>
    <form action="/logout" method="post"><button type="submit">${escapeHtml(t(locale, 'portal.logout'))}</button></form>
  `;
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/views.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing route test**

```typescript
// add to donor-portal/src/routes.test.ts
it('GET /:locale/portal renders the portal in that locale and sets <html lang>', async () => {
  const app = createApp(depsWithSession(/* existing session-cookie test helper */));
  const res = await app.request('/es/portal', { headers: { cookie: 'session=...' } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('<html lang="es">');
});

it('an unrecognized :locale falls back to en instead of 404ing', async () => {
  const app = createApp(depsWithSession());
  const res = await app.request('/xx/portal', { headers: { cookie: 'session=...' } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('<html lang="en">');
});

it('bare /portal (no locale) redirects to the default-locale equivalent', async () => {
  const app = createApp(baseDeps());
  const res = await app.request('/portal', { redirect: 'manual' });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/en/portal');
});
```

Match this task's tests to whatever session-cookie test helper already exists in the file for the
current `GET /portal` tests (reuse it, adapting only the path) rather than inventing a new one —
read the existing `/portal` test block in `routes.test.ts` before writing these.

- [ ] **Step 6: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/routes.test.ts`
Expected: FAIL — no `/:locale/portal` route exists yet.

- [ ] **Step 7: Update `routes.ts`**

```typescript
// routes.ts — add near the other small helpers
function resolvePathLocale(c: Context): Locale {
  const raw = c.req.param('locale');
  return raw !== undefined && isLocale(raw) ? raw : DEFAULT_LOCALE;
}

// Back-compat: anything still linking to the old unprefixed /portal/* paths (a stale bookmark,
// an email sent before this change) lands on the default-locale equivalent instead of 404ing.
app.get('/portal', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal`));
```

Replace the existing `app.get('/portal', ...)` handler body with:

```typescript
app.get('/:locale/portal', async (c) => {
  const locale = resolvePathLocale(c);
  const donorItemIds = await getSessionDonorIds(c, deps);
  if (donorItemIds === null) return c.redirect('/login');

  const data = await loadPortalData(donorItemIds, deps.monday);
  c.header('Cache-Control', NO_STORE);
  return c.html(page(t(locale, 'title.portal') + ' — ' + t(locale, 'site.title'), portalView(data, locale), locale));
});
```

Add `import type { Locale } from './i18n/locales';` alongside the existing `import { isLocale,
DEFAULT_LOCALE } from './i18n/locales';` from Task 3.

- [ ] **Step 8: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/routes.test.ts`
Expected: PASS

- [ ] **Step 9: Typecheck and commit**

Run: `cd donor-portal && npm run typecheck`

```bash
git add donor-portal/src/views.ts donor-portal/src/views.test.ts donor-portal/src/routes.ts donor-portal/src/routes.test.ts
git commit -m "feat(donor-portal): serve the portal page under /:locale/portal"
```

---

## Task 6: Tax-letters list + letter chrome, under `/:locale/portal/letters`

**Files:**
- Modify: `donor-portal/src/letters/letterViews.ts`
- Modify: `donor-portal/src/letters/letterViews.test.ts`
- Modify: `donor-portal/src/routes.ts` (the two `/portal/letters*` routes)
- Modify: `donor-portal/src/routes.test.ts`

**Interfaces:**
- Consumes: `t`, `Locale`, `resolvePathLocale` (Task 5).
- Produces: `lettersListView(listings: LetterYearListing[], locale: Locale): string`; `letterView(data: LetterData, taxLetter: TaxLetterConfig, generatedOn: string, locale: Locale): string`; `lettersUnavailableView(locale: Locale): string`.

- [ ] **Step 1: Write the failing tests**

```typescript
// donor-portal/src/letters/letterViews.test.ts — update the existing tests' call sites to pass a
// locale, and add these:
it('lettersListView renders the heading and year links in the given locale', () => {
  const html = lettersListView([{ donorId: 'd1', donorName: 'Jane', years: [2025] }], 'vi');
  expect(html).toContain('/portal/letters/d1/2025'); // link target unaffected by list-page locale (see note below)
});

it('letterView chrome (nav/print) is localized but the acknowledgment body stays English', () => {
  const html = letterView(sampleLetterData, sampleTaxLetter, 'August 24, 2026', 'es');
  expect(html).toContain('Back to tax documents'); // still English: no Spanish translation call for the body/nav in this fixture check — see next assertion for the actual localized text
});

it('letterView carries an English-only disclaimer note in the requested locale', () => {
  const html = letterView(sampleLetterData, sampleTaxLetter, 'August 24, 2026', 'es');
  expect(html).toContain('issued in English');
});
```

Note on the first new test: `lettersListView`'s per-year links (`/portal/letters/:donorId/:year`)
are followed from within the already-locale-prefixed `/:locale/portal/letters` page, so — like
`portalView`'s links in Task 5 — they must be prefixed with the current locale too. Write that
test as:

```typescript
it('lettersListView locale-prefixes its year links', () => {
  const html = lettersListView([{ donorId: 'd1', donorName: 'Jane', years: [2025] }], 'vi');
  expect(html).toContain('/vi/portal/letters/d1/2025');
  expect(html).toContain('href="/vi/portal"'); // "back to your portal" link
});
```

(Drop the earlier draft of that test — this replaces it.) Add `sampleLetterData` /
`sampleTaxLetter` fixtures matching whatever shape the existing `letterView` tests in this file
already use (read the current file before writing new fixtures — reuse, don't duplicate).

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/letters/letterViews.test.ts`
Expected: FAIL — signatures don't accept `locale` yet.

- [ ] **Step 3: Implement it**

```typescript
// donor-portal/src/letters/letterViews.ts
import { escapeHtml } from '../views';
import type { TaxLetterConfig } from '../types';
import type { LetterData, LetterYearListing } from './loadLetterData';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';

export function lettersListView(listings: LetterYearListing[], locale: Locale): string {
  const sections = listings
    .map((listing) => {
      const items =
        listing.years.length === 0
          ? `<p>${escapeHtml(t(locale, 'letters.noneYet', { name: listing.donorName }))}</p>`
          : `<ul>${listing.years
              .map(
                (year) =>
                  `<li><a href="/${locale}/portal/letters/${encodeURIComponent(listing.donorId)}/${year}">${escapeHtml(t(locale, 'letters.yearLink', { year: String(year) }))}</a></li>`
              )
              .join('')}</ul>`;
      return `<section><h2>${escapeHtml(listing.donorName)}</h2>${items}</section>`;
    })
    .join('');

  return `
    <h1>${escapeHtml(t(locale, 'letters.listHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'letters.listIntro'))}</p>
    ${sections}
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}

// The letter's own body — greeting, gift table, acknowledgment statement, signature — stays
// English (spec non-goal: it's an official document a donor may keep for tax purposes). Only the
// surrounding chrome (nav links, print button) and a new disclaimer note are translated.
export function letterView(data: LetterData, taxLetter: TaxLetterConfig, generatedOn: string, locale: Locale): string {
  const rows = data.gifts
    .map((gift) => `<tr><td>${escapeHtml(gift.date)}</td><td>${escapeHtml(gift.amount)}</td></tr>`)
    .join('');

  return `
    <style>
      .letter { font-family: Georgia, 'Times New Roman', serif; max-width: 42rem; margin: 0 auto; line-height: 1.5; }
      .letter table { border-collapse: collapse; width: 100%; }
      .letter th, .letter td { text-align: left; padding: 0.25rem 1rem 0.25rem 0; border-bottom: 1px solid #ccc; }
      .letter tr { page-break-inside: avoid; }
      .letter .total { font-weight: bold; }
      @page { size: letter; margin: 1in; }
      @media print {
        .no-print { display: none; }
      }
    </style>
    <nav class="no-print">
      <a href="/${locale}/portal/letters">${escapeHtml(t(locale, 'letters.backToLetters'))}</a>
      <button type="button" onclick="window.print()">${escapeHtml(t(locale, 'letters.print'))}</button>
    </nav>
    <p class="no-print"><small>${escapeHtml(t(locale, 'letters.englishOnlyNote'))}</small></p>
    <article class="letter">
      <header>
        <p><strong>${escapeHtml(taxLetter.orgLegalName)}</strong><br>
        ${escapeHtml(taxLetter.orgAddress)}<br>
        EIN: ${escapeHtml(taxLetter.ein)}</p>
      </header>
      <p>${escapeHtml(generatedOn)}</p>
      <p>Dear ${escapeHtml(data.donorName)},</p>
      <p>Thank you for supporting ${escapeHtml(taxLetter.orgLegalName)}. Our records show the
      following contributions from you during the ${data.year} calendar year:</p>
      <table>
        <thead><tr><th>Date</th><th>Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="total">Total contributions for ${data.year}: ${escapeHtml(data.totalFormatted)}</p>
      <p>${escapeHtml(data.statement)}</p>
      <p>Please retain this letter for your tax records. If anything here looks incorrect,
      contact us and we will review it.</p>
      <p>Sincerely,<br>
      ${escapeHtml(taxLetter.signatureName)}<br>
      ${escapeHtml(taxLetter.signatureTitle)}, ${escapeHtml(taxLetter.orgLegalName)}</p>
      <footer><p><small>Generated from ${escapeHtml(taxLetter.orgLegalName)}'s records on ${escapeHtml(generatedOn)}.</small></p></footer>
    </article>
  `;
}

export function lettersUnavailableView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'letters.listHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'letters.unavailable'))}</p>
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/letters/letterViews.test.ts`

- [ ] **Step 5: Update the two letters routes in `routes.ts`**

```typescript
app.get('/:locale/portal/letters', async (c) => {
  const locale = resolvePathLocale(c);
  const donorItemIds = await getSessionDonorIds(c, deps);
  if (donorItemIds === null) return c.redirect('/login');

  c.header('Cache-Control', NO_STORE);
  if (!lettersEnabled(deps.config)) {
    return c.html(page(t(locale, 'title.lettersList') + ' — ' + t(locale, 'site.title'), lettersUnavailableView(locale), locale));
  }
  let listings;
  try {
    listings = await listLetterYears(donorItemIds, deps.monday, deps.now());
  } catch (err) {
    console.error(`donor-portal letters list failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.lettersLoadFailed', locale), locale), 500);
  }
  return c.html(page(t(locale, 'title.lettersList') + ' — ' + t(locale, 'site.title'), lettersListView(listings, locale), locale));
});

app.get('/:locale/portal/letters/:donorItemId/:year', async (c) => {
  const locale = resolvePathLocale(c);
  const donorItemIds = await getSessionDonorIds(c, deps);
  if (donorItemIds === null) return c.redirect('/login');

  c.header('Cache-Control', NO_STORE);
  if (!lettersEnabled(deps.config)) {
    return c.html(page(t(locale, 'title.lettersList') + ' — ' + t(locale, 'site.title'), lettersUnavailableView(locale), locale));
  }

  const donorItemId = c.req.param('donorItemId');
  const yearParam = c.req.param('year');
  const year = /^\d{4}$/.test(yearParam) ? Number(yearParam) : null;
  if (!donorItemIds.includes(donorItemId) || year === null) {
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.letterNotFound', locale), locale), 404);
  }

  let data;
  try {
    data = await loadLetterData(donorItemId, year, deps.monday, deps.config.taxLetter, deps.now());
  } catch (err) {
    console.error(`donor-portal letter load failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.letterLoadFailed', locale), locale), 500);
  }
  if (data === null) {
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.letterNotFound', locale), locale), 404);
  }

  const generatedOn = deps.now().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const letterTitle = `SVBC ${data.year} Tax Letter — ${data.donorName}`;
  return c.html(page(letterTitle, letterView(data, deps.config.taxLetter, generatedOn, locale), locale));
});
```

Also add a bare back-compat redirect next to the `/portal` one from Task 5:

```typescript
app.get('/portal/letters', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/letters`));
app.get('/portal/letters/:donorItemId/:year', (c) =>
  c.redirect(`/${DEFAULT_LOCALE}/portal/letters/${c.req.param('donorItemId')}/${c.req.param('year')}`)
);
```

- [ ] **Step 6: Update `routes.test.ts`** for the changed paths (`/portal/letters` →
  `/en/portal/letters` etc. in the existing tests), following the same pattern as Task 5's route
  test updates.

- [ ] **Step 7: Run the suite, confirm it passes**

Run: `cd donor-portal && npm test -- src/letters/letterViews.test.ts src/routes.test.ts`

- [ ] **Step 8: Typecheck and commit**

```bash
git add donor-portal/src/letters/ donor-portal/src/routes.ts donor-portal/src/routes.test.ts
git commit -m "feat(donor-portal): localize tax-letter list and chrome under /:locale/portal/letters"
```

---

## Task 7: Change-request form + a new "language" field, under `/:locale/portal/change-request`

**Files:**
- Modify: `donor-portal/src/db/changeRequests.ts:1` (`ChangeRequestField` union)
- Modify: `donor-portal/src/db/changeRequests.test.ts`
- Modify: `donor-portal/src/changeRequests/submitChangeRequest.ts` (`FIELD_LABELS`)
- Modify: `donor-portal/src/changeRequests/submitChangeRequest.test.ts`
- Modify: `donor-portal/src/changeRequests/changeRequestViews.ts`
- Modify: `donor-portal/src/changeRequests/changeRequestViews.test.ts`
- Modify: `donor-portal/src/routes.ts` (the two `/portal/change-request` routes)
- Modify: `donor-portal/src/routes.test.ts`

**Interfaces:**
- Consumes: `t`, `Locale`, `resolvePathLocale` (Tasks 1, 5); `DonorContactInfo.preferredLanguage`
  and `LOCALE_LABELS`/`localeFromMondayLabel` — **this task only wires the `'language'` field
  through the existing text-diff change-request mechanism; it does not yet have a real
  `preferredLanguage` value to show, since that's added in Task 9. Use `donor.preferredLanguage ??
  ''` defensively so this task's view code is forward-compatible with Task 9's type change without
  depending on task order** — actually: **do this task's `DonorContactInfo` reads assume the field
  already exists** (list Task 9 as a prerequisite in your subagent dispatch order — `submitChangeRequest.ts`
  reads `contact.preferredLanguage` for the old-value diff, so Task 9's type addition must land
  first or this task's typecheck fails). If executing tasks out of order isn't possible with your
  workflow, do Task 9 immediately before this one instead of after Task 8.
- Produces: `ChangeRequestField = 'address' | 'email' | 'phone' | 'language'`;
  `changeRequestFormView(donors: DonorContactInfo[], locale: Locale): string`;
  `changeRequestResultView(result: SubmitResult, locale: Locale): string`;
  `changeRequestsUnavailableView(locale: Locale): string`.

- [ ] **Step 1: Write the failing test for the field union**

```typescript
// add to donor-portal/src/db/changeRequests.test.ts
it('accepts "language" as a valid ChangeRequestField value in a stored row round-trip', async () => {
  // Exercise this exactly like the existing address/email/phone round-trip test in this file —
  // read that test first and mirror its shape with field: 'language'.
});
```

- [ ] **Step 2: Run it, confirm it fails on the type check** (TypeScript rejects `field:
  'language'` against the current union)

Run: `cd donor-portal && npm run typecheck`

- [ ] **Step 3: Widen the union**

```typescript
// donor-portal/src/db/changeRequests.ts:1
export type ChangeRequestField = 'address' | 'email' | 'phone' | 'language';
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/db/changeRequests.test.ts`

- [ ] **Step 5: Add the label and write its test**

```typescript
// add to donor-portal/src/changeRequests/submitChangeRequest.test.ts
it('FIELD_LABELS has a staff-facing label for the language field', () => {
  expect(FIELD_LABELS.language).toBe('Preferred Language');
});
```

```typescript
// donor-portal/src/changeRequests/submitChangeRequest.ts
export const FIELD_LABELS: Record<ChangeRequestField, string> = {
  address: 'Address',
  email: 'Email',
  phone: 'Phone',
  language: 'Preferred Language',
};
```

`FIELD_LABELS` stays English-only deliberately — it names the field on the staff-facing Change
Requests board in Monday, not donor-facing UI (the donor-facing option label comes from
`t(locale, 'changeRequest.fieldLanguage')` in the view, added below).

- [ ] **Step 6: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/changeRequests/submitChangeRequest.test.ts`

- [ ] **Step 7: Write the failing view tests**

```typescript
// donor-portal/src/changeRequests/changeRequestViews.test.ts — update existing tests to pass a
// locale as the last argument to every call, and add:
it('the field select includes a Preferred Language option, localized', () => {
  const html = changeRequestFormView([sampleDonor], 'vi');
  expect(html).toContain('value="language"');
});

it('current-details list shows the stored preferred-language label', () => {
  const donor = { ...sampleDonor, preferredLanguage: 'Spanish' };
  const html = changeRequestFormView([donor], 'en');
  expect(html).toContain('Spanish');
});

it('locale-prefixes its "back to portal" / "back to form" links', () => {
  const submitted = changeRequestResultView({ kind: 'submitted' }, 'ja');
  expect(submitted).toContain('href="/ja/portal"');
});
```

Add `preferredLanguage: ''` to whatever `sampleDonor: DonorContactInfo` fixture this file already
uses (or defines inline per test — check first).

- [ ] **Step 8: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/changeRequests/changeRequestViews.test.ts`

- [ ] **Step 9: Implement it**

```typescript
// donor-portal/src/changeRequests/changeRequestViews.ts
import { escapeHtml } from '../views';
import type { DonorContactInfo } from '../types';
import type { SubmitResult } from './submitChangeRequest';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';

function donorOption(donor: DonorContactInfo): string {
  return `<option value="${escapeHtml(donor.id)}">${escapeHtml(donor.name)}</option>`;
}

function donorCurrentValues(donor: DonorContactInfo, locale: Locale): string {
  return `
    <section>
      <h3>${escapeHtml(t(locale, 'changeRequest.currentDetailsHeading', { name: donor.name }))}</h3>
      <dl>
        <dt>${escapeHtml(t(locale, 'changeRequest.fieldAddress'))}</dt><dd>${escapeHtml(donor.address)}</dd>
        <dt>${escapeHtml(t(locale, 'changeRequest.fieldEmail'))}</dt><dd>${escapeHtml(donor.email)}</dd>
        <dt>${escapeHtml(t(locale, 'changeRequest.fieldPhone'))}</dt><dd>${escapeHtml(donor.phone)}</dd>
        <dt>${escapeHtml(t(locale, 'changeRequest.fieldLanguage'))}</dt><dd>${escapeHtml(donor.preferredLanguage)}</dd>
      </dl>
    </section>
  `;
}

export function changeRequestFormView(donors: DonorContactInfo[], locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'changeRequest.formHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'changeRequest.formIntro'))}</p>
    ${donors.map((d) => donorCurrentValues(d, locale)).join('')}
    <form action="/${locale}/portal/change-request" method="post">
      <label>${escapeHtml(t(locale, 'changeRequest.whoseRecord'))}
        <select name="donorItemId" required>${donors.map(donorOption).join('')}</select>
      </label>
      <label>${escapeHtml(t(locale, 'changeRequest.whatToChange'))}
        <select name="field" required>
          <option value="address">${escapeHtml(t(locale, 'changeRequest.fieldAddress'))}</option>
          <option value="email">${escapeHtml(t(locale, 'changeRequest.fieldEmail'))}</option>
          <option value="phone">${escapeHtml(t(locale, 'changeRequest.fieldPhone'))}</option>
          <option value="language">${escapeHtml(t(locale, 'changeRequest.fieldLanguage'))}</option>
        </select>
      </label>
      <label>${escapeHtml(t(locale, 'changeRequest.newValue'))}
        <input type="text" name="newValue" maxlength="500" required />
      </label>
      <button type="submit">${escapeHtml(t(locale, 'changeRequest.submit'))}</button>
    </form>
    <p>${escapeHtml(t(locale, 'changeRequest.emailNote'))}</p>
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}

export function changeRequestResultView(result: SubmitResult, locale: Locale): string {
  if (result.kind === 'submitted') {
    return `
      <h1>${escapeHtml(t(locale, 'changeRequest.submittedHeading'))}</h1>
      <p>${escapeHtml(t(locale, 'changeRequest.submittedBody'))}</p>
      <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
    `;
  }
  if (result.kind === 'duplicate') {
    return `
      <h1>${escapeHtml(t(locale, 'changeRequest.duplicateHeading'))}</h1>
      <p>${escapeHtml(t(locale, 'changeRequest.duplicateBody'))}</p>
      <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
    `;
  }
  return `
    <h1>${escapeHtml(t(locale, 'changeRequest.invalidHeading'))}</h1>
    <p>${escapeHtml(result.message)}</p>
    <p><a href="/${locale}/portal/change-request">${escapeHtml(t(locale, 'changeRequest.backToForm'))}</a></p>
  `;
}

export function changeRequestsUnavailableView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'changeRequest.unavailableHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'changeRequest.unavailableBody'))}</p>
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}
```

`result.message` in the `'invalid'` branch stays untranslated — it comes from
`submitChangeRequest`'s own validation (`"Unknown donor record."`, `"Please enter a value up to
500 characters."` etc.). **Scope decision for this plan:** those validation messages stay
English-only. They describe malformed input (a bug or tampering, not a normal donor path), and
localizing them would mean threading `Locale` through the change-request submission/validation
module for a rarely-seen edge case. Note this explicitly if asked — it's a deliberate cut, not an
oversight.

- [ ] **Step 10: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/changeRequests/changeRequestViews.test.ts`

- [ ] **Step 11: Update the two routes**

```typescript
app.get('/:locale/portal/change-request', async (c) => {
  const locale = resolvePathLocale(c);
  const donorItemIds = await getSessionDonorIds(c, deps);
  if (donorItemIds === null) return c.redirect('/login');

  c.header('Cache-Control', NO_STORE);
  if (!changeRequestsEnabled(deps.config)) {
    return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), changeRequestsUnavailableView(locale), locale));
  }
  const donors = await Promise.all(donorItemIds.map((id) => deps.monday.getDonorContactInfo(id)));
  return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), changeRequestFormView(donors, locale), locale));
});

app.post('/:locale/portal/change-request', async (c) => {
  const locale = resolvePathLocale(c);
  const donorItemIds = await getSessionDonorIds(c, deps);
  if (donorItemIds === null) return c.redirect('/login');

  c.header('Cache-Control', NO_STORE);
  if (!changeRequestsEnabled(deps.config)) {
    return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), changeRequestsUnavailableView(locale), locale));
  }

  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const ipResult = await deps.ipLimiter.limit(`change:${ip}`);
  if (!ipResult.success) {
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.rateLimited', locale), locale), 429);
  }

  const sessionToken = getCookie(c, SESSION_COOKIE) as string;
  const sessionResult = await deps.ipLimiter.limit(`change:s:${await sha256Hex(sessionToken)}`);
  if (!sessionResult.success) {
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.rateLimited', locale), locale), 429);
  }

  const body = await c.req.parseBody();
  const input = {
    donorItemId: typeof body.donorItemId === 'string' ? body.donorItemId : '',
    field: typeof body.field === 'string' ? body.field : '',
    newValue: typeof body.newValue === 'string' ? body.newValue : '',
  };

  const result = await submitChangeRequest(donorItemIds, input, {
    monday: deps.monday,
    store: deps.changeStore,
    queue: deps.changeQueue,
    dedupeWindowHours: deps.config.changeRequests.dedupeWindowHours,
    now: deps.now,
  });
  return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), changeRequestResultView(result, locale), locale));
});
```

Plus the back-compat pair:

```typescript
app.get('/portal/change-request', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/change-request`));
```

(No bare-POST redirect needed — a form only ever posts to the locale-prefixed action URL rendered
by `changeRequestFormView` above, so there's no legacy bare-POST caller to support.)

- [ ] **Step 12: Update `routes.test.ts`** for the changed paths, mirroring Task 5/6.

- [ ] **Step 13: Run the full suite, confirm it passes**

Run: `cd donor-portal && npm test`

- [ ] **Step 14: Typecheck and commit**

```bash
git add donor-portal/src/db/changeRequests.ts donor-portal/src/db/changeRequests.test.ts donor-portal/src/changeRequests/ donor-portal/src/routes.ts donor-portal/src/routes.test.ts
git commit -m "feat(donor-portal): localize change-request form and add a Preferred Language field"
```

---

## Task 8: Membership card + public verify page

**Files:**
- Modify: `donor-portal/src/card/cardViews.ts`
- Modify: `donor-portal/src/card/cardViews.test.ts`
- Modify: `donor-portal/src/routes.ts` (`/portal/card/*` routes move under `/:locale`; `/verify/:token`
  gains locale detection, not path-prefixing)
- Modify: `donor-portal/src/routes.test.ts`

**Interfaces:**
- Consumes: `t`, `Locale`, `resolvePathLocale` (authenticated card routes), `detectLocale`
  (`/verify` — public, pre-identity-style, per the approved design decision that the viewer is shop
  staff, not the donor).
- Produces: `cardView(data: CardData, verifyUrl: string, qrSvg: string, locale: Locale): string`;
  `cardUnavailableView(locale: Locale): string`; `verifyView(data: CardData, locale: Locale):
  string`; `verifyNotValidView(locale: Locale): string`.

- [ ] **Step 1: Write the failing tests**

```typescript
// donor-portal/src/card/cardViews.test.ts — update existing tests' call sites to pass a locale,
// and add:
it('cardView locale-prefixes the regenerate form action and back-to-portal link', () => {
  const html = cardView(sampleCardData, 'https://portal.example.org/verify/abc', '<svg></svg>', 'ko');
  expect(html).toContain('/ko/portal');
  expect(html).toContain(`/ko/portal/card/${sampleCardData.donorId}/regenerate`);
});

it('verifyView renders tier/status/expiry in the requested locale (labels, not the raw values, which are Monday-sourced text)', () => {
  const html = verifyView(sampleCardData, 'fil');
  expect(html).toContain(sampleCardData.membershipTier);
});
```

Reuse whatever `sampleCardData: CardData` fixture the existing tests in this file define — read it
first rather than redefining.

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/card/cardViews.test.ts`

- [ ] **Step 3: Implement it**

```typescript
// donor-portal/src/card/cardViews.ts
import { escapeHtml } from '../views';
import type { CardData } from './loadCardData';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';

export function cardView(data: CardData, verifyUrl: string, qrSvg: string, locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'card.heading'))}</h1>
    <article class="card">
      <p><strong>${escapeHtml(data.donorName)}</strong></p>
      <p>${escapeHtml(data.memberNumber)}</p>
      <p>${escapeHtml(t(locale, 'card.tier', { tier: data.membershipTier }))}</p>
      <p>${escapeHtml(t(locale, 'card.status', { status: data.membershipStatus }))}</p>
      <p>${escapeHtml(t(locale, 'card.expires', { expiry: data.expiryDisplay }))}</p>
      <div class="qr">${qrSvg}</div>
      <p><a href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyUrl)}</a></p>
      <p><small>${escapeHtml(t(locale, 'card.scanHint'))}</small></p>
    </article>
    <form action="/${locale}/portal/card/${encodeURIComponent(data.donorId)}/regenerate" method="post">
      <button type="submit">${escapeHtml(t(locale, 'card.regenerate'))}</button>
    </form>
    <p><small>${escapeHtml(t(locale, 'card.regenerateHint'))}</small></p>
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}

export function cardUnavailableView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'card.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'card.unavailable'))}</p>
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}

export function verifyView(data: CardData, locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'verify.heading'))}</h1>
    <article class="card">
      <p><strong>${escapeHtml(data.donorName)}</strong></p>
      <p>${escapeHtml(t(locale, 'card.tier', { tier: data.membershipTier }))}</p>
      <p>${escapeHtml(t(locale, 'card.status', { status: data.membershipStatus }))}</p>
      <p>${escapeHtml(t(locale, 'card.expires', { expiry: data.expiryDisplay }))}</p>
    </article>
    <p><small>${escapeHtml(t(locale, 'verify.disclaimer'))}</small></p>
  `;
}

export function verifyNotValidView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'verify.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'verify.notValid'))}</p>
  `;
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/card/cardViews.test.ts`

- [ ] **Step 5: Update the four card/verify routes**

```typescript
app.get('/:locale/portal/card/:donorItemId', async (c) => {
  const locale = resolvePathLocale(c);
  const donorItemIds = await getSessionDonorIds(c, deps);
  if (donorItemIds === null) return c.redirect('/login');

  c.header('Cache-Control', NO_STORE);
  if (!cardEnabled(deps.config)) {
    return c.html(page(t(locale, 'title.card') + ' — ' + t(locale, 'site.title'), cardUnavailableView(locale), locale));
  }

  const donorItemId = c.req.param('donorItemId');
  if (!donorItemIds.includes(donorItemId)) {
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.cardNotFound', locale), locale), 404);
  }

  let donor;
  try {
    donor = await deps.monday.getDonorPortalData(donorItemId);
  } catch (err) {
    console.error(`donor-portal card load failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.cardLoadFailed', locale), locale), 500);
  }

  let token: string | null;
  try {
    token = await deps.cardTokenStore.getActiveToken(donorItemId);
  } catch (err) {
    console.error(`donor-portal card token lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.cardLoadFailed', locale), locale), 500);
  }
  if (token === null) {
    token = generateToken();
    try {
      await deps.cardTokenStore.createToken(donorItemId, token, deps.now().toISOString());
    } catch (err) {
      console.error(`donor-portal card token insert failed, re-reading active token: ${err instanceof Error ? err.message : String(err)}`);
      try {
        token = await deps.cardTokenStore.getActiveToken(donorItemId);
      } catch {
        token = null;
      }
      if (token === null) {
        return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.cardLoadFailed', locale), locale), 500);
      }
    }
  }

  const verifyUrl = `${deps.config.auth.portalBaseUrl}/verify/${token}`;
  const qrSvg = generateQrSvg(verifyUrl);
  return c.html(page(t(locale, 'title.card') + ' — ' + t(locale, 'site.title'), cardView(buildCardData(donor), verifyUrl, qrSvg, locale), locale));
});

app.post('/:locale/portal/card/:donorItemId/regenerate', async (c) => {
  const locale = resolvePathLocale(c);
  const donorItemIds = await getSessionDonorIds(c, deps);
  if (donorItemIds === null) return c.redirect('/login');

  if (!cardEnabled(deps.config)) {
    return c.html(page(t(locale, 'title.card') + ' — ' + t(locale, 'site.title'), cardUnavailableView(locale), locale));
  }

  const donorItemId = c.req.param('donorItemId');
  if (!donorItemIds.includes(donorItemId)) {
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.cardNotFound', locale), locale), 404);
  }

  const now = deps.now().toISOString();
  try {
    await deps.cardTokenStore.revokeAllForDonor(donorItemId, now);
  } catch (err) {
    console.error(`donor-portal card token revoke failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.cardRegenerateFailed', locale), locale), 500);
  }
  try {
    await deps.cardTokenStore.createToken(donorItemId, generateToken(), now);
  } catch (err) {
    console.error(`donor-portal card token regenerate failed, re-reading active token: ${err instanceof Error ? err.message : String(err)}`);
    let token: string | null;
    try {
      token = await deps.cardTokenStore.getActiveToken(donorItemId);
    } catch {
      token = null;
    }
    if (token === null) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.cardRegenerateFailed', locale), locale), 500);
    }
  }

  return c.redirect(`/${locale}/portal/card/${encodeURIComponent(donorItemId)}`);
});

// /verify/:token stays unprefixed and public: its viewer is a shop clerk scanning a donor's QR
// code, not the donor, so it uses the same cookie/Accept-Language detection as the pre-identity
// pages, never the donor's Monday-stored preference.
app.get('/verify/:token', async (c) => {
  const locale = detectLocale(c);
  c.header('Cache-Control', NO_STORE);

  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const ipResult = await deps.ipLimiter.limit(`verify:${ip}`);
  if (!ipResult.success) {
    return c.html(page(t(locale, 'title.verify') + ' — ' + t(locale, 'site.title'), errorView('error.rateLimited', locale), locale), 429);
  }

  if (!cardEnabled(deps.config)) {
    return c.html(page(t(locale, 'title.verify') + ' — ' + t(locale, 'site.title'), verifyNotValidView(locale), locale));
  }

  const token = c.req.param('token');
  let donorItemId: string | null;
  try {
    donorItemId = await deps.cardTokenStore.findActiveDonorId(token);
  } catch (err) {
    console.error(`donor-portal verify lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.verifyLoadFailed', locale), locale), 500);
  }
  if (donorItemId === null) {
    return c.html(page(t(locale, 'title.verify') + ' — ' + t(locale, 'site.title'), verifyNotValidView(locale), locale));
  }

  let donor;
  try {
    donor = await deps.monday.getDonorPortalData(donorItemId);
  } catch (err) {
    console.error(`donor-portal verify load failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.verifyLoadFailed', locale), locale), 500);
  }

  return c.html(page(t(locale, 'title.verify') + ' — ' + t(locale, 'site.title'), verifyView(buildCardData(donor), locale), locale));
});
```

Plus the back-compat pair:

```typescript
app.get('/portal/card/:donorItemId', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/card/${c.req.param('donorItemId')}`));
```

(No bare-POST redirect for `/regenerate` — same reasoning as Task 7's change-request POST: the
form action is always rendered locale-prefixed already.)

`/verify` itself has no language picker in this task — it's a scan-and-glance page for shop staff,
not somewhere a viewer is expected to go hunting for a language switcher. If that turns out to be
wrong in practice, it's a small follow-up (reuse `languagePicker()` from Task 4).

- [ ] **Step 6: Update `routes.test.ts`** for the changed card/verify paths, mirroring Tasks 5–7.

- [ ] **Step 7: Run the full suite, confirm it passes**

Run: `cd donor-portal && npm test`

- [ ] **Step 8: Typecheck and commit**

```bash
git add donor-portal/src/card/ donor-portal/src/routes.ts donor-portal/src/routes.test.ts
git commit -m "feat(donor-portal): localize the membership card page; detect (not path-prefix) locale on public /verify"
```

---

## Task 9: `preferredLanguage` — types, config, and Monday schema plumbing

**Files:**
- Modify: `donor-portal/src/types.ts` (`MondayColumns`, `DonorMatch`, `DonorContactInfo`)
- Modify: `donor-portal/src/config.ts` (presence-only check, matching the `membershipExpiry`
  precedent)
- Modify: `donor-portal/src/config.test.ts`
- Modify: `donor-portal/config/svbc.json`

**Interfaces:**
- Produces: `MondayColumns.preferredLanguage: string`; `DonorMatch.preferredLanguage: string` (raw
  Monday label text, `''` if unset — same convention as every other Monday-sourced text field in
  this codebase); `DonorContactInfo.preferredLanguage: string`.

**Run this task before Task 7** if your execution approach processes tasks strictly in order and
can't reorder — Task 7's `changeRequestViews.ts` change reads `DonorContactInfo.preferredLanguage`,
which doesn't exist until this task adds it. (Flagged in Task 7's Interfaces section too.)

- [ ] **Step 1: Write the failing test**

```typescript
// add to donor-portal/src/config.test.ts
it('accepts config with preferredLanguage present (even as the placeholder), same as membershipExpiry', () => {
  const cfg = { ...validBaseConfig(), monday: { ...validBaseConfig().monday, columns: { ...validBaseConfig().monday.columns, preferredLanguage: 'REPLACE_WITH_COLUMN_ID' } } };
  expect(() => validateConfig(cfg)).not.toThrow();
});

it('rejects config missing preferredLanguage entirely', () => {
  const cfg = validBaseConfig();
  delete (cfg.monday.columns as Record<string, unknown>).preferredLanguage;
  expect(() => validateConfig(cfg)).toThrow(/monday\.columns\.preferredLanguage/);
});
```

Use whatever base-config fixture/builder the existing `membershipExpiry` presence tests in this
file already use (`validBaseConfig()` above is illustrative — match the file's real helper name).

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/config.test.ts`

- [ ] **Step 3: Update `types.ts`**

```typescript
// donor-portal/src/types.ts — MondayColumns gains one field
export interface MondayColumns {
  donorEmail: string;
  membershipStatus: string;
  membershipTier: string;
  dollarDonated: string;
  donationDonorLink: string;
  donationAmount: string;
  donationDate: string;
  donationDescription: string;
  discountOffered: string;
  discountActive: string;
  donorAddress: string;
  donorPhone: string;
  membershipExpiry: string;
  preferredLanguage: string;
}

// DonorMatch gains one field
export interface DonorMatch {
  id: string;
  name: string;
  preferredLanguage: string;
}

// DonorContactInfo gains one field
export interface DonorContactInfo {
  id: string;
  name: string;
  email: string;
  address: string;
  phone: string;
  preferredLanguage: string;
}
```

- [ ] **Step 4: Update `config.ts`**

```typescript
// donor-portal/src/config.ts — mirror the existing CARD_COLUMNS pattern
const PREFERRED_LANGUAGE_COLUMN: (keyof MondayColumns)[] = ['preferredLanguage'];
```

Add `requireKeys(columns, 'monday.columns', PREFERRED_LANGUAGE_COLUMN);` on its own line right
after the existing `requireKeys(columns, 'monday.columns', CARD_COLUMNS);` call inside
`validateConfig`.

- [ ] **Step 5: Update `config/svbc.json`**

```jsonc
// add to the "columns" object, alongside "membershipExpiry"
"preferredLanguage": "REPLACE_WITH_COLUMN_ID"
```

- [ ] **Step 6: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/config.test.ts`

- [ ] **Step 7: Typecheck the whole project** (this step surfaces every other file that now fails
  to satisfy the widened `MondayColumns`/`DonorMatch`/`DonorContactInfo` types — expected until
  Task 10 updates `monday/client.ts` and its tests' fixtures)

Run: `cd donor-portal && npm run typecheck`
Expected: errors only in `src/monday/client.ts`, `src/monday/client.test.ts`,
`src/auth/requestLogin.test.ts`, and `src/routes.test.ts`'s fake-Monday helpers — all fixed by
Task 10.

- [ ] **Step 8: Commit**

```bash
git add donor-portal/src/types.ts donor-portal/src/config.ts donor-portal/src/config.test.ts donor-portal/config/svbc.json
git commit -m "feat(donor-portal): add preferredLanguage to MondayColumns/DonorMatch/DonorContactInfo"
```

---

## Task 10: Monday client reads and returns `preferredLanguage`

**Files:**
- Modify: `donor-portal/src/monday/client.ts` (`columnText`, `findDonorsByEmail`,
  `getDonorContactInfo`)
- Modify: `donor-portal/src/monday/client.test.ts`
- Modify: `donor-portal/src/routes.test.ts` (fake-Monday helpers' fixture objects)
- Modify: `donor-portal/src/auth/requestLogin.test.ts` (`fakeMonday` helper's fixture objects)

**Interfaces:**
- Consumes: `MondayColumns.preferredLanguage`, `DonorMatch.preferredLanguage`,
  `DonorContactInfo.preferredLanguage` (Task 9).
- Produces: `findDonorsByEmail` and `getDonorContactInfo` now populate `preferredLanguage` with the
  raw Monday column text (the label, e.g. `"Spanish"`, or `''` if unset/not yet configured).

- [ ] **Step 1: Write the failing tests**

```typescript
// add to donor-portal/src/monday/client.test.ts — follow this file's existing pattern for
// mocking fetchFn and asserting on request/response shape; read the existing
// findDonorsByEmail/getDonorContactInfo tests first and mirror their fetch-mock setup exactly.
it('findDonorsByEmail includes preferredLanguage in the matched donors when the column is configured', async () => {
  // mock fetchFn to return an item with column_values: [{ id: 'lang_col', text: 'Spanish' }]
  // construct HttpMondayClient with columns.preferredLanguage = 'lang_col'
  // assert result[0].preferredLanguage === 'Spanish'
});

it('findDonorsByEmail omits the column from the query (and returns "") when preferredLanguage is still the placeholder', async () => {
  // construct HttpMondayClient with columns.preferredLanguage = 'REPLACE_WITH_COLUMN_ID'
  // assert the captured request body's query string does NOT contain 'REPLACE_WITH_COLUMN_ID'
  // assert result[0].preferredLanguage === ''
});

it('getDonorContactInfo includes preferredLanguage alongside address/email/phone', async () => {
  // mirror the existing getDonorContactInfo test, adding a preferredLanguage column_value
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/monday/client.test.ts`

- [ ] **Step 3: Implement it**

```typescript
// donor-portal/src/monday/client.ts — columnText becomes defensive against an omitted
// column_values selection (needed because findDonorsByEmail conditionally omits the whole
// sub-selection below, rather than always requesting it)
function columnText(item: MondayItem, columnId: string): string {
  return (item.column_values ?? []).find((c) => c.id === columnId)?.text ?? '';
}
```

```typescript
// MondayItem's column_values must become optional to match:
interface MondayItem {
  id: string;
  name: string;
  column_values?: MondayColumnValue[];
}
```

```typescript
// findDonorsByEmail — conditionally include the column_values sub-selection, same guard style as
// getDonorPortalData's existing membershipExpiry handling
async findDonorsByEmail(email: string): Promise<DonorMatch[]> {
  const languageFragment =
    this.columns.preferredLanguage !== 'REPLACE_WITH_COLUMN_ID'
      ? `column_values(ids: ["${this.columns.preferredLanguage}"]) { id text }`
      : '';
  const query = `
    query ($boardId: ID!, $email: String!) {
      boards(ids: [$boardId]) {
        items_page(
          limit: 25,
          query_params: {
            rules: [{ column_id: "${this.columns.donorEmail}", compare_value: [$email], operator: any_of }]
          }
        ) {
          items { id name ${languageFragment} }
        }
      }
    }
  `;
  const data = await this.request<{ boards: { items_page: { items: MondayItem[] } }[] }>(query, {
    boardId: this.donorsBoardId,
    email,
  });
  const items = data.boards[0]?.items_page.items ?? [];
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    preferredLanguage: columnText(item, this.columns.preferredLanguage),
  }));
}
```

```typescript
// getDonorContactInfo — add preferredLanguage to the fixed column list, same conditional-inclusion
// pattern (it queries a fixed set of columns unconditionally today, but preferredLanguage is a
// gated/optional column like membershipExpiry, so it needs the same guard rather than joining the
// unconditional donorEmail/donorAddress/donorPhone list)
async getDonorContactInfo(donorItemId: string): Promise<DonorContactInfo> {
  const columnIds = [this.columns.donorEmail, this.columns.donorAddress, this.columns.donorPhone];
  if (this.columns.preferredLanguage !== 'REPLACE_WITH_COLUMN_ID') {
    columnIds.push(this.columns.preferredLanguage);
  }
  const query = `
    query ($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        name
        column_values(ids: ${JSON.stringify(columnIds)}) {
          id
          text
        }
      }
    }
  `;
  const data = await this.request<{ items: MondayItem[] }>(query, { itemId: donorItemId });
  const item = data.items[0];
  if (!item) {
    throw new Error(`monday: donor item "${donorItemId}" not found`);
  }
  return {
    id: item.id,
    name: item.name,
    email: columnText(item, this.columns.donorEmail),
    address: columnText(item, this.columns.donorAddress),
    phone: columnText(item, this.columns.donorPhone),
    preferredLanguage: columnText(item, this.columns.preferredLanguage),
  };
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/monday/client.test.ts`

- [ ] **Step 5: Fix the now-broken fixtures in `routes.test.ts` and `requestLogin.test.ts`**

Every inline `fakeMonday(...)` helper in these two files constructs `DonorMatch`/
`DonorContactInfo` object literals that now need a `preferredLanguage: ''` field (or a specific
test value where a test cares about it). Add it to each; don't change these files' other behavior.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `cd donor-portal && npm test && npm run typecheck`
Expected: PASS (Tasks 7 and 9's dependents should now be fully satisfied too).

- [ ] **Step 7: Commit**

```bash
git add donor-portal/src/monday/client.ts donor-portal/src/monday/client.test.ts donor-portal/src/routes.test.ts donor-portal/src/auth/requestLogin.test.ts
git commit -m "feat(donor-portal): read preferredLanguage from Monday in findDonorsByEmail and getDonorContactInfo"
```

---

## Task 11: `requestLogin` resolves the donor's language and carries it into the magic link

**Files:**
- Modify: `donor-portal/src/auth/requestLogin.ts`
- Modify: `donor-portal/src/auth/requestLogin.test.ts`
- Modify: `donor-portal/src/routes.ts` (`POST /login` call site)

**Interfaces:**
- Consumes: `Locale`, `isLocale`, `DEFAULT_LOCALE` (Task 1); `localeFromMondayLabel` (Task 1);
  `DonorMatch.preferredLanguage` (Task 10).
- Produces: `requestLogin(email: string, localeHint: Locale, deps: RequestLoginDeps): Promise<void>`
  — **signature change**: a new required `localeHint` positional parameter, second argument (before
  `deps`), matching the existing test file's call-site style. The generated magic-link URL now
  carries a `lang` query param.

- [ ] **Step 1: Write the failing tests**

```typescript
// donor-portal/src/auth/requestLogin.test.ts — update fakeMonday's return type to include
// preferredLanguage (Task 10 already required this; if Task 10 ran first this is already done),
// and add:
it('uses the matched donor\'s stored preferred language for the magic-link URL when set', async () => {
  const monday = fakeMonday([{ id: 'donor-1', name: 'Jane', preferredLanguage: 'Spanish' }]);
  const tokenStore = fakeTokenStore();
  const emailSender = fakeEmailSender();

  await requestLogin('shared@example.org', 'en', { monday, tokenStore, emailSender, ...baseDeps });

  const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
  expect(emailCall.loginUrl).toContain('lang=es');
  expect(emailCall.locale).toBe('es');
});

it('falls back to the localeHint when the donor has no preferred language on file', async () => {
  const monday = fakeMonday([{ id: 'donor-1', name: 'Jane', preferredLanguage: '' }]);
  const tokenStore = fakeTokenStore();
  const emailSender = fakeEmailSender();

  await requestLogin('shared@example.org', 'vi', { monday, tokenStore, emailSender, ...baseDeps });

  const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
  expect(emailCall.loginUrl).toContain('lang=vi');
  expect(emailCall.locale).toBe('vi');
});

it('falls back to en when the donor\'s stored label does not match any supported locale', async () => {
  const monday = fakeMonday([{ id: 'donor-1', name: 'Jane', preferredLanguage: 'Klingon' }]);
  await requestLogin('shared@example.org', 'en', { monday, tokenStore: fakeTokenStore(), emailSender: fakeEmailSender(), ...baseDeps });
  // (assert as above; expected 'en')
});
```

Update the existing `'creates a token covering every matched donor...'` test's `fakeMonday(...)`
fixture objects to add `preferredLanguage: ''` (or `'Spanish'`/etc. for the new tests above), and
its `requestLogin(...)` call to pass the new `'en'` positional argument.

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/auth/requestLogin.test.ts`

- [ ] **Step 3: Implement it**

```typescript
// donor-portal/src/auth/requestLogin.ts
import type { MondayClient } from '../monday/client';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/resend';
import { sha256Hex } from '../crypto/hash';
import { generateToken } from '../crypto/token';
import { DEFAULT_LOCALE, isLocale, localeFromMondayLabel, type Locale } from '../i18n/locales';

export interface RequestLoginDeps {
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  emailSender: EmailSender;
  portalBaseUrl: string;
  magicLinkTtlMinutes: number;
  now: () => Date;
}

export async function requestLogin(email: string, localeHint: Locale, deps: RequestLoginDeps): Promise<void> {
  const matches = await deps.monday.findDonorsByEmail(email);
  if (matches.length === 0) {
    return;
  }

  // First match's stored preference wins when a shared email matches multiple donor records with
  // different languages on file — a documented default (spec), not expected to come up often.
  // localeFromMondayLabel returns null for '' (unset) and for any value that isn't one of the
  // Monday dropdown's own options, so both cases fall through to localeHint identically.
  const storedLocale = isLocale(localeHint) ? localeFromMondayLabel(matches[0]!.preferredLanguage) : null;
  const locale: Locale = storedLocale ?? localeHint ?? DEFAULT_LOCALE;

  const rawToken = generateToken();
  const tokenHash = await sha256Hex(rawToken);
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + deps.magicLinkTtlMinutes * 60_000).toISOString();

  await deps.tokenStore.createToken({
    tokenHash,
    donorItemIds: matches.map((match) => match.id),
    expiresAt,
  });

  const loginUrl = `${deps.portalBaseUrl}/auth/callback?token=${rawToken}&lang=${locale}`;
  await deps.emailSender.sendLoginEmail({ to: email, loginUrl, locale });
}
```

(`isLocale(localeHint)` is always true in practice since `localeHint`'s type is already `Locale` —
this line is defensive against a caller passing an unvalidated string despite the type; keep it
simple and drop that guard if it reads as noise — `const locale: Locale =
localeFromMondayLabel(matches[0]!.preferredLanguage) ?? localeHint;` is equivalent and simpler
given `localeHint: Locale` is already a validated type at the call boundary in `routes.ts`.)

Use the simpler version:

```typescript
const locale: Locale = localeFromMondayLabel(matches[0]!.preferredLanguage) ?? localeHint;
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/auth/requestLogin.test.ts`

- [ ] **Step 5: Update the `POST /login` call site in `routes.ts`**

```typescript
// routes.ts — inside app.post('/login', ...), the requestLogin(...) call becomes:
const work = requestLogin(email, locale, {
  monday: deps.monday,
  tokenStore: deps.tokenStore,
  emailSender: deps.emailSender,
  portalBaseUrl: deps.config.auth.portalBaseUrl,
  magicLinkTtlMinutes: deps.config.auth.magicLinkTtlMinutes,
  now: deps.now,
}).catch((err) => {
  console.error(`donor-portal login request failed: ${err instanceof Error ? err.message : String(err)}`);
});
```

(`locale` here is the same `const locale = detectLocale(c);` this handler already computes at its
top, from Task 4 Step 5 — no new variable needed.)

- [ ] **Step 6: Run the full suite and typecheck**

Run: `cd donor-portal && npm test && npm run typecheck`

- [ ] **Step 7: Commit**

```bash
git add donor-portal/src/auth/requestLogin.ts donor-portal/src/auth/requestLogin.test.ts donor-portal/src/routes.ts
git commit -m "feat(donor-portal): resolve the donor's preferred language and carry it through the magic link"
```

---

## Task 12: Localized login email

**Files:**
- Modify: `donor-portal/src/email/resend.ts`
- Modify: `donor-portal/src/email/resend.test.ts`

**Interfaces:**
- Consumes: `t`, `Locale` (Task 1).
- Produces: `SendLoginEmailParams` gains `locale: Locale`; the email's subject/body come from
  `t(locale, 'email.*')`.

- [ ] **Step 1: Write the failing test**

```typescript
// add to donor-portal/src/email/resend.test.ts — follow the existing test's fetchFn-mocking
// pattern
it('sends the subject and body for the given locale', async () => {
  // construct ResendEmailSender with a mocked fetchFn capturing the request body
  // call sendLoginEmail({ to: 'donor@example.org', loginUrl: 'https://x/y', locale: 'en' })
  // assert the captured JSON body's `subject` equals t('en', 'email.subject')
  // assert the captured JSON body's `html` contains the loginUrl and t('en', 'email.loginButton')
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/email/resend.test.ts`

- [ ] **Step 3: Implement it**

```typescript
// donor-portal/src/email/resend.ts
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';

export interface SendLoginEmailParams {
  to: string;
  loginUrl: string;
  locale: Locale;
}

export interface EmailSender {
  sendLoginEmail(params: SendLoginEmailParams): Promise<void>;
}

export class ResendEmailSender implements EmailSender {
  constructor(
    private apiKey: string,
    private fromAddress: string,
    private fromName: string,
    private fetchFn: typeof fetch = fetch
  ) {}

  async sendLoginEmail(params: SendLoginEmailParams): Promise<void> {
    const response = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: `${this.fromName} <${this.fromAddress}>`,
        to: [params.to],
        subject: t(params.locale, 'email.subject'),
        html: `<p>${t(params.locale, 'email.bodyIntro')}</p><p><a href="${params.loginUrl}">${t(params.locale, 'email.loginButton')}</a></p>`,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`resend: HTTP ${response.status}: ${body}`);
    }
  }
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/email/resend.test.ts`

- [ ] **Step 5: Run the full suite and typecheck**

Run: `cd donor-portal && npm test && npm run typecheck`
Expected: PASS — Task 11 already updated the `sendLoginEmail` call site to pass `locale`.

- [ ] **Step 6: Commit**

```bash
git add donor-portal/src/email/resend.ts donor-portal/src/email/resend.test.ts
git commit -m "feat(donor-portal): localize the login-link email subject and body"
```

---

## Task 13: `/auth/callback` redirects into the resolved locale

**Files:**
- Modify: `donor-portal/src/routes.ts` (`GET /auth/callback` success path)
- Modify: `donor-portal/src/routes.test.ts`

**Interfaces:**
- Consumes: `isLocale`, `DEFAULT_LOCALE` (Task 1).

- [ ] **Step 1: Write the failing test**

```typescript
// add to donor-portal/src/routes.test.ts, in the existing /auth/callback describe block
it('redirects to the locale carried on the callback URL', async () => {
  // reuse this file's existing valid-token setup for /auth/callback, appending &lang=es to the
  // callback URL under test
  const app = createApp(depsWithValidToken(/* existing helper */));
  const res = await app.request('/auth/callback?token=valid-token&lang=es', { redirect: 'manual' });
  expect(res.headers.get('location')).toBe('/es/portal');
});

it('falls back to /en/portal when lang is missing or invalid', async () => {
  const app = createApp(depsWithValidToken());
  const res = await app.request('/auth/callback?token=valid-token', { redirect: 'manual' });
  expect(res.headers.get('location')).toBe('/en/portal');
});
```

Match `depsWithValidToken()` to whatever this file's existing successful-callback test already
sets up (read it first).

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/routes.test.ts`
Expected: FAIL — the handler still unconditionally redirects to `/portal`.

- [ ] **Step 3: Update the redirect**

```typescript
// routes.ts — inside app.get('/auth/callback', ...), replace the final `return c.redirect('/portal');`
const langParam = c.req.query('lang');
const redirectLocale = langParam !== undefined && isLocale(langParam) ? langParam : DEFAULT_LOCALE;
return c.redirect(`/${redirectLocale}/portal`);
```

(Placed after the existing `setCookie(c, SESSION_COOKIE, ...)` call, which is unchanged.)

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/routes.test.ts`

- [ ] **Step 5: Run the full suite and typecheck**

Run: `cd donor-portal && npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add donor-portal/src/routes.ts donor-portal/src/routes.test.ts
git commit -m "feat(donor-portal): redirect /auth/callback into the resolved locale's portal path"
```

---

## Task 14: Language switcher inside the portal → queues a change request

**Files:**
- Modify: `donor-portal/src/views.ts` (`portalView` — add the switcher)
- Modify: `donor-portal/src/views.test.ts`
- Modify: `donor-portal/src/changeRequests/submitChangeRequest.ts` (accept `'language'` values as
  Monday labels, not raw locale codes)
- Modify: `donor-portal/src/changeRequests/submitChangeRequest.test.ts`

**Interfaces:**
- Consumes: `SUPPORTED_LOCALES`, `LOCALE_LABELS` (Task 1).
- Produces: `portalView` renders a language `<select>` that, on change, submits a small form
  (`GET /lang/:code` navigates the browsing locale immediately) *and* a second, separate form
  posting to the existing `/:locale/portal/change-request` endpoint with `field=language` and the
  chosen locale's label as `newValue` — matching the spec's two-effects design (session-only
  browsing change now, reviewed Monday update for next time).

- [ ] **Step 1: Write the failing test**

```typescript
// add to donor-portal/src/views.test.ts, in the portalView describe block
it('includes a language switcher offering every supported locale', () => {
  const html = portalView(data, 'en');
  expect(html).toContain('/lang/es?to=%2Fen%2Fportal');
  expect(html).toContain('/lang/vi?to=%2Fen%2Fportal');
});

it('includes a per-language "make this my language" form posting field=language to the change-request endpoint', () => {
  const html = portalView(data, 'en');
  expect(html).toContain('action="/en/portal/change-request"');
  expect(html).toContain('value="language"');
  expect(html).toContain('value="Spanish"'); // the es option's newValue is the Monday label, not "es"
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/views.test.ts`

- [ ] **Step 3: Implement it**

```typescript
// donor-portal/src/views.ts — add near languagePicker(), and call it from portalView
import { SUPPORTED_LOCALES, LOCALE_LABELS, type Locale } from './i18n/locales';

// Distinct from languagePicker() (Task 4): this one is for the *authenticated* portal, where
// picking a language does two things — switches this visit's browsing locale immediately
// (via /lang/:code, same as the pre-identity picker) and offers to make it the donor's
// on-file preference via a change request (staff-reviewed, same path as an address/phone edit —
// see submitChangeRequest.ts). Each option is its own small form rather than one <select> with
// JS, keeping this view framework-free and working with JS disabled.
function portalLanguageSwitcher(locale: Locale, donorItemId: string): string {
  const currentPath = `/${locale}/portal`;
  const rows = SUPPORTED_LOCALES.filter((code) => code !== locale)
    .map((code) => {
      const label = LOCALE_LABELS[code];
      return `
        <li>
          <a href="/lang/${code}?to=${encodeURIComponent(currentPath)}">${escapeHtml(label)}</a>
          <form action="/${locale}/portal/change-request" method="post" style="display:inline">
            <input type="hidden" name="donorItemId" value="${escapeHtml(donorItemId)}" />
            <input type="hidden" name="field" value="language" />
            <input type="hidden" name="newValue" value="${escapeHtml(label)}" />
            <button type="submit">${escapeHtml(t(locale, 'changeRequest.submit'))}</button>
          </form>
        </li>
      `;
    })
    .join('');
  return `<section><h2>${escapeHtml(t(locale, 'languagePicker.label'))}</h2><ul>${rows}</ul></section>`;
}
```

Update `portalView` to call it once, using the *first* donor's id as the target record for the
"make this my preference" form (mirroring the design's documented default: first match wins when a
session covers multiple donor records):

```typescript
// portalView — add this line right after the opening <h1>
${data.donors.length > 0 ? portalLanguageSwitcher(locale, data.donors[0].id) : ''}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/views.test.ts`

- [ ] **Step 5: Confirm `submitChangeRequest` already accepts this shape correctly**

`submitChangeRequest`'s existing validation (`isChangeRequestField`, length cap, dedupe) already
handles `field: 'language'` generically since Task 7 widened `ChangeRequestField` — no code change
needed here. Write one integration-style test confirming the label (not a locale code) round-trips
correctly:

```typescript
// add to donor-portal/src/changeRequests/submitChangeRequest.test.ts
it('accepts a Monday label as the newValue for a language change (not a locale code)', async () => {
  // mirror this file's existing 'submits a valid address change' test, with
  // input: { donorItemId: '...', field: 'language', newValue: 'Spanish' }
  // assert result.kind === 'submitted' and the stored row's newValue === 'Spanish'
});
```

- [ ] **Step 6: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/changeRequests/submitChangeRequest.test.ts`

- [ ] **Step 7: Run the full suite and typecheck**

Run: `cd donor-portal && npm test && npm run typecheck`

- [ ] **Step 8: Commit**

```bash
git add donor-portal/src/views.ts donor-portal/src/views.test.ts donor-portal/src/changeRequests/submitChangeRequest.test.ts
git commit -m "feat(donor-portal): add an in-portal language switcher that queues a preference change request"
```

---

## Tasks 15–23: Translated locale files

Each task below fully populates one locale file, replacing its Task-1 empty-object stub. Every
task follows the same shape — **translate every key in `en.ts` (Task 2) into the target language**,
preserving every `{{var}}` placeholder unchanged, matching the register and terminology notes in
Global Constraints (general, non-technical audience; precise on "donation"/"membership tier").

Task 15 (Spanish) below is worked in full, including a representative excerpt, to fix the exact
format and tone every subsequent locale should match. Tasks 16–23 give only the file/export names
and the same step structure — translate the complete `en.ts` key set into that language the same
way Task 15 does into Spanish.

### Task 15: Spanish (`es`)

**Files:**
- Modify: `donor-portal/src/i18n/locales/es.ts`
- Create: `donor-portal/src/i18n/locales/es.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// donor-portal/src/i18n/locales/es.test.ts
import { describe, it, expect } from 'vitest';
import { es } from './es';
import { en } from './en';

describe('es locale', () => {
  it('has a translation for every English key', () => {
    for (const key of Object.keys(en)) {
      expect(es[key as keyof typeof en], `missing es translation for "${key}"`).toBeDefined();
    }
  });

  it('preserves every {{var}} placeholder from the English source', () => {
    for (const [key, enValue] of Object.entries(en)) {
      const placeholders = [...enValue.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[0]);
      const esValue = es[key as keyof typeof en];
      for (const placeholder of placeholders) {
        expect(esValue, `es "${key}" is missing ${placeholder}`).toContain(placeholder);
      }
    }
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd donor-portal && npm test -- src/i18n/locales/es.test.ts`
Expected: FAIL — `es.ts` is still the empty-object stub from Task 1.

- [ ] **Step 3: Translate every key from `en.ts` into Spanish**

Full literal translation of the Task 2 `en` object — same ~70 keys, same interpolation
placeholders, Spanish values. A representative excerpt (translate the *entire* key set the same
way, not just these):

```typescript
// donor-portal/src/i18n/locales/es.ts
import type { TranslationKey } from '../t';

export const es: Record<TranslationKey, string> = {
  'site.title': 'Portal de Donantes de SVBC',
  'languagePicker.label': 'Idioma',
  'title.login': 'Iniciar sesión',
  'title.checkEmail': 'Revisa tu correo',
  'title.error': 'Algo salió mal',
  'title.portal': 'Tu portal de donante',
  'title.lettersList': 'Documentos fiscales',
  'title.changeRequest': 'Solicitar un cambio',
  'title.card': 'Tu tarjeta de membresía',
  'title.verify': 'Verificación de membresía',
  'login.prompt': 'Ingresa tu correo electrónico para recibir un enlace de acceso.',
  'login.submit': 'Enviar enlace de acceso',
  'checkEmail.heading': 'Revisa tu correo',
  'checkEmail.body': 'Revisa tu correo electrónico: si esa dirección está registrada, un enlace de acceso está en camino. Caduca pronto y solo se puede usar una vez.',
  'error.heading': 'Algo salió mal',
  'error.requestNewLink': 'Solicitar un nuevo enlace de acceso',
  'error.invalidLink': 'Este enlace no es válido. Por favor solicita uno nuevo.',
  'error.expiredLink': 'Este enlace ha caducado o ya fue usado. Por favor solicita uno nuevo.',
  'portal.heading': 'Tu portal de donante',
  'portal.membership': 'Membresía: {{status}} ({{tier}})',
  'portal.totalDonated': 'Total donado: {{total}}',
  'letters.yearLink': 'Carta fiscal de {{year}}',
  'letters.noneYet': 'Aún no hay cartas disponibles para {{name}} — las cartas cubren años calendario completos con al menos una donación.',
  'card.tier': 'Nivel: {{tier}}',
  'card.status': 'Estado: {{status}}',
  'card.expires': 'Vence: {{expiry}}',
  'changeRequest.fieldLanguage': 'Idioma preferido',
  // ...continue for every remaining key in en.ts, following this same register and precision.
} satisfies Record<TranslationKey, string>;
```

Complete the file with every remaining key (all ~70) before moving on — this excerpt is a format
guide, not the full deliverable.

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/i18n/locales/es.test.ts`

- [ ] **Step 5: Run the full suite and typecheck**

Run: `cd donor-portal && npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add donor-portal/src/i18n/locales/es.ts donor-portal/src/i18n/locales/es.test.ts
git commit -m "feat(donor-portal): add Spanish translations"
```

### Task 16: Chinese Simplified (`zh-Hans`)

Same steps as Task 15. Files: `donor-portal/src/i18n/locales/zh-Hans.ts` (export name `zhHans`),
`donor-portal/src/i18n/locales/zh-Hans.test.ts` (import `{ zhHans } from './zh-Hans'`). Commit
message: `feat(donor-portal): add Chinese (Simplified) translations`.

### Task 17: Chinese Traditional (`zh-Hant`)

Same steps as Task 15. Files: `donor-portal/src/i18n/locales/zh-Hant.ts` (export name `zhHant`),
matching test file. Commit message: `feat(donor-portal): add Chinese (Traditional) translations`.

### Task 18: Filipino (`fil`)

Same steps as Task 15. Files: `donor-portal/src/i18n/locales/fil.ts` (export name `fil`), matching
test file. Commit message: `feat(donor-portal): add Filipino translations`.

### Task 19: Hindi (`hi`)

Same steps as Task 15. Files: `donor-portal/src/i18n/locales/hi.ts` (export name `hi`), matching
test file. Commit message: `feat(donor-portal): add Hindi translations`.

### Task 20: Japanese (`ja`)

Same steps as Task 15. Files: `donor-portal/src/i18n/locales/ja.ts` (export name `ja`), matching
test file. Commit message: `feat(donor-portal): add Japanese translations`.

### Task 21: Korean (`ko`)

Same steps as Task 15. Files: `donor-portal/src/i18n/locales/ko.ts` (export name `ko`), matching
test file. Commit message: `feat(donor-portal): add Korean translations`.

### Task 22: Portuguese, Brazil (`pt-BR`)

Same steps as Task 15. Files: `donor-portal/src/i18n/locales/pt-BR.ts` (export name `ptBR`),
matching test file. Commit message: `feat(donor-portal): add Portuguese (Brazil) translations`.

### Task 23: Vietnamese (`vi`)

Same steps as Task 15. Files: `donor-portal/src/i18n/locales/vi.ts` (export name `vi`), matching
test file. Commit message: `feat(donor-portal): add Vietnamese translations`.

---

## Task 24: Full-suite locale sweep + Monday column setup note

**Files:**
- Modify: `donor-portal/src/routes.test.ts`
- Modify: `donor-portal/README.md`

**Interfaces:**
- None new — this task is verification plus one documentation addition.

- [ ] **Step 1: Write a smoke test sweeping every supported locale across the main authenticated routes**

```typescript
// add to donor-portal/src/routes.test.ts
import { SUPPORTED_LOCALES } from './i18n/locales';

describe('locale sweep', () => {
  it.each(SUPPORTED_LOCALES)('serves /%s/portal with a matching <html lang>', async (locale) => {
    const app = createApp(depsWithSession());
    const res = await app.request(`/${locale}/portal`, { headers: { cookie: 'session=...' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`<html lang="${locale}">`);
  });
});
```

- [ ] **Step 2: Run it, confirm it passes**

Run: `cd donor-portal && npm test -- src/routes.test.ts`
Expected: PASS for all ten locales — this is the first test that would catch a locale file with a
type error subtle enough to slip past `npm run typecheck`'s structural check but wrong at runtime
(it isn't expected to catch translation *quality* issues — that's the acknowledged, approved
tradeoff — only that every locale actually renders).

- [ ] **Step 3: Run the entire test suite and typecheck one final time**

Run: `cd donor-portal && npm test && npm run typecheck`
Expected: PASS, zero errors.

- [ ] **Step 4: Document the Monday column setup in the README**

Add a short section to `donor-portal/README.md` (near wherever it already documents the other
gated columns like `membershipExpiry`, if such a section exists — otherwise near the "Blocking
precondition" section):

```markdown
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
```

- [ ] **Step 5: Commit**

```bash
git add donor-portal/src/routes.test.ts donor-portal/README.md
git commit -m "test(donor-portal): sweep every locale across the authenticated portal; document Monday column setup"
```
