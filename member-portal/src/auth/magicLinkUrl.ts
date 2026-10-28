import type { Locale } from '../i18n/locales';

// The emailed login link (login and letter-ready alike). The token rides in the fragment, which
// browsers never send, so it stays out of request URLs and so out of Workers Logs (issue #61);
// GET /auth/callback's page copies it into the confirm form with a small inline script.
export function magicLinkUrl(portalBaseUrl: string, rawToken: string, locale: Locale): string {
  return `${portalBaseUrl}/auth/callback?lang=${locale}#token=${rawToken}`;
}
