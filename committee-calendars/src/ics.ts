import { createEvents, type EventAttributes, type DateArray } from 'ics';
import type { NormalizedEvent } from './types';

function toDateArray(isoUtc: string): DateArray {
  const date = new Date(isoUtc);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()];
}

export function buildMergedCalendar(events: NormalizedEvent[]): string {
  const attributes: EventAttributes[] = events.map((event) => {
    // `EventAttributes` types `end`/`duration` as a required discriminated union
    // (`{ end: DateTime } | { duration: DurationObject }`), but the ics package's runtime
    // validator (node_modules/ics/dist/schema/index.js) explicitly allows neither being
    // present -- only having *both* is rejected. `Partial<EventAttributes>` doesn't
    // distribute cleanly over that union (TS then rejects assigning `end` at all), so build
    // as a loosely-typed record and assert the final shape, letting us omit both `end` and
    // `duration` when there's no endUtc, per this task's requirement not to fabricate a
    // duration.
    const attrs: Record<string, unknown> = {
      uid: `${event.sourceId}:${event.externalId}@committee-calendars.bikesiliconvalley.org`,
      title: event.title,
      start: toDateArray(event.startUtc),
      startInputType: 'utc',
      startOutputType: 'utc',
      calName: 'SVBC Committee Calendars',
    };
    if (event.endUtc) {
      attrs.end = toDateArray(event.endUtc);
      attrs.endInputType = 'utc';
      attrs.endOutputType = 'utc';
    }
    if (event.location) {
      attrs.location = event.location;
    }
    if (event.url) {
      attrs.url = event.url;
    }
    return attrs as unknown as EventAttributes;
  });

  const { error, value } = createEvents(attributes);
  if (error) {
    throw error;
  }
  return value ?? '';
}
