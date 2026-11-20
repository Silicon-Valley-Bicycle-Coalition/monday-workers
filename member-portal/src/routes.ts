import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { SessionInfo, SessionStore } from './db/sessions';
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
import { verifyCode } from './auth/verifyCode';
import type { CodeFailureStore } from './db/codeFailures';
import type { VerifiedEmailStore } from './db/verifiedEmails';
import { CONFIRM_LOGIN_SCRIPT, ORG_DONATE_URL, checkEmailView, confirmLoginView, errorView, loginFormView, page, unavailableView } from './views';
import { loadHomeData } from './home/loadHomeData';
import { homeView } from './home/homeView';
import { cardDoorView, loadCardDoor } from './doors/card';
import { givingDoorView, loadGivingDoor } from './doors/giving';
import { activityDoorView, loadActivityDoor } from './doors/activity';
import { infoDoorView, loadInfoDoor } from './doors/info';
import { signInEmailHash } from './doors/emailLabels';
import { findTestPersonasByEmail } from './testAccounts/personas';
import { isTestOrgWorkEmail } from './testAccounts/testOrgs';
import { discardingChangeQueue, discardingChangeStore, isTestSession } from './testAccounts/testAccountClient';
import { sha256Base64, sha256Hex } from './crypto/hash';
import { secretsMatch } from './crypto/secretsMatch';
import {
  changeRequestsEnabled,
  employerAnswerEnabled,
  configuredPrefFields,
  lettersEnabled,
  cardEnabled,
  funraiseLinks,
  pledgesEnabled,
  matchingGiftsSearchEnabled,
  signedOffEin,
  orgAccessEnabled,
  orgAcknowledgmentEnabled,
  donationHistoryEnabled,
} from './config';
import { grantFor, hasOrgAccess, resolveOrgGrants } from './orgs/grants';
import { loadOrgPage, loadOrgStatement } from './orgs/loadOrgData';
import { orgNotFoundView, orgPageView, orgStatementView } from './orgs/orgViews';
import { loadPledgeData } from './pledges/loadPledgeData';
import { pledgesView, pledgesUnavailableView } from './pledges/pledgeViews';
import { matchingGiftsSearchDocument, matchingGiftsView, SEARCH_DOCUMENT_CSP } from './matchingGifts/matchingGiftViews';
import { generateToken } from './crypto/token';
import { listLetterYears, loadLetterData } from './letters/loadLetterData';
import { letterView, lettersListView, lettersUnavailableView } from './letters/letterViews';
import { submitChangeRequest } from './changeRequests/submitChangeRequest';
import { submitPreferences } from './changeRequests/submitPreferences';
import type { PrefField } from './types';
import { changeRequestResultView, changeRequestsUnavailableView, preferencesResultView } from './changeRequests/changeRequestViews';
import { buildCardData } from './card/loadCardData';
import { verifyView, verifyNotValidView } from './card/cardViews';
import { detectLocale, LANG_COOKIE } from './i18n/detectLocale';
import { isLocale, DEFAULT_LOCALE, localeFromMondayLabel } from './i18n/locales';
import type { Locale } from './i18n/locales';
import { t } from './i18n/t';
import { decodeFavicon } from './assets/favicon';
import { IMMUTABLE_CACHE_CONTROL, staticAssetFor } from './assets/static';
import { decodeEmailLogoPng } from './assets/emailLogo';
import { DEFAULT_CSP, securityHeaders } from './securityHeaders';
import { errorText } from './logSafe';
import { logSkip } from './flags';
import { stampedQueue, type BatchSkipContext } from './writeSwitch';

export interface AppDeps {
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  sessionStore: SessionStore;
  verifiedEmailStore: VerifiedEmailStore;
  codeFailureStore: CodeFailureStore;
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
  // Sandbox test accounts (src/testAccounts/): their addresses sign in at once, without an email.
  // Set only by the sandbox and local entrypoints, never production's; `monday` must then be
  // wrapped in withTestAccounts so the session's test ids resolve.
  testAccounts?: boolean;
}

