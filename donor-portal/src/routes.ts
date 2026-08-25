import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { SessionStore } from './db/sessions';
import type { LoginAttemptStore } from './db/loginAttempts';
import type { EmailSender } from './email/types';
import type { IpRateLimiter } from './ratelimit';
import type { Config } from './types';
import type { ChangeRequestStore } from './db/changeRequests';
import type { ChangeQueueMessage } from './changeRequests/submitChangeRequest';
import type { LetterSendStore } from './db/letterSends';
import type { LetterSendQueueMessage } from './types';
import { validateLetterWebhookBody } from './letters/validateLetterWebhook';
import { triggerLetterSend } from './letters/triggerLetterSend';
import type { CardTokenStore } from './db/cardTokens';
import { checkLoginRateLimit } from './ratelimit';
import { requestLogin } from './auth/requestLogin';
import { verifyLogin } from './auth/verifyLogin';
import { loadPortalData } from './portal/loadPortalData';
import { checkEmailView, errorView, loginFormView, page, portalView } from './views';
import { sha256Hex } from './crypto/hash';
import {
  changeRequestsEnabled,
  configuredPrefFields,
  lettersEnabled,
  cardEnabled,
  funraiseLinks,
  pledgesEnabled,
  matchingGiftsSearchEnabled,
  signedOffEin,
} from './config';
import { loadPledgeData } from './pledges/loadPledgeData';
import { pledgesView, pledgesUnavailableView } from './pledges/pledgeViews';
import { matchingGiftsView } from './matchingGifts/matchingGiftViews';
import { generateToken } from './crypto/token';
import { listLetterYears, loadLetterData } from './letters/loadLetterData';
import { letterView, lettersListView, lettersUnavailableView } from './letters/letterViews';
import { submitChangeRequest } from './changeRequests/submitChangeRequest';
import { submitPreferences } from './changeRequests/submitPreferences';
import type { PrefField } from './types';
import { changeRequestFormView, changeRequestResultView, changeRequestsUnavailableView, preferencesResultView } from './changeRequests/changeRequestViews';
import { buildCardData } from './card/loadCardData';
import { generateQrSvg } from './card/qr';
import { cardView, cardUnavailableView, verifyView, verifyNotValidView } from './card/cardViews';
import { detectLocale, LANG_COOKIE } from './i18n/detectLocale';
import { isLocale, DEFAULT_LOCALE } from './i18n/locales';
import type { Locale } from './i18n/locales';
import { t } from './i18n/t';

export interface AppDeps {
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  sessionStore: SessionStore;
  attemptStore: LoginAttemptStore;
  emailSender: EmailSender;
  ipLimiter: IpRateLimiter;
  config: Config;
  now: () => Date;
  changeStore: ChangeRequestStore;
  changeQueue: { send(message: ChangeQueueMessage): Promise<void> };
  letterSendStore: LetterSendStore;
  letterQueue: { send(message: LetterSendQueueMessage): Promise<void> };
  letterWebhookSecret: string;
  cardTokenStore: CardTokenStore;
}

const SESSION_COOKIE = 'session';

// Conservative email plausibility check: rejects whitespace, quotes, and backslashes (the
// characters that would let a value break out of a GraphQL string literal), and requires an
// "@" plus at least one "." in the domain part. This is intentionally not full RFC 5322
// validation — it only needs to be strict enough to keep attacker input inert downstream.
const EMAIL_PATTERN = /^[^\s@"'\\]+@[^\s@"'\\]+\.[^\s@"'\\]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 max mailbox length

function isPlausibleEmail(email: string): boolean {
  return email.length > 0 && email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
}

// Donor PII must never be servable from browser cache/bfcache/history after logout on a
// shared machine — the server-side session deletion in POST /logout doesn't evict a
// previously cached rendering of a page. Every authenticated, PII-bearing route sets this.
const NO_STORE = 'private, no-store, max-age=0';

// Shared by every authenticated route: resolves the session cookie to the donor item ids it
// grants access to, or null if there is no valid session. Callers redirect to /login on null.
async function getSessionDonorIds(c: Context, deps: AppDeps): Promise<string[] | null> {
  const sessionToken = getCookie(c, SESSION_COOKIE);
  if (!sessionToken) return null;
  return deps.sessionStore.getSession(await sha256Hex(sessionToken), deps.now().toISOString());
}

