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

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/login', (c) => c.html(loginFormView()));

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
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
          await requestLogin(email, {
            monday: deps.monday,
            tokenStore: deps.tokenStore,
            emailSender: deps.emailSender,
            portalBaseUrl: deps.config.auth.portalBaseUrl,
            magicLinkTtlMinutes: deps.config.auth.magicLinkTtlMinutes,
            now: deps.now,
          });
        }
      } catch (err) {
        // A failure here (Monday API down, Resend down, D1 error) must never surface as a
        // different response than the enumeration-safe path below — otherwise "did this email
        // exist" leaks through error-vs-success response variance. Log and fall through.
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
