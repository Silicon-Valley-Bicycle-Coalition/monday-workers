import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { SessionStore } from './db/sessions';
import type { LoginAttemptStore } from './db/loginAttempts';
import type { EmailSender } from './email/resend';
import type { IpRateLimiter } from './ratelimit';
import type { Config } from './types';
import { checkLoginRateLimit } from './ratelimit';
import { requestLogin } from './auth/requestLogin';
import { verifyLogin } from './auth/verifyLogin';
import { loadPortalData } from './portal/loadPortalData';
import { checkEmailView, errorView, loginFormView, portalView } from './views';
import { sha256Hex } from './crypto/hash';

export interface AppDeps {
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  sessionStore: SessionStore;
  attemptStore: LoginAttemptStore;
  emailSender: EmailSender;
  ipLimiter: IpRateLimiter;
  config: Config;
  now: () => Date;
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

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.onError((err, c) => {
    console.error(`donor-portal unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    return c.html(errorView('Something went wrong. Please try logging in again.'), 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/login', (c) => c.html(loginFormView()));

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

    return c.html(checkEmailView());
  });

  app.get('/auth/callback', async (c) => {
    const token = c.req.query('token');
    if (!token) {
      return c.html(errorView('This link is invalid. Please request a new one.'));
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
      return c.html(errorView('This link has expired or was already used. Please request a new one.'));
    }

    if (sessionToken === null) {
      return c.html(errorView('This link has expired or was already used. Please request a new one.'));
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
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (!sessionToken) {
      return c.redirect('/login');
    }

    const sessionHash = await sha256Hex(sessionToken);
    const donorItemIds = await deps.sessionStore.getSession(sessionHash, deps.now().toISOString());
    if (donorItemIds === null) {
      return c.redirect('/login');
    }

    const data = await loadPortalData(donorItemIds, deps.monday);
    // Donor PII (name, membership tier, full donation history) must never be servable from
    // browser cache/bfcache/history after logout on a shared machine — the server-side session
    // deletion in POST /logout doesn't evict a previously cached rendering of this page.
    c.header('Cache-Control', 'private, no-store, max-age=0');
    return c.html(portalView(data));
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
