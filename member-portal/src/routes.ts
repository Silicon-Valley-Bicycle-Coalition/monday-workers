import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { SessionStore } from './db/sessions';
import type { LoginAttemptStore } from './db/loginAttempts';
import type { EmailSender } from './email/types';
import type { IpRateLimiter } from './ratelimit';
import type { Config, DonorImpact } from './types';
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
import { CONFIRM_LOGIN_SCRIPT, checkEmailView, confirmLoginView, errorView, loginFormView, page, portalView, unavailableView } from './views';
import { sha256Base64, sha256Hex } from './crypto/hash';
import { secretsMatch } from './crypto/secretsMatch';
import {
  changeRequestsEnabled,
  configuredPrefFields,
  lettersEnabled,
  cardEnabled,
  eventsEnabled,
  funraiseLinks,
  pledgesEnabled,
  matchingGiftsSearchEnabled,
  signedOffEin,
  volunteerHistoryEnabled,
  donationHistoryEnabled,
} from './config';
import { loadPledgeData } from './pledges/loadPledgeData';
import { pledgesView, pledgesUnavailableView } from './pledges/pledgeViews';
import { matchingGiftsView } from './matchingGifts/matchingGiftViews';
import { selectImpact } from './impact/impact';
import { generateToken } from './crypto/token';
import { listLetterYears, loadLetterData } from './letters/loadLetterData';
import { letterView, lettersListView, lettersUnavailableView } from './letters/letterViews';
import { submitChangeRequest } from './changeRequests/submitChangeRequest';
import { submitPreferences } from './changeRequests/submitPreferences';
import type { PrefField } from './types';
import { changeRequestFormView, changeRequestResultView, changeRequestsUnavailableView, preferencesResultView } from './changeRequests/changeRequestViews';
import { loadEventRegistrations } from './events/loadEventRegistrations';
import type { EventRegistrationListing } from './events/loadEventRegistrations';
import { eventsListView, eventsUnavailableView } from './events/eventViews';
import { buildCardData } from './card/loadCardData';
import type { PortalCard } from './card/loadCardData';
import { generateQrSvg } from './card/qr';
import { getOrCreateCardToken } from './card/getOrCreateCardToken';
import { verifyView, verifyNotValidView } from './card/cardViews';
import { detectLocale, LANG_COOKIE } from './i18n/detectLocale';
import { isLocale, DEFAULT_LOCALE } from './i18n/locales';
import type { Locale } from './i18n/locales';
import { t } from './i18n/t';
import { decodeFavicon } from './assets/favicon';
import { decodeEmailLogoPng } from './assets/emailLogo';
import { DEFAULT_CSP, securityHeaders } from './securityHeaders';
import { errorText } from './logSafe';
import { logSkip } from './flags';
import { stampedQueue, type BatchSkipContext } from './writeSwitch';

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
  // The write switch for this request (src/writeSwitch.ts), read from KV at most once and only by
  // a route that writes.
  writeGate: () => Promise<BatchSkipContext>;
}

// __Host- makes the browser reject any copy that isn't Secure, Path=/ and Domain-less, so a sibling
// subdomain can't plant a session cookie scoped to a longer path (#103).
const SESSION_COOKIE = '__Host-session';
export const WEBHOOK_SECRET_HEADER = 'X-Webhook-Secret';

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
// grants access to, or null if there is no valid session. Callers redirect to / (login) on null.
async function getSessionDonorIds(c: Context, deps: AppDeps): Promise<string[] | null> {
  const sessionToken = getCookie(c, SESSION_COOKIE);
  if (!sessionToken) return null;
  return deps.sessionStore.getSession(await sha256Hex(sessionToken), deps.now().toISOString());
}

// Shared by every authenticated route: the authenticated zone's locale comes from the `:locale`
// path param (not cookie/header sniffing like detectLocale). An unsupported code never reaches a
// handler — the requireSupportedLocale middleware in createApp 404s it — so the fallback below
// is only a type-level default.
function resolvePathLocale(c: Context): Locale {
  const raw = c.req.param('locale');
  return raw !== undefined && isLocale(raw) ? raw : DEFAULT_LOCALE;
}

// Server-to-server endpoints exempt from the CSRF check, by exact method + path. Deliberately not
// a prefix: every authenticated route starts with a wildcard `:locale` segment, so a "/webhooks/"
// prefix exemption also matched /webhooks/portal/change-request (issue #32 review).
const CSRF_EXEMPT = new Set(['POST /webhooks/monday/letters']);

