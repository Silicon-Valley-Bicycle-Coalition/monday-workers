import { createEvents, type EventAttributes, type DateArray } from 'ics';
import type { NormalizedEvent } from './types';

function toDateArray(isoUtc: string): DateArray {
  const date = new Date(isoUtc);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()];
}

// `EventAttributes` types `end`/`duration` as a required discriminated union, but the `ics`
// package's runtime validator allows neither being present — only having *both* is rejected.
// `Partial<EventAttributes>` doesn't distribute cleanly over that union, so this narrows the
// escape hatch to just the `end`/`duration` fields that genuinely need it.
type EventAttributesBuilder = Omit<EventAttributes, 'end' | 'duration' | 'endInputType' | 'endOutputType'> & {
  end?: DateArray;
  endInputType?: 'utc' | 'local';
  endOutputType?: 'utc' | 'local';
};

export function buildCalendar(events: NormalizedEvent[], calName: string): string {
  const attributes: EventAttributes[] = events.map((event) => {
    const attrs: EventAttributesBuilder = {
      uid: `${event.sourceId}:${event.externalId}@calendars.bikesiliconvalley.org`,
      title: event.title,
      start: toDateArray(event.startUtc),
      startInputType: 'utc',
      startOutputType: 'utc',
      calName,
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
    if (event.description) {
      attrs.description = event.description;
    }
    return attrs as EventAttributes;
  });

  const { error, value } = createEvents(attributes, { calName });
  if (error) {
    throw error;
  }
  return value ?? '';
}
