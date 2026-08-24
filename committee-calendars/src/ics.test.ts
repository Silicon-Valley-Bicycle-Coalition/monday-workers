import { describe, it, expect } from 'vitest';
import { buildMergedCalendar } from './ics';
import type { NormalizedEvent } from './types';

describe('buildMergedCalendar', () => {
  it('produces a valid VCALENDAR with one VEVENT per input, using UTC start/end', () => {
    const events: NormalizedEvent[] = [
      {
        sourceId: 'campbell',
        externalId: 'evt-1',
        title: 'Bicycle and Pedestrian Advisory Committee Meeting',
        committeeName: 'Bicycle & Pedestrian Advisory Committee',
        startUtc: '2026-11-20T01:00:00.000Z',
        endUtc: '2026-11-20T02:00:00.000Z',
        location: 'Council Chamber, 70 N First St, Campbell, CA 95008',
        url: 'https://www.campbellca.gov/calendar.aspx?EID=1234',
      },
    ];

    const ics = buildMergedCalendar(events);

    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:campbell:evt-1@committee-calendars.bikesiliconvalley.org');
    expect(ics).toContain('DTSTART:20261120T010000Z');
    expect(ics).toContain('DTEND:20261120T020000Z');
    expect(ics).toContain('SUMMARY:Bicycle and Pedestrian Advisory Committee Meeting');
    expect(ics).toContain('URL:https://www.campbellca.gov/calendar.aspx?EID=1234');
    expect(ics).toContain('LOCATION:Council Chamber\\, 70 N First St\\, Campbell\\, CA 95008');
  });

  it('omits DTEND when endUtc is null, rather than fabricating a duration', () => {
    const events: NormalizedEvent[] = [
      {
        sourceId: 'cupertino',
        externalId: '5259',
        title: 'Bicycle Pedestrian Commission',
        committeeName: 'Bicycle Pedestrian Commission',
        startUtc: '2026-01-30T03:00:00.000Z',
        endUtc: null,
        location: null,
        url: null,
      },
    ];

    const ics = buildMergedCalendar(events);
    expect(ics).toContain('DTSTART:20260130T030000Z');
    expect(ics).not.toContain('DTEND:');
  });

  it('produces an empty-but-valid calendar for zero events', () => {
    const ics = buildMergedCalendar([]);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});