// A POST that writes, under any mode but `on`: a friendly page, 503 so nothing caches it.
function unavailable(c: Context, locale: Locale, authenticated: boolean) {
  return c.html(page(t(locale, 'title.unavailable') + ' — ' + t(locale, 'site.title'), unavailableView(locale, authenticated), locale, { authenticated }), 503);
}

// Hashed once per isolate: the input is a constant, so sharing it across requests is safe.
let confirmLoginScriptHashPromise: Promise<string> | null = null;
function confirmLoginScriptHash(): Promise<string> {
  confirmLoginScriptHashPromise ??= sha256Base64(CONFIRM_LOGIN_SCRIPT).then((b64) => `sha256-${b64}`);
  return confirmLoginScriptHashPromise;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  // The one origin this deployment serves (member.bikesiliconvalley.org in production,
  // member.sandbox.bikesiliconvalley.org in the sandbox — config/split.test.ts pins each to its
  // wrangler.jsonc custom domain). Used by the CSRF check and the language-switch redirect.
  const portalOrigin = new URL(deps.config.auth.portalBaseUrl).origin;

  // First, so it wraps every response — including onError's and the 404 fallback.
  app.use('*', ...securityHeaders());

  // CSRF (issue #32): the session cookie is SameSite=Lax, which still rides along on a form POST
  // from any *.bikesiliconvalley.org sibling — same-site, just not same-origin. Hono's csrf()
  // rejects a form-encodable POST (urlencoded, multipart, text/plain, or no Content-Type) unless
  // Sec-Fetch-Site is same-origin or Origin is exactly the portal origin. Every form here posts
  // from the portal's own pages; nothing on the main site posts into it. The Monday webhook is
  // server-to-server (no Origin, no Sec-Fetch-Site) and authenticates with its shared secret
  // instead, so it alone is exempt (CSRF_EXEMPT — exact paths, never a prefix).
  const csrfCheck = csrf({ origin: portalOrigin });
  app.use('*', (c, next) => (CSRF_EXEMPT.has(`${c.req.method} ${c.req.path}`) ? next() : csrfCheck(c, next)));

  // Every locale-prefixed route 404s an unsupported locale rather than silently rendering the
  // default one: a wildcard first segment that accepts anything is how "webhooks" became a
  // valid locale. The un-prefixed back-compat redirects (/portal, /portal/letters, ...) don't
  // match these patterns, so they're unaffected.
  const requireSupportedLocale: MiddlewareHandler = async (c, next) => {
    const raw = c.req.param('locale');
    if (raw === undefined || !isLocale(raw)) return c.notFound();
    await next();
  };
  app.use('/:locale/portal', requireSupportedLocale);
  app.use('/:locale/portal/*', requireSupportedLocale);

  app.onError((err, c) => {
    const locale = detectLocale(c);
    if (err instanceof HTTPException && err.status === 403) {
      // The CSRF rejection. A real donor only lands here from a stale/odd browser state, so give
      // them the same recoverable page as any other failure rather than a bare "Forbidden".
      console.warn(`member-portal: rejected cross-origin ${c.req.method} ${c.req.path} (Origin: ${c.req.header('origin') ?? 'none'})`);
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.generic', locale), locale), 403);
    }
    console.error(`member-portal unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.generic', locale), locale), 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // Served from an embedded constant rather than a Workers Assets binding (none configured here)
  // — long cache header since the bytes never change without a redeploy.
  app.get('/favicon.png', () => {
    // decodeFavicon()'s Uint8Array itself isn't a valid BodyInit under this project's TS lib
    // config (its .buffer is typed ArrayBufferLike, and .slice() widens further to include
    // SharedArrayBuffer) — copying into a fresh ArrayBuffer sidesteps both.
    const bytes = decodeFavicon();
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return new Response(buffer, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  });

  // Rasterized logo for branded emails (see assets/emailLogo.ts and email/layout.ts) — email
  // clients can't render the inline SVG used elsewhere on the site, so outbound HTML emails
  // reference this route by absolute URL (config.email.logoUrl) as an <img src>.
  app.get('/email/logo.png', () => {
    const bytes = decodeEmailLogoPng();
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return new Response(buffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Loaded as an <img> by webmail clients on their own origins — the one cross-origin
        // resource here (see securityHeaders.ts's same-origin default).
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
  });

  // The language switcher lives in the shared site footer (see views.ts's siteFooter) and so
  // appears on every route, submitting the browser's current location.pathname as `to` — rather
  // than hand-maintain an exact-match allowlist of every page shape that can now show it, this
  // accepts any same-origin target. It does so by parsing, not by prefix-matching: a blocklist
  // of string prefixes ("//", "/\") missed "/<TAB>/evil.example" (issue #32), because browsers
  // strip ASCII tab/newline and leading C0 controls while parsing a Location value. Resolving
  // with the same WHATWG URL parser the browser uses, requiring the portal's own origin, and
  // re-emitting only the parser's normalized pathname + search means what we send is exactly
  // what the browser will follow. Returns null for anything off-origin.
  function sameOriginRedirectPath(to: string): { pathname: string; search: string } | null {
    let url: URL;
    try {
      url = new URL(to, portalOrigin);
    } catch {
      return null;
    }
    if (url.origin !== portalOrigin) return null;
    // Dot-segment normalization can still yield a "//host" pathname (e.g. "/.//evil.example"),
    // which is protocol-relative once it stands alone in a Location header.
    if (url.pathname.startsWith('//')) return null;
    return { pathname: url.pathname, search: url.search };
  }

  // Sets the lang cookie and returns the resolved locale (falling back to the default for an
  // unsupported/missing code) so the caller can also rewrite a :locale path segment below.
  function setLangCookie(c: Context, code: string): Locale {
    const locale = isLocale(code) ? code : DEFAULT_LOCALE;
    setCookie(c, LANG_COOKIE, locale, { httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: 365 * 24 * 3600 });
    return locale;
  }

  // The authenticated portal tree reads its locale from the `:locale` path segment, not the lang
  // cookie (see resolvePathLocale) — so redirecting back to the exact page a switch was submitted
  // from would silently keep rendering the old locale, cookie notwithstanding. Rewrite that
  // segment to the newly-selected locale for any /:locale/portal... path; every other page (pre-
  // identity, /verify) has no locale segment and is left untouched, since those already pick up
  // the cookie via detectLocale on next render.
  function applyLocaleToPath(path: string, locale: Locale): string {
    const match = /^\/[^/]+(\/portal(?:\/.*)?)$/.exec(path);
    return match ? `/${locale}${match[1]}` : path;
  }

  function langRedirectTarget(c: Context, locale: Locale): string {
    const target = sameOriginRedirectPath(c.req.query('to') ?? '/');
    if (target === null) return '/';
    return applyLocaleToPath(target.pathname, locale) + target.search;
  }

  app.get('/lang/:code', (c) => {
    const locale = setLangCookie(c, c.req.param('code'));
    return c.redirect(langRedirectTarget(c, locale));
  });

  // Query-string variant of the route above, for the site footer's language <select> (see
  // views.ts's siteFooter) — a native <select> can't submit into a dynamic path segment without
  // JS, so the form posts `code` as a query param instead of hitting /lang/:code directly.
  app.get('/lang', (c) => {
    const locale = setLangCookie(c, c.req.query('code') ?? '');
    return c.redirect(langRedirectTarget(c, locale));
  });

  // Back-compat: the login page used to live at /login; a stale bookmark or link lands here and
  // is sent to the new root path, matching this route table's existing back-compat convention
  // (see the bare /portal redirect below).
  app.get('/login', (c) => c.redirect('/'));

  app.get('/', (c) => {
    const locale = detectLocale(c);
    return c.html(page(t(locale, 'title.login') + ' — ' + t(locale, 'site.title'), loginFormView(locale), locale));
  });

  app.post('/', async (c) => {
    const locale = detectLocale(c);
    // Every email gets the same page, so the enumeration guard below holds under the switch too.
    if ((await deps.writeGate()).mode !== 'on') return unavailable(c, locale, false);
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
            console.error(`member-portal login request failed: ${errorText(err)}`);
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
        console.error(`member-portal login request failed: ${errorText(err)}`);
      }
    }

    return c.html(page(t(locale, 'title.checkEmail') + ' — ' + t(locale, 'site.title'), checkEmailView(locale), locale));
  });

  // The emailed magic link (login and letter-ready alike) lands here — and so do the corporate
  // mail scanners (Outlook Safe Links, Mimecast, Proofpoint) that prefetch every link in an
  // inbound email, often executing its JS. Consuming the single-use token on this GET burned it
  // before the donor ever clicked (issue #31), so the GET is inert: it renders a button that
  // POSTs the token back to the route below, and only that POST consumes it.
  //
  // The token arrives in the URL fragment (issue #61: in the query string it reached Workers
  // Logs, and a letter link lives up to 168 hours), so the server never sees it here; the page's
  // script copies it into the form. A ?token= link is one sent before that change and still
  // renders as before. Drop that branch once every such link has expired: letterLinkTtlHours
  // after the #61 deploy.
  app.get('/auth/callback', async (c) => {
    const langParam = c.req.query('lang');
    const lang = langParam !== undefined && isLocale(langParam) ? langParam : null;
    const locale = lang ?? detectLocale(c);
    const legacyToken = c.req.query('token');
    if (legacyToken === '') {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.invalidLink', locale), locale));
    }

    c.header('Cache-Control', NO_STORE);
    c.header('X-Robots-Tag', 'noindex');
    // This page's URL carries a live token. same-origin sends no Referer at all cross-origin
    // (stricter than the app-wide strict-origin-when-cross-origin), while — unlike no-referrer —
    // still letting the browser send a real Origin on this page's own same-origin POST, which the
    // CSRF check requires (older Safari sends no Sec-Fetch-Site to fall back on).
    c.header('Referrer-Policy', 'same-origin');
    // The page holds a live token in its DOM, so the one script that may run on it is ours.
    c.header('Content-Security-Policy', `${DEFAULT_CSP}; script-src '${await confirmLoginScriptHash()}'`);
    // No footer language picker here: it redirects to location.pathname only, which would drop
    // the token (and the token must never be copied into the /lang redirect URL). The page
    // already renders in the link's own `lang`.
    return c.html(
      page(t(locale, 'title.confirmLogin') + ' — ' + t(locale, 'site.title'), confirmLoginView(legacyToken ?? null, lang, locale), locale, {
        languagePicker: false,
      })
    );
  });

  // Covered by the app-wide CSRF check like every other form POST (it is not in CSRF_EXEMPT): the
  // confirmation page above submits same-origin, and a cross-site page can't log a victim's
  // browser into someone else's account with a token it holds (login CSRF).
  app.post('/auth/callback', async (c) => {
    const body = await c.req.parseBody();
    const lang = typeof body.lang === 'string' && isLocale(body.lang) ? body.lang : null;
    const locale = lang ?? detectLocale(c);
    const token = typeof body.token === 'string' ? body.token : '';
    if (token.length === 0) {
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
      console.error(`member-portal login verification failed: ${errorText(err)}`);
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
    // 303: the browser follows a POST's redirect with a GET.
    return c.redirect(`/${lang ?? DEFAULT_LOCALE}/portal`, 303);
  });

  // Back-compat: anything still linking to the old unprefixed /portal (a stale bookmark, an
  // email sent before locale-prefixed routes existed) lands on the default-locale equivalent
  // instead of 404ing.
  app.get('/portal', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal`));

  app.get('/:locale/portal', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) {
      return c.redirect('/');
    }

    const data = await loadPortalData(
      donorItemIds,
      deps.monday,
      {
        enabled: volunteerHistoryEnabled(deps.config),
        completedStatuses: deps.config.volunteerHistory.completedStatuses,
      },
      donationHistoryEnabled(deps.config, deps.now())
    );
    c.header('Cache-Control', NO_STORE);

    // Same degrade-instead-of-fail treatment as volunteer history above: a Monday read failure
    // here should cost the donor the Events tab, not the whole dashboard. Disabled and
    // failed-to-load both collapse to `null`, which donorSection() treats as "omit this tab".
    let eventsByDonor: Record<string, EventRegistrationListing> | null = null;
    if (eventsEnabled(deps.config)) {
      try {
        const listings = await loadEventRegistrations(donorItemIds, deps.monday, deps.config.eventRegistrations, deps.now());
        eventsByDonor = Object.fromEntries(listings.map((listing) => [listing.donorId, listing]));
      } catch (err) {
        console.error(`member-portal dashboard events load failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // The membership card is now a dashboard widget (one per donor), not a separate page — see
    // views.ts's memberCardWidget. A token failure for one donor is logged and that donor simply
    // renders without a card widget; it must never take down the whole dashboard, since donation
    // history, discounts, and everything else on the page is still useful without it.
    const cards: Record<string, PortalCard> = {};
    if (cardEnabled(deps.config)) {
      for (const donor of data.donors) {
        try {
          const token = await getOrCreateCardToken(donor.id, deps.cardTokenStore, deps.now);
          const verifyUrl = `${deps.config.auth.portalBaseUrl}/verify/${token}`;
          cards[donor.id] = { data: buildCardData(donor), qrSvg: generateQrSvg(verifyUrl) };
        } catch (err) {
          console.error(`member-portal dashboard card failed for donor "${donor.id}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // "Your giving supported …" (v8): per donor, from the gifts already loaded for the Donations
    // tab — so it follows the same date gate and costs no extra Monday read. Gated here rather
    // than on an empty donations list, so a hidden history never leaks a "you gave in <year>".
    const impact: Record<string, DonorImpact> = {};
    if (data.donationHistoryEnabled) {
      for (const donor of data.donors) {
        const selected = selectImpact(donor.donations, deps.config.impact, locale);
        if (selected !== null) impact[donor.id] = selected;
      }
    }

    return c.html(
      page(
        t(locale, 'title.portal') + ' — ' + t(locale, 'site.title'),
        portalView(data, locale, cards, funraiseLinks(deps.config), eventsByDonor, impact, deps.config.getInvolved.links),
        locale,
        { authenticated: true }
      )
    );
  });

  // Back-compat: same reasoning as the bare /portal redirect above.
  app.get('/portal/letters', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/letters`));
  app.get('/portal/letters/:donorItemId/:year', (c) =>
    c.redirect(`/${DEFAULT_LOCALE}/portal/letters/${c.req.param('donorItemId')}/${c.req.param('year')}`)
  );

  app.get('/:locale/portal/letters', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/');

    c.header('Cache-Control', NO_STORE);
    if (!lettersEnabled(deps.config)) {
      return c.html(page(t(locale, 'title.lettersList') + ' — ' + t(locale, 'site.title'), lettersUnavailableView(locale), locale, { authenticated: true }));
    }
    let listings;
    try {
      listings = await listLetterYears(donorItemIds, deps.monday, deps.config.taxLetter, deps.now());
    } catch (err) {
      // A Monday read failure here would otherwise fall through to the global onError, whose
      // generic "please try logging in again" copy is misleading — this isn't an auth problem.
      console.error(`member-portal letters list failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.lettersLoadFailed', locale), locale, { authenticated: true }), 500);
    }
    return c.html(page(t(locale, 'title.lettersList') + ' — ' + t(locale, 'site.title'), lettersListView(listings, locale), locale, { authenticated: true }));
  });

  app.get('/:locale/portal/letters/:donorItemId/:year', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/');

    c.header('Cache-Control', NO_STORE);
    if (!lettersEnabled(deps.config)) {
      return c.html(page(t(locale, 'title.lettersList') + ' — ' + t(locale, 'site.title'), lettersUnavailableView(locale), locale, { authenticated: true }));
    }

    // The path param selects among the session's own donor items — never widens them.
    const donorItemId = c.req.param('donorItemId');
    const yearParam = c.req.param('year');
    const year = /^\d{4}$/.test(yearParam) ? Number(yearParam) : null;
    if (!donorItemIds.includes(donorItemId) || year === null) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.letterNotFound', locale), locale, { authenticated: true }), 404);
    }

    let data;
    try {
      data = await loadLetterData(donorItemId, year, deps.monday, deps.config.taxLetter, deps.now());
    } catch (err) {
      // Same reasoning as the letters-list route above: a Monday read failure isn't an auth
      // problem, so it shouldn't fall through to the global onError's login-focused copy.
      console.error(`member-portal letter load failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.letterLoadFailed', locale), locale, { authenticated: true }), 500);
    }
    if (data === null) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.letterNotFound', locale), locale, { authenticated: true }), 404);
    }

    const generatedOn = deps.now().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
    // Browsers print the document <title> (and URL) in default print headers/footers, and this
    // page is meant to be printed/saved as a PDF — so the title needs to identify the letter on
    // its own, not just say "SVBC Member Portal".
    const letterTitle = `SVBC ${data.year} Tax Letter — ${data.donorName}`;
    return c.html(page(letterTitle, letterView(data, deps.config.taxLetter, generatedOn, locale), locale, { authenticated: true }));
  });

  // Back-compat: same reasoning as the bare /portal redirect above.
  app.get('/portal/events', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/events`));

  app.get('/:locale/portal/events', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/');

    c.header('Cache-Control', NO_STORE);
    if (!eventsEnabled(deps.config)) {
      return c.html(page(t(locale, 'title.events') + ' — ' + t(locale, 'site.title'), eventsUnavailableView(locale), locale, { authenticated: true }));
    }

    let listings;
    try {
      listings = await loadEventRegistrations(donorItemIds, deps.monday, deps.config.eventRegistrations, deps.now());
    } catch (err) {
      // Same reasoning as the letters routes above: a Monday read failure isn't an auth
      // problem, so it shouldn't fall through to the global onError's login-focused copy.
      console.error(`member-portal events list failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.eventsLoadFailed', locale), locale, { authenticated: true }), 500);
    }
    return c.html(page(t(locale, 'title.events') + ' — ' + t(locale, 'site.title'), eventsListView(listings, locale), locale, { authenticated: true }));
  });

  // Back-compat: same reasoning as the bare /portal redirect above.
  app.get('/portal/change-request', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/change-request`));

  app.get('/:locale/portal/change-request', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/');

    c.header('Cache-Control', NO_STORE);
    if (!changeRequestsEnabled(deps.config)) {
      return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), changeRequestsUnavailableView(locale), locale, { authenticated: true }));
    }
    // Per donor (issue #31): one household record's failed read drops that donor from the form
    // instead of failing the page; only when none load is it an error — and then this route's
    // own copy, not the global onError's login-flavored one.
    const results = await Promise.allSettled(donorItemIds.map((id) => deps.monday.getDonorContactInfo(id)));
    const donors = results.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [result.value];
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(`member-portal change-request form load failed for donor "${donorItemIds[index]}": ${reason}`);
      return [];
    });
    if (donors.length === 0) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.changeRequestLoadFailed', locale), locale, { authenticated: true }), 500);
    }
    return c.html(
      page(
        t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'),
        changeRequestFormView(donors, locale, configuredPrefFields(deps.config), results.length - donors.length),
        locale,
        { authenticated: true }
      )
    );
  });

  app.post('/:locale/portal/change-request', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/');

    c.header('Cache-Control', NO_STORE);
    if (!changeRequestsEnabled(deps.config)) {
      return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), changeRequestsUnavailableView(locale), locale, { authenticated: true }));
    }
    // Before the rate limiters and the dedupe lookup: no change_requests row, no message.
    const { mode } = await deps.writeGate();
    if (mode !== 'on') return unavailable(c, locale, true);

    // Same limiter binding as login, but a distinct key prefix so the two budgets don't
    // interfere. No enumeration concern here (the caller is already authenticated), so a plain
    // 429 is fine.
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const ipResult = await deps.ipLimiter.limit(`change:${ip}`);
    if (!ipResult.success) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.rateLimited', locale), locale, { authenticated: true }), 429);
    }

    // Spec also requires a per-session budget: an IP-only limit lets many donors sharing one
    // office/NAT IP throttle each other, and doesn't cap a single scripted/compromised session
    // hammering the endpoint from a rotating IP. The cookie was already validated by
    // getSessionDonorIds above, so it's guaranteed present here.
    const sessionToken = getCookie(c, SESSION_COOKIE) as string;
    const sessionResult = await deps.ipLimiter.limit(`change:s:${await sha256Hex(sessionToken)}`);
    if (!sessionResult.success) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.rateLimited', locale), locale, { authenticated: true }), 429);
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
      queue: stampedQueue(deps.changeQueue, mode),
      dedupeWindowHours: deps.config.changeRequests.dedupeWindowHours,
      now: deps.now,
    });
    return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), changeRequestResultView(result, locale), locale, { authenticated: true }));
  });

  app.post('/:locale/portal/change-request/preferences', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/');

    c.header('Cache-Control', NO_STORE);
    if (!changeRequestsEnabled(deps.config)) {
      return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), changeRequestsUnavailableView(locale), locale, { authenticated: true }));
    }
    const { mode } = await deps.writeGate();
    if (mode !== 'on') return unavailable(c, locale, true);

    // Same limiter keys as the free-text change-request POST above — the two forms share one
    // abuse budget since they feed the same staff queue.
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const ipResult = await deps.ipLimiter.limit(`change:${ip}`);
    if (!ipResult.success) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.rateLimited', locale), locale, { authenticated: true }), 429);
    }
    const sessionToken = getCookie(c, SESSION_COOKIE) as string;
    const sessionResult = await deps.ipLimiter.limit(`change:s:${await sha256Hex(sessionToken)}`);
    if (!sessionResult.success) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.rateLimited', locale), locale, { authenticated: true }), 429);
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
      queue: stampedQueue(deps.changeQueue, mode),
      dedupeWindowHours: deps.config.changeRequests.dedupeWindowHours,
      now: deps.now,
    });
    return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), preferencesResultView(result, locale), locale, { authenticated: true }));
  });

  // Back-compat: same reasoning as the bare /portal redirect above.
  app.get('/portal/pledges', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/pledges`));

  app.get('/:locale/portal/pledges', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/');

    c.header('Cache-Control', NO_STORE);
    if (!pledgesEnabled(deps.config)) {
      return c.html(page(t(locale, 'title.pledges') + ' — ' + t(locale, 'site.title'), pledgesUnavailableView(locale), locale, { authenticated: true }));
    }

    let sections;
    try {
      sections = await loadPledgeData(donorItemIds, deps.monday);
    } catch (err) {
      // Same reasoning as the letters routes: a Monday read failure isn't an auth problem, so
      // it shouldn't fall through to the global onError's login-focused copy.
      console.error(`member-portal pledges load failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.pledgesLoadFailed', locale), locale, { authenticated: true }), 500);
    }
    return c.html(page(t(locale, 'title.pledges') + ' — ' + t(locale, 'site.title'), pledgesView(sections, locale), locale, { authenticated: true }));
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
    if (donorItemIds === null) return c.redirect('/');

    c.header('Cache-Control', NO_STORE);
    // Replaces the app-wide baseline CSP (securityHeaders.ts) on the only page that may run
    // third-party JS, so it repeats the baseline's frame-ancestors/base-uri. The load-bearing part
    // is connect-src excluding 'self': the DTD script executes on the authenticated portal
    // origin, and without this a compromised ddplugin.js could fetch sibling /portal pages
    // (the session cookie rides along on same-origin requests — httpOnly protects the cookie
    // value, not cookie-bearing requests) and exfiltrate donor data. Verify the widget still
    // works under this policy on the sandbox deploy (matchingGiftViews.ts header comment).
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://doublethedonation.com; " +
        "style-src 'self' https://doublethedonation.com; img-src 'self' https://doublethedonation.com data:; " +
        "connect-src https://doublethedonation.com; frame-ancestors 'none'; base-uri 'none'"
    );
    const ein = signedOffEin(deps.config);
    const publicApiKey = matchingGiftsSearchEnabled(deps.config) ? deps.config.matchingGifts.doubleTheDonationPublicKey : null;
    return c.html(
      page(t(locale, 'title.matchingGifts') + ' — ' + t(locale, 'site.title'), matchingGiftsView({ publicApiKey, ein }, locale), locale, {
        authenticated: true,
      })
    );
  });

  // The membership card used to be its own page — it's now a dashboard widget (see GET
  // /:locale/portal above), so both the bare and locale-prefixed forms just redirect a stale
  // link/bookmark to the dashboard instead of 404ing, matching this route table's existing
  // back-compat convention (see the bare /portal redirect above).
  app.get('/portal/card/:donorItemId', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal`));
  app.get('/:locale/portal/card/:donorItemId', (c) => c.redirect(`/${resolvePathLocale(c)}/portal`));

  // No bare-POST redirect for /regenerate — same reasoning as the change-request POST above: the
  // form action is always rendered locale-prefixed already, so there is no unprefixed submitter.
  app.post('/:locale/portal/card/:donorItemId/regenerate', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/');

    // No dedicated "unavailable" page to render for this anymore (the card is a dashboard
    // widget, not a page) — the widget and its regenerate button only ever render when
    // cardEnabled() is already true, so a POST arriving with it false is a stale form/replay.
    // Just send them back to the dashboard rather than a full error page.
    if (!cardEnabled(deps.config)) {
      return c.redirect(`/${locale}/portal`);
    }

    const donorItemId = c.req.param('donorItemId');
    if (!donorItemIds.includes(donorItemId)) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.cardNotFound', locale), locale, { authenticated: true }), 404);
    }
    // The card the dashboard already shows stays valid; only a new one waits for the switch.
    if ((await deps.writeGate()).mode !== 'on') return unavailable(c, locale, true);

    const now = deps.now().toISOString();
    try {
      await deps.cardTokenStore.revokeAllForDonor(donorItemId, now);
    } catch (err) {
      console.error(`member-portal card token revoke failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.cardRegenerateFailed', locale), locale, { authenticated: true }), 500);
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
      console.error(`member-portal card token regenerate failed, re-reading active token: ${err instanceof Error ? err.message : String(err)}`);
      let token: string | null;
      try {
        token = await deps.cardTokenStore.getActiveToken(donorItemId);
      } catch {
        token = null;
      }
      if (token === null) {
        return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.cardRegenerateFailed', locale), locale, { authenticated: true }), 500);
      }
    }

    // Back to the dashboard, not a per-card page — the card widget there picks up the freshly
    // regenerated token on next render (getOrCreateCardToken reads whatever is currently active).
    return c.redirect(`/${locale}/portal`);
  });

  // /verify/:token stays unprefixed and public: its viewer is a shop clerk scanning a donor's QR
  // code or opening the link, not the donor, so it uses the same cookie/Accept-Language
  // detection as the pre-identity pages (detectLocale), never a locale path segment and never
  // the donor's Monday-stored preference.
  app.get('/verify/:token', async (c) => {
    const locale = detectLocale(c);
    c.header('Cache-Control', NO_STORE);
    // Public, and shows a member's name and status to anyone holding the link, so keep a leaked
    // token URL out of search indexes. Set first so every response below carries it.
    c.header('X-Robots-Tag', 'noindex');

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
      console.error(`member-portal verify lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.verifyLoadFailed', locale), locale), 500);
    }
    if (donorItemId === null) {
      return c.html(page(t(locale, 'title.verify') + ' — ' + t(locale, 'site.title'), verifyNotValidView(locale), locale));
    }

    let donor;
    try {
      // The card needs name, tier, status and expiry only, so skip the Donations-board read.
      donor = await deps.monday.getMemberPortalData(donorItemId, { includeDonations: false });
    } catch (err) {
      console.error(`member-portal verify load failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.verifyLoadFailed', locale), locale), 500);
    }

    return c.html(page(t(locale, 'title.verify') + ' — ' + t(locale, 'site.title'), verifyView(buildCardData(donor), locale), locale));
  });

  app.post('/logout', async (c) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (sessionToken) {
      await deps.sessionStore.deleteSession(await sha256Hex(sessionToken));
    }
    // Secure is required: browsers ignore a __Host- Set-Cookie without it, even to expire it.
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return c.redirect('/');
  });

  // Monday doesn't sign webhook payloads (no HMAC header to verify) — the standard mitigation
  // used elsewhere in this repo (donation-rollups) is a shared secret, checked here in constant
  // time. The caller is a Monday board automation ("When button clicked → send a webhook"),
  // whose only setting is the target URL — it can't add a header — so its deliveries carry the
  // secret as `?secret=`. That puts the secret in the logged request URL (Workers
  // observability); see README v2.1 for the tradeoff. Any caller that *can* set a header (a hand
  // replay, future tooling) should send X-Webhook-Secret instead; when present it's the only
  // value checked.
  app.post('/webhooks/monday/letters', async (c) => {
    const presented = c.req.header(WEBHOOK_SECRET_HEADER) ?? c.req.query('secret');
    if (!(await secretsMatch(presented, deps.letterWebhookSecret))) {
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
      console.error(`member-portal webhook: rejected letter-send delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }

    // `off`: no letter_sends row — a 'queued' row that is never sent would block this donor's
    // letter for good (the cron skips any donor with a row). `hold`: as normal; the queue is
    // paused and sends once the switch is on. `unknown` (KV error): 503, so Monday retries.
    const gate = await deps.writeGate();
    if (gate.mode === 'unknown') {
      console.error(`member-portal webhook: write switch unreadable; letter-send for donor "${event.donorItemId}" refused (503)`);
      return c.json({ ok: false }, 503);
    }
    if (gate.mode === 'off') {
      logSkip({ ...gate, deliveryId: `letter-webhook:${event.donorItemId}` }, 'LetterQueue', 'triggerLetterSend', [{ donorItemId: event.donorItemId }]);
      return c.json({ ok: true, result: 'dropped' }, 200);
    }

    let result;
    try {
      result = await triggerLetterSend(event.donorItemId, {
        monday: deps.monday,
        taxLetter: deps.config.taxLetter,
        store: deps.letterSendStore,
        queue: stampedQueue(deps.letterQueue, gate.mode),
        now: deps.now,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`member-portal webhook: letter-send trigger failed for donor "${event.donorItemId}": ${errMsg}`);
      return c.json({ ok: false }, 500);
    }

    if (result.kind !== 'queued') {
      console.log(`member-portal webhook: letter-send for donor "${event.donorItemId}" resulted in "${result.kind}"`);
    }
    return c.json({ ok: true, result: result.kind }, 200);
  });

  return app;
}
