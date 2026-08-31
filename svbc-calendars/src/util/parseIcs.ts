import ICAL from 'ical.js';

export interface ParsedIcsEvent {
  uid: string;
  summary: string;
  startUtc: string;
  endUtc: string | null;
  location: string | null;
  url: string | null;
}

export function parseIcsEvents(icsText: string): ParsedIcsEvent[] {
  const jcal = ICAL.parse(icsText);
  const component = new ICAL.Component(jcal);

  for (const vtimezone of component.getAllSubcomponents('vtimezone')) {
    const timezone = new ICAL.Timezone(vtimezone);
    ICAL.TimezoneService.register(timezone, timezone.tzid);
  }

  return component.getAllSubcomponents('vevent').map((vevent) => {
    const event = new ICAL.Event(vevent);
    return {
      uid: event.uid,
      summary: event.summary,
      startUtc: event.startDate.toJSDate().toISOString(),
      endUtc: event.endDate ? event.endDate.toJSDate().toISOString() : null,
      location: (vevent.getFirstPropertyValue('location') as string | null) ?? null,
      url: (vevent.getFirstPropertyValue('url') as string | null) ?? null,
    };
  });
}
