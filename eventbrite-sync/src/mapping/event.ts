import type { EventbriteEvent } from '../eventbrite/client';
import type { EventbriteSyncConfig } from '../types';
import { toISODate } from '../util/isoDate';

export interface EventMapping {
  itemName: string;
  columnValues: Record<string, unknown>;
  // Normalized ISO UTC (`toISOString`), because the D1 ledger compares `ends_at` as text.
  startsAt: string | null;
  endsAt: string | null;
  // Stable, case-folded form of classLocation for grouping classes at the same place.
  locationKey: string;
  // Pacific calendar day and weekday of the start.
  classDate: string | null;
  classDay: string | null;
  classLocation: string;
  // The Program label written to columnValues, for the attendee consumer's eventFacts.
  program: string;
}

const pacificWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' });

// Matches salesforce-import/src/transform/boards.ts EVENTBRITE_EVENT_STATUS, plus `deleted` (what
// Eventbrite reports for a canceled event that was removed); anything else (including `ended`) is
// Completed.
const EVENT_STATUS: Record<string, string> = {
  live: 'Upcoming', started: 'Upcoming', completed: 'Completed', canceled: 'Canceled', deleted: 'Canceled',
  draft: 'Draft',
};

// Copied from salesforce-import/src/transform/boards.ts (`programFromOrganizer`; Workers share no
// code across packages). SVBC runs one Eventbrite organizer per program, distinguished only by a
// parenthesised suffix on the organizer name ("Silicon Valley Bicycle Coalition (volunteering)").
const ORGANIZER_PROGRAMS: Record<string, string> = {
  volunteering: 'Volunteering', 'bike parking': 'Bike Parking', 'group rides': 'Group Rides', private: 'Private',
};
function programFromOrganizer(organizer: unknown): string {
  const suffix = /\(([^)]+)\)\s*$/.exec(String(organizer ?? ''))?.[1]?.trim().toLowerCase();
  return (suffix && ORGANIZER_PROGRAMS[suffix]) || 'Public';
}

// A canceled event's status doesn't reliably say so: SVBC's read `deleted`, `draft` and `completed`
// (2026-11-03), and Eventbrite staff describe `live` too (developer forum, 2021). Its sales status
// does: all 7 canceled events had this code, and none of the 226 others. This is the status everything downstream goes by: the
// Event Status label, and through the ledger the class email routes and the ended-event sweep.
export function effectiveEventStatus(event: EventbriteEvent): string | null | undefined {
  return event.event_sales_status?.message_code === 'event_cancelled' ? 'canceled' : event.status;
}

// Salesforce's copy of `started` outlived 84 events (2026-11-02 org), though Eventbrite itself reads
// `completed` for them now; when it flips isn't documented. So Upcoming is a matter of the clock as well as the
// status. Same rule as salesforce-import's transform, to the minute rather than the day.
function eventStatusLabel(status: string | undefined | null, endsAt: string | null, startsAt: string | null, now: Date): string {
  const label = EVENT_STATUS[status ?? ''] ?? 'Completed';
  const lastMoment = endsAt ?? startsAt;
  return label === 'Upcoming' && lastMoment !== null && Date.parse(lastMoment) <= now.getTime() ? 'Completed' : label;
}

export function mapEvent(event: EventbriteEvent, config: EventbriteSyncConfig, now: Date): EventMapping {
  const cols = config.attendeeSync.events;
  const startsAt = isoOrNull(event.start?.utc);
  const endsAt = isoOrNull(event.end?.utc);
  const classDate = toISODate(startsAt);
  const classDay = startsAt === null ? null : pacificWeekday.format(new Date(startsAt));
  const endDate = toISODate(endsAt);

  const program = (event.organizer_id ? config.attendeeSync.programByOrganizer[event.organizer_id] : undefined)
    ?? programFromOrganizer(event.organizer?.name);

  const venue = event.venue;
  const classLocation = event.online_event
    ? 'online'
    : [nonEmpty(venue?.name), nonEmpty(venue?.address?.localized_address_display)].filter((s) => s !== null).join(', ');

  const columnValues: Record<string, unknown> = {
    [cols.eventbriteIdColumn]: event.id,
    [cols.programColumn]: program,
    [cols.eventStatusColumn]: eventStatusLabel(effectiveEventStatus(event), endsAt, startsAt, now),
    [cols.sourceColumn]: 'Eventbrite',
  };
  if (classDate !== null) columnValues[cols.dateColumn] = { date: classDate };
  if (endDate !== null) columnValues[cols.endColumn] = { date: endDate };
  const venueName = nonEmpty(venue?.name);
  if (venueName !== null) columnValues[cols.venueColumn] = venueName;
  const address = nonEmpty(venue?.address?.localized_address_display);
  if (address !== null) columnValues[cols.addressColumn] = address;
  const city = nonEmpty(venue?.address?.city);
  if (city !== null) columnValues[cols.cityColumn] = city;
  const url = nonEmpty(event.url);
  if (url !== null) columnValues[cols.urlColumn] = { url, text: 'Eventbrite' };
  // Only Public classes get the send link, and never before the page is deployed (pageUrl null).
  const pageUrl = config.attendeeSync.classEmails.pageUrl;
  if (pageUrl !== null && program === 'Public') {
    const sep = pageUrl.includes('?') ? '&' : '?';
    columnValues[cols.sendLinkColumn] = { url: `${pageUrl}${sep}event=${encodeURIComponent(event.id)}`, text: 'Send class email' };
  }

  return {
    itemName: nonEmpty(event.name?.text) ?? `Eventbrite event ${event.id}`,
    columnValues,
    startsAt,
    endsAt,
    locationKey: classLocation.toLowerCase(),
    classDate,
    classDay,
    classLocation,
    program,
  };
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
