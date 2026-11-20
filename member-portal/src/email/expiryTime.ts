import type { Locale } from '../i18n/locales';

// The clock time a login code and link stop working, in the requester's own time zone, e.g.
// "3:15 PM PST". The zone name is included so the time is unambiguous.
export function formatExpiryTime(expiresAtISO: string, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(expiresAtISO));
}
