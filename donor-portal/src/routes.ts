import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { SessionStore } from './db/sessions';
import type { LoginAttemptStore } from './db/loginAttempts';
import type { EmailSender } from './email/resend';
import type { IpRateLimiter } from './ratelimit';
import type { Config } from './types';
import type { ChangeRequestStore } from './db/changeRequests';
import type { ChangeQueueMessage } from './changeRequests/submitChangeRequest';
import type { CardTokenStore } from './db/cardTokens';
import { checkLoginRateLimit } from './ratelimit';
import { requestLogin } from './auth/requestLogin';
import { verifyLogin } from './auth/verifyLogin';
import { loadPortalData } from './portal/loadPortalData';
import { checkEmailView, errorView, loginFormView, page, portalView } from './views';
import { sha256Hex } from './crypto/hash';
import { changeRequestsEnabled, lettersEnabled, cardEnabled } from './config';
import { generateToken } from './crypto/token';
import { listLetterYears, loadLetterData } from './letters/loadLetterData';
import { letterView, lettersListView, lettersUnavailableView } from './letters/letterViews';
import { submitChangeRequest } from './changeRequests/submitChangeRequest';
import { changeRequestFormView, changeRequestResultView, changeRequestsUnavailableView } from './changeRequests/changeRequestViews';
import { buildCardData } from './card/loadCardData';
import { generateQrSvg } from './card/qr';
import { cardView, cardUnavailableView, verifyView, verifyNotValidView } from './card/cardViews';

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
  cardTokenStore: CardTokenStore;
}

const SESSION_COOKIE = 'session';

