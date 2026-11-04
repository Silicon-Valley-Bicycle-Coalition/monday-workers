// The class details a class email can use as placeholders, from what the feed already keeps from
// Eventbrite: the start and end times and the online flag in D1, the venue on the Events item. Pure.

import { pacificWeekday } from '../mapping/event';
import type { EventRow } from '../types';

// Keyed by the placeholder's name in the draft, so the send page needs no mapping of its own.
export type ClassFields = Record<
  | 'Class Day'
  | 'Class Date'
  | 'Start Time'
  | 'End Time'
  | 'Arrival Time'
  | 'Spanish Day'
  | 'Spanish Date'
  | 'Spanish Time'
  | 'Spanish Arrival Time'
  | 'Class Location',
  string | null
>;

// The class templates ask people to arrive 5 minutes before the start.
const ARRIVAL_LEAD_MS = 5 * 60 * 1000;

const TIME_ZONE = 'America/Los_Angeles';
const pacificDate = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'long', day: 'numeric' });
const pacificTime = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
const spanishWeekday = new Intl.DateTimeFormat('es-US', { timeZone: TIME_ZONE, weekday: 'long' });
const spanishDate = new Intl.DateTimeFormat('es-US', { timeZone: TIME_ZONE, month: 'long', day: 'numeric' });
const spanishTime = new Intl.DateTimeFormat('es-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });

function parseTime(iso: string | null): Date | null {
  const time = iso === null ? NaN : Date.parse(iso);
  return Number.isNaN(time) ? null : new Date(time);
}

// ICU puts a narrow no-break space before AM and PM, which a plain text email shouldn't carry.
function formatTime(format: Intl.DateTimeFormat, time: Date | null): string | null {
  return time && format.format(time).replace(/\s/g, ' ');
}

export function classFields(event: Pick<EventRow, 'startsAt' | 'endsAt' | 'locationKey'>, venue: string, address: string): ClassFields {
  const start = parseTime(event.startsAt);
  const arrival = start && new Date(start.getTime() - ARRIVAL_LEAD_MS);
  return {
    'Class Day': start && pacificWeekday.format(start),
    'Class Date': start && pacificDate.format(start),
    'Start Time': formatTime(pacificTime, start),
    'End Time': formatTime(pacificTime, parseTime(event.endsAt)),
    'Arrival Time': formatTime(pacificTime, arrival),
    'Spanish Day': start && spanishWeekday.format(start),
    'Spanish Date': start && spanishDate.format(start),
    'Spanish Time': formatTime(spanishTime, start),
    'Spanish Arrival Time': formatTime(spanishTime, arrival),
    'Class Location': event.locationKey === 'online'
      ? 'online'
      : [venue.trim(), address.trim()].filter((s) => s !== '').join(', ') || null,
  };
}