// __Host- makes the browser reject any copy that isn't Secure, Path=/ and Domain-less, so a sibling
// subdomain can't plant a session cookie scoped to a longer path (GL#103).
const SESSION_COOKIE = '__Host-session';
// Ties a typed code to the browser that asked for it: holds the request id the emailed code was
// bound to, so a code read off someone else's screen or mail is useless without it.
export const LOGIN_REQUEST_COOKIE = '__Host-login-request';
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
// grants access to (and the address it signed in with), or null if there is no valid session.
async function getSessionInfo(c: Context, deps: AppDeps): Promise<SessionInfo | null> {
  const sessionToken = getCookie(c, SESSION_COOKIE);
  if (!sessionToken) return null;
  return deps.sessionStore.getSession(await sha256Hex(sessionToken), deps.now().toISOString());
}

// The donor ids alone, for routes that don't need the address. Callers redirect to / (login) on null.
async function getSessionDonorIds(c: Context, deps: AppDeps): Promise<string[] | null> {
  return (await getSessionInfo(c, deps))?.donorItemIds ?? null;
}

// A session without people (a Work Email sign-in that grants only organizations) has no card,
// giving history, letters or info of its own: each person page sends it home, which lists its
// organizations.
const noPeople = (donorItemIds: string[]): boolean => donorItemIds.length === 0;

