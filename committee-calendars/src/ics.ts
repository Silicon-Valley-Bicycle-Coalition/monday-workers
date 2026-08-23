import { createEvents, type EventAttributes, type DateArray } from 'ics';
import type { NormalizedEvent } from './types';

function toDateArray(isoUtc: string): DateArray {
  const date = new Date(isoUtc);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()];
}

// `EventAttributes` types `end`/`duration` as a required discriminated union
// (`{ end: DateTime } | { duration: DurationObject }`), but the ics package's runtime
// validator (node_modules/ics/dist/schema/index.js) explicitly allows neither being present --
// only having *both* is rejected. `Partial<EventAttributes>` doesn't distribute cleanly over
// that union (TS then rejects assigning `end` at all), so this narrows the escape hatch to just
// the `end`/`duration` fields that genuinely need it, keeping compile-time checking on every
// other field (`uid`, `title`, `start`, `startInputType`, `startOutputType`, `calName`,
// `location`, `url`).
type EventAttributesBuilder = Omit<EventAttributes, 'end' | 'duration' | 'endInputType' | 'endOutputType'> & {
  end?: DateArray;
  endInputType?: 'utc' | 'local';
  endOutputType?: 'utc' | 'local';
};

export function buildMergedCalendar(events: NormalizedEvent[]): string {
  const attributes: EventAttributes[] = events.map((event) => {
    const attrs: EventAttributesBuilder = {
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
    // The omission of `end`/`duration` above (a valid runtime state per the validator, per the
    // comment on `EventAttributesBuilder`) is exactly what `EventAttributes`'s discriminated
    // union disallows at the type level, so this single, narrow assertion is still required at
    // this one well-understood boundary.
    return attrs as EventAttributes;
  });

  const { error, value } = createEvents(attributes);
  if (error) {
    throw error;
  }
  return value ?? '';
}
