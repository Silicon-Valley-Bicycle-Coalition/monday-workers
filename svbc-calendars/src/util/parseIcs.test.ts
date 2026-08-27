import { describe, it, expect } from 'vitest';
import { parseIcsEvents } from './parseIcs';

// Shaped like the real CivicPlus (Campbell/Saratoga) feed output: a VTIMEZONE block,
// TZID-qualified DTSTART/DTEND.
const CIVICPLUS_FIXTURE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//CivicPlus//iCalendar//EN
BEGIN:VTIMEZONE
TZID:America/Los_Angeles
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
TZNAME:PDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
TZNAME:PST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:campbell-bpac-2026-11-19@campbellca.gov
DTSTAMP:20260101T000000Z
DTSTART;TZID=America/Los_Angeles:20261119T170000
DTEND;TZID=America/Los_Angeles:20261119T180000
SUMMARY:Bicycle and Pedestrian Advisory Committee Meeting
LOCATION:Council Chamber\\, 70 N First St\\, Campbell\\, CA 95008
URL:https://www.campbellca.gov/calendar.aspx?EID=1234
END:VEVENT
END:VCALENDAR`;

// Shaped like the real caltrain.com embedded data:text/calendar output: no VTIMEZONE, DTSTART
// already UTC ('Z' suffix), no LOCATION/URL.
const CALTRAIN_FIXTURE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:Spatie calendar-links
BEGIN:VEVENT
UID:eaafd89e85503a83d5c4455522fbbe8e
SUMMARY:JPB Bicycle and Active Transportation Advisory Committee (BATAC)
DTSTAMP:20260918T004500Z
DTSTART:20260918T004500Z
DTEND:20260918T004500Z
END:VEVENT
END:VCALENDAR`;

describe('parseIcsEvents', () => {
  it('resolves a VTIMEZONE-qualified DTSTART/DTEND to the correct UTC instant', () => {
    const events = parseIcsEvents(CIVICPLUS_FIXTURE);
    expect(events).toEqual([
      {
        uid: 'campbell-bpac-2026-11-19@campbellca.gov',
        summary: 'Bicycle and Pedestrian Advisory Committee Meeting',
        startUtc: '2026-11-20T01:00:00.000Z',
        endUtc: '2026-11-20T02:00:00.000Z',
        location: 'Council Chamber, 70 N First St, Campbell, CA 95008',
        url: 'https://www.campbellca.gov/calendar.aspx?EID=1234',
      },
    ]);
  });

  it('parses a bare UTC DTSTART with no VTIMEZONE and null location/url', () => {
    const events = parseIcsEvents(CALTRAIN_FIXTURE);
    expect(events).toEqual([
      {
        uid: 'eaafd89e85503a83d5c4455522fbbe8e',
        summary: 'JPB Bicycle and Active Transportation Advisory Committee (BATAC)',
        startUtc: '2026-09-18T00:45:00.000Z',
        endUtc: '2026-09-18T00:45:00.000Z',
        location: null,
        url: null,
      },
    ]);
  });

  it('returns an empty array for a calendar with no VEVENTs', () => {
    expect(parseIcsEvents('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR')).toEqual([]);
  });
});
