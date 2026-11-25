// When a volunteer listing runs, as staff read it: "8:00 AM–12:00 PM" in Pacific time. A listing is
// often one shift of a larger event, so this is what tells two same-named listings apart.
const TIME_ZONE = 'America/Los_Angeles';
const time = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric' });

const DAY_MS = 86_400_000;

// Some runtimes put a narrow no-break space before AM/PM, which staff can't type into a search.
export const plainSpaces = (text: string): string => text.replace(/[\u202f\u00a0\u2009]/g, ' ');

/**
 * Null without a usable start. Times only up to 24 hours (a shift may pass midnight); longer shows
 * dates too. With no end, or one at or before the start, just the start.
 */
export function shiftTime(startsAt: string | null, endsAt: string | null): string | null {
  const start = startsAt === null ? Number.NaN : Date.parse(startsAt);
  if (Number.isNaN(start)) return null;
  const end = endsAt === null ? Number.NaN : Date.parse(endsAt);
  const from = time.format(start);
  if (!(end > start)) return plainSpaces(from);
  if (end - start <= DAY_MS) return plainSpaces(`${from}–${time.format(end)}`);
  return plainSpaces(`${day.format(start)}, ${from}–${day.format(end)}, ${time.format(end)}`);
}
