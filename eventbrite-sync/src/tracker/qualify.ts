import { toISODate } from '../util/isoDate';
import type { TrackerEvent, TrackerRow, Verdict } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
// How long after its Date a row's totals can still move. Past it, the quarter may be reported.
const FREEZE_DAYS = 30;

// The reasons a person has to fix, so the job warns about them.
export const DATE_MISMATCH = 'date does not match the event';
export const MANY_EVENTS = 'more than one event linked';

const no = (reason: string): Verdict => ({ kind: 'no', reason });

/**
 * Whether a tracker row may carry its linked event's numbers. The row must link to one Eventbrite
 * event whose days include the row's own date, so a wrong link leaves the row blank rather than
 * showing another class's numbers.
 */
export function qualify(
  row: TrackerRow,
  events: Map<string, TrackerEvent>,
  startDate: string,
  cfg: { skipStatusLabels: string[]; volunteerPrograms: string[] }
): Verdict {
  if (cfg.skipStatusLabels.includes(row.status)) return no('skipped status');
  if (row.date === '' || row.date < startDate) return no('no date, or before the start date');
  if (row.eventItemIds.length !== 1) return no(row.eventItemIds.length === 0 ? 'no event linked' : MANY_EVENTS);

  const event = events.get(row.eventItemIds[0]!);
  if (event === undefined) return { kind: 'unknown' };
  if (!event.active) return no('event archived or deleted');
  if (event.eventbriteId === '') return no('not an Eventbrite event');
  // Their sign-ups are on the Volunteers board, so there are no registrations to count.
  if (cfg.volunteerPrograms.includes(event.program)) return no('volunteer event');
  const lastDay = event.end === '' ? event.date : event.end;
  if (event.date === '' || row.date < event.date || row.date > lastDay) return no(DATE_MISMATCH);
  return { kind: 'ok', event };
}

export function isFrozen(date: string, now: Date): boolean {
  const today = toISODate(now.getTime());
  if (date === '' || today === null) return false;
  return (Date.parse(today) - Date.parse(date)) / DAY_MS > FREEZE_DAYS;
}