// Page <title>s. Kept as constants rather than inlined at each c.html(page(...)) call so the
// copy lives in one place; the tax letter title is the exception, built per-request from the
// donor's own data (see the /portal/letters/:donorItemId/:year route below).
const SITE_TITLE = 'SVBC Donor Portal';
const TITLE_LOGIN = `Log In — ${SITE_TITLE}`;
const TITLE_CHECK_EMAIL = `Check Your Email — ${SITE_TITLE}`;
const TITLE_ERROR = `Something Went Wrong — ${SITE_TITLE}`;
const TITLE_PORTAL = `Your Donor Portal — ${SITE_TITLE}`;
const TITLE_LETTERS_LIST = `Tax Documents — ${SITE_TITLE}`;
const TITLE_CHANGE_REQUEST = `Request a Change — ${SITE_TITLE}`;
const TITLE_CARD = `Your Membership Card — ${SITE_TITLE}`;
const TITLE_VERIFY = `Membership Verification — ${SITE_TITLE}`;

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

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.onError((err, c) => {
    console.error(`donor-portal unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    return c.html(page(TITLE_ERROR, errorView('Something went wrong. Please try logging in again.')), 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/login', (c) => c.html(page(TITLE_LOGIN, loginFormView())));

  app.post('/login', async (c) => {
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
          // requestLogin does a D1 write plus a full Resend HTTP round-trip; awaiting it inline
          // would make the matching-email case measurably slower than the non-matching/denied
          // cases even though the response body is identical, letting an attacker distinguish
          // "matched" from "didn't match" by response latency alone. Defer it instead so the
          // response returns immediately regardless of match state.
          const work = requestLogin(email, {
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

    return c.html(page(TITLE_CHECK_EMAIL, checkEmailView()));
  });

  app.get('/auth/callback', async (c) => {
    const token = c.req.query('token');
    if (!token) {
      return c.html(page(TITLE_ERROR, errorView('This link is invalid. Please request a new one.')));
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
      return c.html(page(TITLE_ERROR, errorView('This link has expired or was already used. Please request a new one.')));
    }

    if (sessionToken === null) {
      return c.html(page(TITLE_ERROR, errorView('This link has expired or was already used. Please request a new one.')));
    }

    setCookie(c, SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: deps.config.auth.sessionTtlHours * 3600,
    });
    return c.redirect('/portal');
  });

  app.get('/portal', async (c) => {
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) {
      return c.redirect('/login');
    }

    const data = await loadPortalData(donorItemIds, deps.monday);
    c.header('Cache-Control', NO_STORE);
    return c.html(page(TITLE_PORTAL, portalView(data)));
  });

  app.get('/portal/letters', async (c) => {
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    c.header('Cache-Control', NO_STORE);
    if (!lettersEnabled(deps.config)) {
      return c.html(page(TITLE_LETTERS_LIST, lettersUnavailableView()));
    }
    let listings;
    try {
      listings = await listLetterYears(donorItemIds, deps.monday, deps.now());
    } catch (err) {
      // A Monday read failure here would otherwise fall through to the global onError, whose
      // generic "please try logging in again" copy is misleading — this isn't an auth problem.
      console.error(`donor-portal letters list failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(TITLE_ERROR, errorView('We could not load your letters right now. Please try again in a few minutes.')), 500);
    }
    return c.html(page(TITLE_LETTERS_LIST, lettersListView(listings)));
  });

  app.get('/portal/letters/:donorItemId/:year', async (c) => {
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    c.header('Cache-Control', NO_STORE);
    if (!lettersEnabled(deps.config)) {
      return c.html(page(TITLE_LETTERS_LIST, lettersUnavailableView()));
    }

    // The path param selects among the session's own donor items — never widens them.
    const donorItemId = c.req.param('donorItemId');
    const yearParam = c.req.param('year');
    const year = /^\d{4}$/.test(yearParam) ? Number(yearParam) : null;
    if (!donorItemIds.includes(donorItemId) || year === null) {
      return c.html(page(TITLE_ERROR, errorView('That letter does not exist.')), 404);
    }

    let data;
    try {
      data = await loadLetterData(donorItemId, year, deps.monday, deps.config.taxLetter, deps.now());
    } catch (err) {
      // Same reasoning as the letters-list route above: a Monday read failure isn't an auth
      // problem, so it shouldn't fall through to the global onError's login-focused copy.
      console.error(`donor-portal letter load failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(TITLE_ERROR, errorView('We could not load your letter right now. Please try again in a few minutes.')), 500);
    }
    if (data === null) {
      return c.html(page(TITLE_ERROR, errorView('That letter does not exist.')), 404);
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
    return c.html(page(letterTitle, letterView(data, deps.config.taxLetter, generatedOn)));
  });

  app.get('/portal/change-request', async (c) => {
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    c.header('Cache-Control', NO_STORE);
    if (!changeRequestsEnabled(deps.config)) {
      return c.html(page(TITLE_CHANGE_REQUEST, changeRequestsUnavailableView()));
    }
    const donors = await Promise.all(donorItemIds.map((id) => deps.monday.getDonorContactInfo(id)));
    return c.html(page(TITLE_CHANGE_REQUEST, changeRequestFormView(donors)));
  });

  app.post('/portal/change-request', async (c) => {
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    c.header('Cache-Control', NO_STORE);
    if (!changeRequestsEnabled(deps.config)) {
      return c.html(page(TITLE_CHANGE_REQUEST, changeRequestsUnavailableView()));
    }

    // Same limiter binding as login, but a distinct key prefix so the two budgets don't
    // interfere. No enumeration concern here (the caller is already authenticated), so a plain
    // 429 is fine.
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const ipResult = await deps.ipLimiter.limit(`change:${ip}`);
    if (!ipResult.success) {
      return c.html(page(TITLE_ERROR, errorView('Too many requests — please try again in a minute.')), 429);
    }

    // Spec also requires a per-session budget: an IP-only limit lets many donors sharing one
    // office/NAT IP throttle each other, and doesn't cap a single scripted/compromised session
    // hammering the endpoint from a rotating IP. The cookie was already validated by
    // getSessionDonorIds above, so it's guaranteed present here.
    const sessionToken = getCookie(c, SESSION_COOKIE) as string;
    const sessionResult = await deps.ipLimiter.limit(`change:s:${await sha256Hex(sessionToken)}`);
    if (!sessionResult.success) {
      return c.html(page(TITLE_ERROR, errorView('Too many requests — please try again in a minute.')), 429);
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
    return c.html(page(TITLE_CHANGE_REQUEST, changeRequestResultView(result)));
  });

  app.get('/portal/card/:donorItemId', async (c) => {
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    c.header('Cache-Control', NO_STORE);
    if (!cardEnabled(deps.config)) {
      return c.html(page(TITLE_CARD, cardUnavailableView()));
    }

    const donorItemId = c.req.param('donorItemId');
    if (!donorItemIds.includes(donorItemId)) {
      return c.html(page(TITLE_ERROR, errorView('That card does not exist.')), 404);
    }

    let donor;
    try {
      donor = await deps.monday.getDonorPortalData(donorItemId);
    } catch (err) {
      console.error(`donor-portal card load failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(TITLE_ERROR, errorView('We could not load your card right now. Please try again in a few minutes.')), 500);
    }

    let token = await deps.cardTokenStore.getActiveToken(donorItemId);
    if (token === null) {
      token = generateToken();
      try {
        await deps.cardTokenStore.createToken(donorItemId, token, deps.now().toISOString());
      } catch (err) {
        // The one-active-token-per-donor DB constraint (migrations/0003) throws here if a
        // concurrent request for the same donor won the race and inserted first. Re-read rather
        // than fail the request — the other request's token is just as valid. A genuine
        // unrelated D1 outage would simply fail again on this re-read and fall through to the
        // route's normal error handling below.
        console.error(`donor-portal card token insert failed, re-reading active token: ${err instanceof Error ? err.message : String(err)}`);
        token = await deps.cardTokenStore.getActiveToken(donorItemId);
        if (token === null) {
          throw err;
        }
      }
    }

    const verifyUrl = `${deps.config.auth.portalBaseUrl}/verify/${token}`;
    const qrSvg = generateQrSvg(verifyUrl);
    return c.html(page(TITLE_CARD, cardView(buildCardData(donor), verifyUrl, qrSvg)));
  });

  app.post('/portal/card/:donorItemId/regenerate', async (c) => {
    const donorItemIds = await getSessionDonorIds(c, deps);
    if (donorItemIds === null) return c.redirect('/login');

    if (!cardEnabled(deps.config)) {
      return c.html(page(TITLE_CARD, cardUnavailableView()));
    }

    const donorItemId = c.req.param('donorItemId');
    if (!donorItemIds.includes(donorItemId)) {
      return c.html(page(TITLE_ERROR, errorView('That card does not exist.')), 404);
    }

    const now = deps.now().toISOString();
    await deps.cardTokenStore.revokeAllForDonor(donorItemId, now);
    await deps.cardTokenStore.createToken(donorItemId, generateToken(), now);

    return c.redirect(`/portal/card/${encodeURIComponent(donorItemId)}`);
  });

  app.get('/verify/:token', async (c) => {
    c.header('Cache-Control', NO_STORE);

    // If the card feature is ever disabled after tokens have already been issued (config
    // revert, incident response), every previously-issued verify link must stop serving PII —
    // this is the kill switch's only enforcement point, since token issuance/regeneration is
    // already gated. Reuse the generic "not valid" response so this carries no signal
    // distinguishing "feature off" from "token doesn't exist".
    if (!cardEnabled(deps.config)) {
      return c.html(page(TITLE_VERIFY, verifyNotValidView()));
    }

    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const ipResult = await deps.ipLimiter.limit(`verify:${ip}`);
    if (!ipResult.success) {
      return c.html(page(TITLE_VERIFY, errorView('Too many requests — please try again in a minute.')), 429);
    }

    const token = c.req.param('token');
    let donorItemId: string | null;
    try {
      donorItemId = await deps.cardTokenStore.findActiveDonorId(token);
    } catch (err) {
      console.error(`donor-portal verify lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(TITLE_ERROR, errorView('We could not verify this card right now. Please try again in a few minutes.')), 500);
    }
    if (donorItemId === null) {
      return c.html(page(TITLE_VERIFY, verifyNotValidView()));
    }

    let donor;
    try {
      donor = await deps.monday.getDonorPortalData(donorItemId);
    } catch (err) {
      console.error(`donor-portal verify load failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.html(page(TITLE_ERROR, errorView('We could not verify this card right now. Please try again in a few minutes.')), 500);
    }

    return c.html(page(TITLE_VERIFY, verifyView(buildCardData(donor))));
  });

  app.post('/logout', async (c) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (sessionToken) {
      await deps.sessionStore.deleteSession(await sha256Hex(sessionToken));
    }
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login');
  });

  return app;
}
