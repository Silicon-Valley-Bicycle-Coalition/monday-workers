// The class details a class email can use as placeholders, from what the feed already keeps from
// Eventbrite: the start time and the online flag in D1, the venue on the Events item. Pure.

import { pacificWeekday } from '../mapping/event';
import type { EventRow } from '../types';

// Keyed by the placeholder's name in the draft, so the send page needs no mapping of its own.
export type ClassFields = Record<'Class Day' | 'Class Date' | 'Start Time' | 'Class Location', string | null>;

const pacificDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric' });
const pacificTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });

export function classFields(event: Pick<EventRow, 'startsAt' | 'locationKey'>, venue: string, address: string): ClassFields {
  const time = event.startsAt === null ? NaN : Date.parse(event.startsAt);
  const start = Number.isNaN(time) ? null : new Date(time);
  return {
    'Class Day': start && pacificWeekday.format(start),
    'Class Date': start && pacificDate.format(start),
    // ICU puts a narrow no-break space before AM and PM.
    'Start Time': start && pacificTime.format(start).replace(/\s/g, ' '),
    'Class Location': event.locationKey === 'online'
      ? 'online'
      : [venue.trim(), address.trim()].filter((s) => s !== '').join(', ') || null,
  };
}
