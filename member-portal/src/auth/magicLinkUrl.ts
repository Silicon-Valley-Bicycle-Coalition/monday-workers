import type { Locale } from '../i18n/locales';

// The emailed login link (login and letter-ready alike). The token rides in the fragment, which
// browsers never send, so it stays out of request URLs and so out of Workers Logs (issue #61);
// GET /auth/callback's page copies it into the confirm form with a small inline script.
// `next` is the portal page to land on after sign-in, already validated by the caller.
export function magicLinkUrl(portalBaseUrl: string, rawToken: string, locale: Locale, next: string | null = null): string {
  const nextParam = next === null ? '' : `&next=${encodeURIComponent(next)}`;
  return `${portalBaseUrl}/auth/callback?lang=${locale}${nextParam}#token=${rawToken}`;
}