// Shared by every authenticated route from this task on: the authenticated zone's locale comes
// from the `:locale` path param (not cookie/header sniffing like detectLocale), falling back to
// the default rather than 404ing on an unrecognized code.
function resolvePathLocale(c: Context): Locale {
  const raw = c.req.param('locale');
  return raw !== undefined && isLocale(raw) ? raw : DEFAULT_LOCALE;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.onError((err, c) => {
    console.error(`donor-portal unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    const locale = detectLocale(c);
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.generic', locale), locale), 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  const LANG_REDIRECT_ALLOWLIST = ['/login', '/portal'];

  // The in-portal switcher (Task 14) links back to the locale-prefixed portal path it was
  // clicked from (e.g. /en/portal), not the bare back-compat /portal — so the allowlist above
  // (exact matches only, to block open redirects like ?to=https://evil.example) needs a second
  // check for that one shape specifically, rather than just widening it to any path.
  function isAllowedLangRedirect(path: string): boolean {
    if (LANG_REDIRECT_ALLOWLIST.includes(path)) return true;
    const match = /^\/([^/]+)\/portal$/.exec(path);
    return match !== null && isLocale(match[1]!);
  }

  app.get('/lang/:code', (c) => {
    const code = c.req.param('code');
    const locale = isLocale(code) ? code : DEFAULT_LOCALE;
    setCookie(c, LANG_COOKIE, locale, { httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: 365 * 24 * 3600 });
    const requestedTo = c.req.query('to') ?? '/login';
    const to = isAllowedLangRedirect(requestedTo) ? requestedTo : '/login';
    return c.redirect(to);
  });

  app.get('/login', (c) => {
    const locale = detectLocale(c);
    return c.html(page(t(locale, 'title.login') + ' — ' + t(locale, 'site.title'), loginFormView(locale), locale));
  });

  app.post('/login', async (c) => {
    const locale = detectLocale(c);
    const body = await c.req.parseBody();
    const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    // A malformed email (fails the plausibility check) is treated exactly like an empty one —
    // skip rate-limiting and requestLogin entirely — so this branch produces the same generic
    // response as a well-formed but non-matching email, preserving the enumeration guard.
    const email = isPlausibleEmail(rawEmail) ? rawEmail : '';
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';

    if (email.length > 0) {
      try {
        const allowed = await checkLoginRateLimit(
          ip,
          email,
          { ipLimiter: deps.ipLimiter, attemptStore: deps.attemptStore, config: deps.config.rateLimit },
          deps.now()
        );
        if (allowed) {
          // requestLogin does a D1 write plus an email-send round-trip; awaiting it inline
          // would make the matching-email case measurably slower than the non-matching/denied
          // cases even though the response body is identical, letting an attacker distinguish
          // "matched" from "didn't match" by response latency alone. Defer it instead so the
          // response returns immediately regardless of match state.
          const work = requestLogin(email, locale, {
            monday: deps.monday,
            tokenStore: deps.tokenStore,
            emailSender: deps.emailSender,
            portalBaseUrl: deps.config.auth.portalBaseUrl,
            magicLinkTtlMinutes: deps.config.auth.magicLinkTtlMinutes,
            now: deps.now,
          }).catch((err) => {
            // Same enumeration-guard rule as below: a failure here must never surface as a
            // different response than the generic one — log and swallow.
            console.error(`donor-portal login request failed: ${err instanceof Error ? err.message : String(err)}`);
          });

          try {
            c.executionCtx.waitUntil(work);
          } catch {
            // c.executionCtx is unavailable outside a real Worker request (e.g. in app.request()
            // test helper) — fall back to awaiting inline so tests stay deterministic.
            await work;
          }
        }
      } catch (err) {
        // A failure here (e.g. checkLoginRateLimit's D1 read) must never surface as a different
        // response than the enumeration-safe path below — otherwise "did this email exist" leaks
        // through error-vs-success response variance. Log and fall through.
        console.error(`donor-portal login request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return c.html(page(t(locale, 'title.checkEmail') + ' — ' + t(locale, 'site.title'), checkEmailView(locale), locale));
  });

  app.get('/auth/callback', async (c) => {
    const locale = detectLocale(c);
    const token = c.req.query('token');
    if (!token) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.invalidLink', locale), locale));
    }

    let sessionToken: string | null;
    try {
      sessionToken = await verifyLogin(token, {
        tokenStore: deps.tokenStore,
        sessionStore: deps.sessionStore,
        sessionTtlHours: deps.config.auth.sessionTtlHours,
        now: deps.now,
      });
    } catch (err) {
      // e.g. the magic-link token was validly consumed but the follow-up session write failed
      // (D1 error) — show the same "request a new one" recovery path rather than a raw 500.
      console.error(`donor-portal login verification failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.expiredLink', locale), locale));
    }

    if (sessionToken === null) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.expiredLink', locale), locale));
    }

    setCookie(c, SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: deps.config.auth.sessionTtlHours * 3600,
    });
    const langParam = c.req.query('lang');
    const redirectLocale = langParam !== undefined && isLocale(langParam) ? langParam : DEFAULT_LOCALE;
    return c.redirect(`/${redirectLocale}/portal`);
  });

  // Back-compat: anything still linking to the old unprefixed /portal (a stale bookmark, an
  // email sent before locale-prefixed routes existed) lands on the default-locale equivalent
  // instead of 404ing.
  app.get('/portal', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal`));

  app.get('/:locale/portal', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) {
      return c.redirect('/login');
    }

    const data = await loadPortalData(donorItemIds, deps.monday);
    c.header('Cache-Control', NO_STORE);
    return c.html(page(t(locale, 'title.portal') + ' — ' + t(locale, 'site.title'), portalView(data, locale, funraiseLinks(deps.config)), locale));
  });

  // Back-compat: same reasoning as the bare /portal redirect above.
  app.get('/portal/letters', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/letters`));
  app.get('/portal/letters/:donorItemId/:year', (c) =>
    c.redirect(`/${DEFAULT_LOCALE}/portal/letters/${c.req.param('donorItemId')}/${c.req.param('year')}`)
  );

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
      // A Monday read failure here would otherwise fall through to the global onError, whose
      // generic "please try logging in again" copy is misleading — this isn't an auth problem.
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

    // The path param selects among the session's own donor items — never widens them.
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
      // Same reasoning as the letters-list route above: a Monday read failure isn't an auth
      // problem, so it shouldn't fall through to the global onError's login-focused copy.
      console.error(`donor-portal letter load failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.letterLoadFailed', locale), locale), 500);
    }
    if (data === null) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.letterNotFound', locale), locale), 404);
    }

    const generatedOn = deps.now().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
    // Browsers print the document <title> (and URL) in default print headers/footers, and this
    // page is meant to be printed/saved as a PDF — so the title needs to identify the letter on
    // its own, not just say "SVBC Donor Portal".
    const letterTitle = `SVBC ${data.year} Tax Letter — ${data.donorName}`;
    return c.html(page(letterTitle, letterView(data, deps.config.taxLetter, generatedOn, locale), locale));
  });

  // Back-compat: same reasoning as the bare /portal redirect above.
  app.get('/portal/change-request', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/change-request`));

  app.get('/:locale/portal/change-request', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    c.header('Cache-Control', NO_STORE);
    if (!changeRequestsEnabled(deps.config)) {
      return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), changeRequestsUnavailableView(locale), locale));
    }
    const donors = await Promise.all(donorItemIds.map((id) => deps.monday.getDonorContactInfo(id)));
    return c.html(
      page(
        t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'),
        changeRequestFormView(donors, locale, configuredPrefFields(deps.config)),
        locale
      )
    );
  });

  app.post('/:locale/portal/change-request', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    c.header('Cache-Control', NO_STORE);
    if (!changeRequestsEnabled(deps.config)) {
      return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), changeRequestsUnavailableView(locale), locale));
    }

    // Same limiter binding as login, but a distinct key prefix so the two budgets don't
    // interfere. No enumeration concern here (the caller is already authenticated), so a plain
    // 429 is fine.
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const ipResult = await deps.ipLimiter.limit(`change:${ip}`);
    if (!ipResult.success) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.rateLimited', locale), locale), 429);
    }

    // Spec also requires a per-session budget: an IP-only limit lets many donors sharing one
    // office/NAT IP throttle each other, and doesn't cap a single scripted/compromised session
    // hammering the endpoint from a rotating IP. The cookie was already validated by
    // getSessionDonorIds above, so it's guaranteed present here.
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

  app.post('/:locale/portal/change-request/preferences', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    c.header('Cache-Control', NO_STORE);
    if (!changeRequestsEnabled(deps.config)) {
      return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), changeRequestsUnavailableView(locale), locale));
    }

    // Same limiter keys as the free-text change-request POST above — the two forms share one
    // abuse budget since they feed the same staff queue.
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
    // Only fields whose Donors-board column is configured are read from the body — an
    // unconfigured preference can't be diffed against Monday, so a value for it is ignored
    // rather than rejected (the form never renders it; only a hand-crafted POST carries one).
    const prefs: Partial<Record<PrefField, boolean>> = {};
    for (const field of configuredPrefFields(deps.config)) {
      const value = body[field];
      if (value === 'yes') prefs[field] = true;
      else if (value === 'no') prefs[field] = false;
    }
    const input = {
      donorItemId: typeof body.donorItemId === 'string' ? body.donorItemId : '',
      prefs,
    };

    const result = await submitPreferences(donorItemIds, input, {
      monday: deps.monday,
      store: deps.changeStore,
      queue: deps.changeQueue,
      dedupeWindowHours: deps.config.changeRequests.dedupeWindowHours,
      now: deps.now,
    });
    return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), preferencesResultView(result, locale), locale));
  });

  // Back-compat: same reasoning as the bare /portal redirect above.
  app.get('/portal/pledges', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/pledges`));

  app.get('/:locale/portal/pledges', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    c.header('Cache-Control', NO_STORE);
    if (!pledgesEnabled(deps.config)) {
      return c.html(page(t(locale, 'title.pledges') + ' — ' + t(locale, 'site.title'), pledgesUnavailableView(locale), locale));
    }

    let sections;
    try {
      sections = await loadPledgeData(donorItemIds, deps.monday);
    } catch (err) {
      // Same reasoning as the letters routes: a Monday read failure isn't an auth problem, so
      // it shouldn't fall through to the global onError's login-focused copy.
      console.error(`donor-portal pledges load failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.pledgesLoadFailed', locale), locale), 500);
    }
    return c.html(page(t(locale, 'title.pledges') + ' — ' + t(locale, 'site.title'), pledgesView(sections, locale), locale));
  });

  // Back-compat: same reasoning as the bare /portal redirect above.
  app.get('/portal/matching-gifts', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/matching-gifts`));

  // Authenticated (it lives in the portal nav) but deliberately PII-free — see the note in
  // matchingGiftViews.ts about third-party JS. Reads nothing from Monday or D1, so there's no
  // load-failure branch; the only gate is whether the embedded search is configured, and the
  // page itself always renders.
  app.get('/:locale/portal/matching-gifts', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    c.header('Cache-Control', NO_STORE);
    // The app's only CSP, on its only page that may run third-party JS. The load-bearing part
    // is connect-src excluding 'self': the DTD script executes on the authenticated portal
    // origin, and without this a compromised ddplugin.js could fetch sibling /portal pages
    // (the session cookie rides along on same-origin requests — httpOnly protects the cookie
    // value, not cookie-bearing requests) and exfiltrate donor data. Verify the widget still
    // works under this policy alongside the embed-snippet check (matchingGiftViews.ts NOTE)
    // before provisioning a key.
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://doublethedonation.com; " +
        "style-src 'self' https://doublethedonation.com; img-src 'self' https://doublethedonation.com data:; " +
        "connect-src https://doublethedonation.com; frame-ancestors 'none'"
    );
    const ein = signedOffEin(deps.config);
    const publicApiKey = matchingGiftsSearchEnabled(deps.config) ? deps.config.matchingGifts.doubleTheDonationPublicKey : null;
    return c.html(
      page(t(locale, 'title.matchingGifts') + ' — ' + t(locale, 'site.title'), matchingGiftsView({ publicApiKey, ein }, locale), locale)
    );
  });

  // Back-compat: same reasoning as the bare /portal redirect above.
  app.get('/portal/card/:donorItemId', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/card/${c.req.param('donorItemId')}`));

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
        // The one-active-token-per-donor DB constraint (migrations/0003) throws here if a
        // concurrent request for the same donor won the race and inserted first. Re-read rather
        // than fail the request — the other request's token is just as valid. A genuine
        // unrelated D1 outage would simply fail again on this re-read, and is reported with this
        // route's own copy below rather than falling through to the generic (and misleading,
        // login-flavored) app.onError handler.
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

  // No bare-POST redirect for /regenerate — same reasoning as the change-request POST above: the
  // form action is always rendered locale-prefixed already, so there is no unprefixed submitter.
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
      // The one-active-token-per-donor DB constraint (migrations/0003) throws here if a
      // concurrent regenerate for the same donor (double-click, two open tabs) revoked and
      // re-inserted first. This request's own token is moot in that case — the concurrent
      // request's token is just as valid, and the redirect below doesn't need to know which
      // token is active, only that one exists. Re-read rather than fail the request. A genuine
      // unrelated D1 outage would simply fail again on this re-read, and is reported with this
      // route's own copy below rather than falling through to the generic (and misleading,
      // login-flavored) app.onError handler.
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
  // code or opening the link, not the donor, so it uses the same cookie/Accept-Language
  // detection as the pre-identity pages (detectLocale), never a locale path segment and never
  // the donor's Monday-stored preference.
  app.get('/verify/:token', async (c) => {
    const locale = detectLocale(c);
    c.header('Cache-Control', NO_STORE);

    // Rate-limit before the kill-switch check below, not after — otherwise disabling the card
    // feature (config revert, incident response) also disables rate limiting on this endpoint,
    // turning the exact moment someone flips the kill switch into an unlimited request sink.
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const ipResult = await deps.ipLimiter.limit(`verify:${ip}`);
    if (!ipResult.success) {
      return c.html(page(t(locale, 'title.verify') + ' — ' + t(locale, 'site.title'), errorView('error.rateLimited', locale), locale), 429);
    }

    // If the card feature is ever disabled after tokens have already been issued (config
    // revert, incident response), every previously-issued verify link must stop serving PII —
    // this is the kill switch's only enforcement point, since token issuance/regeneration is
    // already gated. Reuse the generic "not valid" response so this carries no signal
    // distinguishing "feature off" from "token doesn't exist".
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

  app.post('/logout', async (c) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (sessionToken) {
      await deps.sessionStore.deleteSession(await sha256Hex(sessionToken));
    }
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login');
  });

  // Monday doesn't sign webhook payloads (no HMAC header to verify) — the standard mitigation
  // used elsewhere in this repo (donation-rollups) is a shared secret in the webhook URL itself,
  // set when subscribing and checked here.
  app.post('/webhooks/monday/letters', async (c) => {
    if (!deps.letterWebhookSecret || c.req.query('secret') !== deps.letterWebhookSecret) {
      return c.json({ ok: false }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 200);
    }

    // Monday's webhook-subscription verification handshake: echo the challenge back verbatim,
    // no other processing. Sent once, at subscription-creation time.
    if (typeof body === 'object' && body !== null && 'challenge' in body) {
      return c.json({ challenge: (body as { challenge: unknown }).challenge }, 200);
    }

    let event;
    try {
      event = validateLetterWebhookBody(body);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`donor-portal webhook: rejected letter-send delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }

    let result;
    try {
      result = await triggerLetterSend(event.donorItemId, {
        monday: deps.monday,
        store: deps.letterSendStore,
        queue: deps.letterQueue,
        now: deps.now,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`donor-portal webhook: letter-send trigger failed for donor "${event.donorItemId}": ${errMsg}`);
      return c.json({ ok: false }, 500);
    }

    if (result.kind !== 'queued') {
      console.log(`donor-portal webhook: letter-send for donor "${event.donorItemId}" resulted in "${result.kind}"`);
    }
    return c.json({ ok: true, result: result.kind }, 200);
  });

  return app;
}
