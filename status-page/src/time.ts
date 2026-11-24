// Clock and relative times for the page, in SVBC's timezone ("10:41 AM", "4 hours ago").

export function clockTime(iso: string | Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

// "9:41 AM" when iso falls on now's calendar day in timezone, else "Nov 18, 9:41 AM".
export function sinceTime(iso: string, timezone: string, now: Date): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'short' }).format(d);
  const at = new Date(iso);
  if (day(at) === day(now)) return clockTime(at, timezone);
  const date = new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric' }).format(at);
  return `${date}, ${clockTime(at, timezone)}`;
}

export function relativeTime(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.round(hours / 24), 'day');
}