// Signs the browser in (link or code alike) and drops the request cookie: once either half of a
// sign-in request has been used, the row it pointed at is claimed and the cookie unlocks nothing.
function setSessionCookie(c: Context, sessionToken: string, deps: AppDeps): void {
  setCookie(c, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: deps.config.auth.sessionTtlHours * 3600,
  });
  deleteCookie(c, LOGIN_REQUEST_COOKIE, { secure: true, path: '/' });
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
// prefix exemption also matched /webhooks/portal/change-request (issue GL#32 review).
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
  // A test account's change requests are validated like anyone's, then dropped (see
  // discardingChangeStore): its dummy item ids must never reach the writer or the board.
  function changeSinks(donorItemIds: string[], mode: BatchSkipContext['mode']) {
    if (deps.testAccounts === true && isTestSession(donorItemIds)) {
      return { store: discardingChangeStore, queue: discardingChangeQueue };
    }
    return { store: deps.changeStore, queue: stampedQueue(deps.changeQueue, mode) };
  }

  // Sandbox test accounts sign in on the spot: a session for the address's personas and a
  // redirect to the portal, skipping the email, the rate limits and the write switch. Their
  // addresses are published to staff, so the enumeration guard has nothing to hide. Returns null
  // for any other address, which then takes the normal magic-link path.
  async function signInTestAccount(c: Context, locale: Locale): Promise<Response | null> {
    const body = await c.req.parseBody();
    const email = typeof body.email === 'string' ? body.email : '';
    const personas = findTestPersonasByEmail(email, deps.now());
    // The test organization's Work Email signs in to the organization alone, with no people.
    if (personas.length === 0 && !isTestOrgWorkEmail(email)) return null;
    // Grants come from the same resolver real sign-ins use, answered by withTestAccounts, so the
    // test org rep gets exactly what a real rep with Portal access ticked would.
    const matches = personas.map((p) => ({ id: p.id, name: p.name, preferredLanguage: p.preferredLanguage, matchedPersonal: !p.sharedInbox }));
    const orgGrants = await resolveOrgGrants(email.trim().toLowerCase(), matches, { monday: deps.monday, config: deps.config });
    const sessionToken = generateToken();
    const expiresAt = new Date(deps.now().getTime() + deps.config.auth.sessionTtlHours * 3_600_000).toISOString();
    await deps.sessionStore.createSession({
      sessionHash: await sha256Hex(sessionToken),
      donorItemIds: personas.map((p) => p.id),
      expiresAt,
      // The address it signed in with, so the info door shows it (the household's shared inbox
      // under each person).
      emailHash: await signInEmailHash(email),
      orgGrants,
    });
    setSessionCookie(c, sessionToken, deps);
    const lang = (personas[0] && localeFromMondayLabel(personas[0].preferredLanguage)) ?? locale;
    const next = portalReturnPath(body.next);
    return c.redirect(next !== null ? applyLocaleToPath(next, lang) : `/${lang}/portal`, 303);
  }

  const app = new Hono();

  // The one origin this deployment serves (member.bikesiliconvalley.org in production,
  // member.sandbox.bikesiliconvalley.org in the sandbox — config/split.test.ts pins each to its
  // wrangler.jsonc custom domain). Used by the CSRF check and the language-switch redirect.
  const portalOrigin = new URL(deps.config.auth.portalBaseUrl).origin;

  // First, so it wraps every response — including onError's and the 404 fallback.
  app.use('*', ...securityHeaders());

  // CSRF (issue GL#32): the session cookie is SameSite=Lax, which still rides along on a form POST
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
    console.error(`member-portal unhandled error: ${errorText(err)}`);
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.generic', locale), locale), 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // The stylesheet and logo every page links to, at content-hashed paths (GL#99; see
  // assets/static.ts). Immutable for a year: a changed file gets a new path, so a cached copy is
  // never stale. Any other /assets/ path is a 404.
  app.get('/assets/:file', (c) => {
    const asset = staticAssetFor(c.req.path);
    if (!asset) return c.notFound();
    return c.body(asset.body, 200, { 'Content-Type': asset.contentType, 'Cache-Control': IMMUTABLE_CACHE_CONTROL });
  });

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
  // appears on every route, submitting the browser's current location.pathname + location.search as `to` — rather
  // than hand-maintain an exact-match allowlist of every page shape that can now show it, this
  // accepts any same-origin target. It does so by parsing, not by prefix-matching: a blocklist
  // of string prefixes ("//", "/\") missed "/<TAB>/evil.example" (issue GL#32), because browsers
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

  // Return-to after sign-in: the `next` a signed-out donor carries from a portal page, through the
  // sign-in form and the emailed link, to the callback's redirect. Only a page in the signed-in
  // tree (/<locale>/portal...) is accepted, parsed the same way as the language switcher's `to`
  // (sameOriginRedirectPath, issue GL#32) — so it can't point off-origin, nor at /auth/callback,
  // /lang or anything else that acts on arrival. Anything else is dropped (null), and sign-in
  // lands on the home page as before.
  function portalReturnPath(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const target = sameOriginRedirectPath(raw);
    if (target === null) return null;
    const match = /^\/([^/]+)\/portal(?:\/.*)?$/.exec(target.pathname);
    if (match === null || !isLocale(match[1]!)) return null;
    return target.pathname + target.search;
  }

  // Every session-gated route's "no session" answer. A GET carries the page as `next`, unless
  // it's the home page (where sign-in lands anyway); a POST can't be replayed, so it doesn't.
  function signInRedirect(c: Context) {
    if (c.req.method !== 'GET') return c.redirect('/');
    const url = new URL(c.req.url);
    const next = portalReturnPath(url.pathname + url.search);
    if (next === null || /^\/[^/]+\/portal\/?$/.test(next)) return c.redirect('/');
    return c.redirect(`/?next=${encodeURIComponent(next)}`);
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
    return c.html(page(t(locale, 'title.login') + ' — ' + t(locale, 'site.title'), loginFormView(locale, portalReturnPath(c.req.query('next'))), locale));
  });

  app.post('/', async (c) => {
    const locale = detectLocale(c);
    if (deps.testAccounts === true) {
      const testLogin = await signInTestAccount(c, locale);
      if (testLogin !== null) return testLogin;
    }
    // Every email gets the same page, so the enumeration guard below holds under the switch too.
    if ((await deps.writeGate()).mode !== 'on') return unavailable(c, locale, false);
    const body = await c.req.parseBody();
    const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    // A malformed email (fails the plausibility check) is treated exactly like an empty one —
    // skip rate-limiting and requestLogin entirely — so this branch produces the same generic
    // response as a well-formed but non-matching email, preserving the enumeration guard.
    const email = isPlausibleEmail(rawEmail) ? rawEmail : '';
    const next = portalReturnPath(body.next);
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const requestId = generateToken();
    // Set on every answer but a rate-limit denial (per IP or per address), so whether an address
    // matched (or was even well-formed) never shows in the headers. A denied request sent no code,
    // so there's nothing for the cookie to unlock.
    let issueRequestCookie = true;

    if (email.length > 0) {
      try {
        const allowed = await checkLoginRateLimit(
          ip,
          email,
          { ipLimiter: deps.ipLimiter, attemptStore: deps.attemptStore, config: deps.config.rateLimit },
          deps.now()
        );
        if (!allowed) issueRequestCookie = false;
        if (allowed) {
          // requestLogin does a D1 write plus an email-send round-trip; awaiting it inline
          // would make the matching-email case measurably slower than the non-matching/denied
          // cases even though the response body is identical, letting an attacker distinguish
          // "matched" from "didn't match" by response latency alone. Defer it instead so the
          // response returns immediately regardless of match state.
          const work = requestLogin(email, locale, requestId, {
            monday: deps.monday,
            config: deps.config,
            tokenStore: deps.tokenStore,
            emailSender: deps.emailSender,
            portalBaseUrl: deps.config.auth.portalBaseUrl,
            magicLinkTtlMinutes: deps.config.auth.magicLinkTtlMinutes,
            now: deps.now,
          }, next).catch((err) => {
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

    if (issueRequestCookie) {
      setCookie(c, LOGIN_REQUEST_COOKIE, requestId, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: deps.config.auth.magicLinkTtlMinutes * 60,
      });
    }
    return c.html(page(t(locale, 'title.checkEmail') + ' — ' + t(locale, 'site.title'), checkEmailView(locale, next), locale));
  });

  // The typed-code half of sign-in. Like POST /auth/callback it is CSRF-checked and stays live
  // under hold (it writes a session and a verified address, not a Monday record). Every refusal is
  // the same page, so nothing says why a code failed.
  app.post('/auth/code', async (c) => {
    const body = await c.req.parseBody();
    const locale = detectLocale(c);
    const next = portalReturnPath(body.next);
    const codeError = () =>
      c.html(page(t(locale, 'title.checkEmail') + ' — ' + t(locale, 'site.title'), checkEmailView(locale, next, true), locale));

    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    try {
      if (!(await deps.ipLimiter.limit(`code:${ip}`)).success) return codeError();
    } catch (err) {
      // Fail closed, on the same page as any other refusal rather than a 500.
      console.error(`member-portal code rate limit failed: ${errorText(err)}`);
      return codeError();
    }

    const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : '';
    const requestId = getCookie(c, LOGIN_REQUEST_COOKIE);
    if (!/^\d{6}$/.test(code) || !requestId) return codeError();

    let sessionToken: string | null;
    try {
      sessionToken = await verifyCode(requestId, code, {
        tokenStore: deps.tokenStore,
        sessionStore: deps.sessionStore,
        verifiedEmailStore: deps.verifiedEmailStore,
        codeFailureStore: deps.codeFailureStore,
        codeFailuresPerAddressDaily: deps.config.rateLimit.codeFailuresPerAddressDaily,
        sessionTtlHours: deps.config.auth.sessionTtlHours,
        now: deps.now,
      });
    } catch (err) {
      console.error(`member-portal code verification failed: ${errorText(err)}`);
      return codeError();
    }
    if (sessionToken === null) return codeError();

    setSessionCookie(c, sessionToken, deps);
    return c.redirect(next ?? `/${locale}/portal`, 303);
  });

  // The emailed magic link (login and letter-ready alike) lands here — and so do the corporate
  // mail scanners (Outlook Safe Links, Mimecast, Proofpoint) that prefetch every link in an
  // inbound email, often executing its JS. Consuming the single-use token on this GET burned it
  // before the donor ever clicked (issue GL#31), so the GET is inert: it renders a button that
  // POSTs the token back to the route below, and only that POST consumes it.
  //
  // The token arrives in the URL fragment (issue GL#61: in the query string it reached Workers
  // Logs, and a letter link lives up to 168 hours), so the server never sees it here; the page's
  // script copies it into the form. A ?token= link is one sent before that change and still
  // renders as before. Drop that branch once every such link has expired: letterLinkTtlHours
  // after the GL#61 deploy.
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
    // No footer language picker here: its `to` is pathname + search, which would copy a legacy
    // link's ?token= into the /lang redirect URL (and this page's CSP blocks its inline handler
    // anyway). The page already renders in the link's own `lang`.
    return c.html(
      page(t(locale, 'title.confirmLogin') + ' — ' + t(locale, 'site.title'), confirmLoginView(legacyToken ?? null, lang, locale, portalReturnPath(c.req.query('next'))), locale, {
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
        verifiedEmailStore: deps.verifiedEmailStore,
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

    setSessionCookie(c, sessionToken, deps);
    // 303: the browser follows a POST's redirect with a GET. The link's lang wins over the
    // locale segment `next` was captured with, as it does for the home page.
    const next = portalReturnPath(body.next);
    if (next !== null) return c.redirect(lang === null ? next : applyLocaleToPath(next, lang), 303);
    return c.redirect(`/${lang ?? DEFAULT_LOCALE}/portal`, 303);
  });

  // Back-compat: anything still linking to the old unprefixed /portal (a stale bookmark, an
  // email sent before locale-prefixed routes existed) lands on the default-locale equivalent
  // instead of 404ing.
  app.get('/portal', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal`));

  // The card-first home page: status, one next step, card(s), doors. Loads only membership fields,
  // card tokens, the discount count and (Jan 1 to home.taxLetterUntil) last year's letter; each
  // door loads its own section.
  app.get('/:locale/portal', async (c) => {
    const locale = resolvePathLocale(c);
    const session = await getSessionInfo(c, deps);
    if (session === null) {
      return signInRedirect(c);
    }

    const data = await loadHomeData(session.donorItemIds, deps, locale, session.orgGrants);
    c.header('Cache-Control', NO_STORE);
    // Any gift renews a membership, so the general donate page stands in until the Funraise
    // renewal link is configured.
    const renewUrl = funraiseLinks(deps.config).renewMembershipUrl ?? ORG_DONATE_URL;
    return c.html(page(t(locale, 'title.portal') + ' — ' + t(locale, 'site.title'), homeView(data, locale, renewUrl), locale, { authenticated: true }));
  });

  // The doors (src/doors/): each loads only its own section. A person whose read fails is left out
  // with a note; with no one loaded the read throws to onError's error page, as home does.
  app.get('/:locale/portal/card', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return signInRedirect(c);
    if (noPeople(donorItemIds)) return c.redirect(`/${locale}/portal`);
    const data = await loadCardDoor(donorItemIds, deps);
    c.header('Cache-Control', NO_STORE);
    return c.html(page(t(locale, 'home.doorCard') + ' — ' + t(locale, 'site.title'), cardDoorView(data, locale), locale, { authenticated: true }));
  });

  app.get('/:locale/portal/giving', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return signInRedirect(c);
    if (noPeople(donorItemIds)) return c.redirect(`/${locale}/portal`);
    const data = await loadGivingDoor(donorItemIds, deps, locale);
    c.header('Cache-Control', NO_STORE);
    return c.html(page(t(locale, 'home.doorGiving') + ' — ' + t(locale, 'site.title'), givingDoorView(data, locale), locale, { authenticated: true }));
  });

  app.get('/:locale/portal/activity', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return signInRedirect(c);
    if (noPeople(donorItemIds)) return c.redirect(`/${locale}/portal`);
    const data = await loadActivityDoor(donorItemIds, deps);
    c.header('Cache-Control', NO_STORE);
    return c.html(page(t(locale, 'home.doorActivity') + ' — ' + t(locale, 'site.title'), activityDoorView(data, locale), locale, { authenticated: true }));
  });

  // Back-compat: same reasoning as the bare /portal redirect above.
  app.get('/portal/letters', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/letters`));
  app.get('/portal/letters/:donorItemId/:year', (c) =>
    c.redirect(`/${DEFAULT_LOCALE}/portal/letters/${c.req.param('donorItemId')}/${c.req.param('year')}`)
  );

  app.get('/:locale/portal/letters', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return signInRedirect(c);
    if (noPeople(donorItemIds)) return c.redirect(`/${locale}/portal`);

    c.header('Cache-Control', NO_STORE);
    if (!lettersEnabled(deps.config)) {
      return c.html(page(t(locale, 'home.doorLetters') + ' — ' + t(locale, 'site.title'), lettersUnavailableView(locale), locale, { authenticated: true }));
    }
    let listings;
    try {
      listings = await listLetterYears(donorItemIds, deps.monday, deps.config.taxLetter, deps.now());
    } catch (err) {
      // A Monday read failure here would otherwise fall through to the global onError, whose
      // generic "please try logging in again" copy is misleading — this isn't an auth problem.
      console.error(`member-portal letters list failed: ${errorText(err)}`);
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.lettersLoadFailed', locale), locale, { authenticated: true }), 500);
    }
    return c.html(page(t(locale, 'home.doorLetters') + ' — ' + t(locale, 'site.title'), lettersListView(listings, locale), locale, { authenticated: true }));
  });

  app.get('/:locale/portal/letters/:donorItemId/:year', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return signInRedirect(c);
    if (noPeople(donorItemIds)) return c.redirect(`/${locale}/portal`);

    c.header('Cache-Control', NO_STORE);
    if (!lettersEnabled(deps.config)) {
      return c.html(page(t(locale, 'home.doorLetters') + ' — ' + t(locale, 'site.title'), lettersUnavailableView(locale), locale, { authenticated: true }));
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
      console.error(`member-portal letter load failed: ${errorText(err)}`);
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

  // Organization pages. The order is the access guard: session, gate, the session's own grant for
  // this id, a live re-read of the granting Affiliation, and only then any organization or
  // donation read. Every refusal is the same 404 (status, body and headers), so a response never
  // says whether an id exists or why it was refused.
  async function orgAccess(c: Context, locale: Locale, orgItemId: string): Promise<'ok' | Response> {
    const session = await getSessionInfo(c, deps);
    if (session === null) return signInRedirect(c);
    c.header('Cache-Control', NO_STORE);
    const refuse = () =>
      c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), orgNotFoundView(locale), locale, { authenticated: true }), 404);
    if (!orgAccessEnabled(deps.config)) return refuse();
    const grant = grantFor(session.orgGrants, orgItemId);
    if (grant === null) return refuse();
    if (!(await hasOrgAccess(grant, session.emailHash, deps))) return refuse();
    return 'ok';
  }

  const orgNotFound = (c: Context, locale: Locale) =>
    c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), orgNotFoundView(locale), locale, { authenticated: true }), 404);

  const orgLoadFailed = (c: Context, locale: Locale, err: unknown) => {
    console.error(`member-portal organization load failed: ${errorText(err)}`);
    return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.orgLoadFailed', locale), locale, { authenticated: true }), 500);
  };

  app.get('/:locale/portal/org/:orgItemId', async (c) => {
    const locale = resolvePathLocale(c);
    const orgItemId = c.req.param('orgItemId');
    const access = await orgAccess(c, locale, orgItemId);
    if (access !== 'ok') return access;

    let data;
    try {
      data = await loadOrgPage(orgItemId, deps);
    } catch (err) {
      return orgLoadFailed(c, locale, err);
    }
    if (data === null) return orgNotFound(c, locale);
    const view = orgPageView(
      {
        ...data,
        showGiving: donationHistoryEnabled(deps.config, deps.now()),
        historyVisibleFromISO: deps.config.donations.historyVisibleFromISO,
      },
      locale
    );
    return c.html(page(data.org.name + ' — ' + t(locale, 'site.title'), view, locale, { authenticated: true }));
  });

  app.get('/:locale/portal/org/:orgItemId/statement/:year', async (c) => {
    const locale = resolvePathLocale(c);
    const orgItemId = c.req.param('orgItemId');
    const access = await orgAccess(c, locale, orgItemId);
    if (access !== 'ok') return access;

    const yearParam = c.req.param('year');
    if (!/^\d{4}$/.test(yearParam)) return orgNotFound(c, locale);
    let statement;
    try {
      statement = await loadOrgStatement(orgItemId, Number(yearParam), deps);
    } catch (err) {
      return orgLoadFailed(c, locale, err);
    }
    if (statement === null) return orgNotFound(c, locale);

    const generatedOn = deps.now().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    // Printed or saved as a PDF, so the title identifies the statement on its own.
    const title = `SVBC ${statement.year} Year-End Statement — ${statement.org.name}`;
    const view = orgStatementView(statement, deps.config.taxLetter, { ackOn: orgAcknowledgmentEnabled(deps.config), generatedOn }, locale);
    return c.html(page(title, view, locale, { authenticated: true }));
  });

  // The events page became the activity door. Signed in or not: the door handles sign-in.
  app.get('/portal/events', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/activity`));
  app.get('/:locale/portal/events', (c) => c.redirect(`/${resolvePathLocale(c)}/portal/activity`));

  // The change-request page became the info door; an old link or emailed ?field=employer keeps its query.
  app.get('/portal/change-request', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/info${new URL(c.req.url).search}`));
  app.get('/:locale/portal/change-request', (c) => c.redirect(`/${resolvePathLocale(c)}/portal/info${new URL(c.req.url).search}`));

  // Needs the session's sign-in address, not just its ids: which email addresses show depends on
  // it (src/doors/emailLabels.ts).
  app.get('/:locale/portal/info', async (c) => {
    const locale = resolvePathLocale(c);
    const session = await getSessionInfo(c, deps);
    if (session === null) return signInRedirect(c);
    if (noPeople(session.donorItemIds)) return c.redirect(`/${locale}/portal`);

    c.header('Cache-Control', NO_STORE);
    const employerField = !employerAnswerEnabled(deps.config) ? 'off' : c.req.query('field') === 'employer' ? 'preselected' : 'on';
    const data = await loadInfoDoor(session, deps, employerField);
    if (data === null) {
      // No one's record loaded: this route's own copy, not the global onError's login-flavored one.
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.changeRequestLoadFailed', locale), locale, { authenticated: true }), 500);
    }
    return c.html(page(t(locale, 'home.doorInfo') + ' — ' + t(locale, 'site.title'), infoDoorView(data, locale), locale, { authenticated: true }));
  });

  app.post('/:locale/portal/change-request', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return signInRedirect(c);

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
      ...changeSinks(donorItemIds, mode),
      dedupeWindowHours: deps.config.changeRequests.dedupeWindowHours,
      now: deps.now,
      employerEnabled: employerAnswerEnabled(deps.config),
    });
    return c.html(page(t(locale, 'title.changeRequest') + ' — ' + t(locale, 'site.title'), changeRequestResultView(result, locale), locale, { authenticated: true }));
  });

  app.post('/:locale/portal/change-request/preferences', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return signInRedirect(c);

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
      ...changeSinks(donorItemIds, mode),
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
    if (donorItemIds === null) return signInRedirect(c);
    if (noPeople(donorItemIds)) return c.redirect(`/${locale}/portal`);

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
      console.error(`member-portal pledges load failed: ${errorText(err)}`);
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
    if (donorItemIds === null) return signInRedirect(c);
    if (noPeople(donorItemIds)) return c.redirect(`/${locale}/portal`);

    c.header('Cache-Control', NO_STORE);
    // This page keeps the app-wide baseline CSP: it runs no third-party JS itself. The DTD widget
    // runs only inside the sandboxed /search document framed below (issue GL#102).
    const ein = signedOffEin(deps.config);
    const publicApiKey = matchingGiftsSearchEnabled(deps.config) ? deps.config.matchingGifts.doubleTheDonationPublicKey : null;
    const employerFormUrl = employerAnswerEnabled(deps.config) ? `/${locale}/portal/info?field=employer` : null;
    return c.html(
      page(t(locale, 'title.matchingGifts') + ' — ' + t(locale, 'site.title'), matchingGiftsView({ publicApiKey, ein, employerFormUrl }, locale), locale, {
        authenticated: true,
      })
    );
  });

  // The Double the Donation employer search, framed by the page above. Its CSP `sandbox`
  // directive (no allow-same-origin) gives it an opaque origin, so DTD's script never runs with
  // the portal's origin — see matchingGiftViews.ts. Session-gated like every /portal page so the
  // widget stays a donor-only feature; the session is read server-side, never by the document.
  app.get('/:locale/portal/matching-gifts/search', async (c) => {
    const locale = resolvePathLocale(c);
    if (!matchingGiftsSearchEnabled(deps.config)) return c.notFound();
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.notFound();

    c.header('Cache-Control', NO_STORE);
    c.header('Content-Security-Policy', SEARCH_DOCUMENT_CSP);
    c.header('X-Frame-Options', 'SAMEORIGIN');
    return c.html(matchingGiftsSearchDocument(deps.config.matchingGifts.doubleTheDonationPublicKey as string, locale));
  });

  // The old per-card page: a stale link or bookmark lands on the card door, which shows every card
  // the session covers, instead of 404ing.
  app.get('/portal/card/:donorItemId', (c) => c.redirect(`/${DEFAULT_LOCALE}/portal/card`));
  app.get('/:locale/portal/card/:donorItemId', (c) => c.redirect(`/${resolvePathLocale(c)}/portal/card`));

  // No bare-POST redirect for /regenerate — same reasoning as the change-request POST above: the
  // form action is always rendered locale-prefixed already, so there is no unprefixed submitter.
  app.post('/:locale/portal/card/:donorItemId/regenerate', async (c) => {
    const locale = resolvePathLocale(c);
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return signInRedirect(c);
    if (noPeople(donorItemIds)) return c.redirect(`/${locale}/portal`);

    // The regenerate button only renders while cardEnabled() is true, so a POST arriving with it
    // false is a stale form or a replay: back to the card door rather than a full error page.
    if (!cardEnabled(deps.config)) {
      return c.redirect(`/${locale}/portal/card`);
    }

    const donorItemId = c.req.param('donorItemId');
    if (!donorItemIds.includes(donorItemId)) {
      return c.html(page(t(locale, 'title.error') + ' — ' + t(locale, 'site.title'), errorView('error.cardNotFound', locale), locale, { authenticated: true }), 404);
    }
    // The card already shown stays valid; only a new one waits for the switch.
    if ((await deps.writeGate()).mode !== 'on') return unavailable(c, locale, true);

    const now = deps.now().toISOString();
    try {
      await deps.cardTokenStore.revokeAllForDonor(donorItemId, now);
    } catch (err) {
      console.error(`member-portal card token revoke failed: ${errorText(err)}`);
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
      console.error(`member-portal card token regenerate failed, re-reading active token: ${errorText(err)}`);
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

    // Back to the card door, which picks up the freshly regenerated token on render
    // (getOrCreateCardToken reads whatever is currently active).
    return c.redirect(`/${locale}/portal/card`);
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
      console.error(`member-portal verify lookup failed: ${errorText(err)}`);
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
      console.error(`member-portal verify load failed: ${errorText(err)}`);
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
      const errMsg = errorText(err);
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
      const errMsg = errorText(err);
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
