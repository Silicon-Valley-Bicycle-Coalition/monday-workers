import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchCivicPlusEvents } from './civicplus';
import type { CivicPlusSourceConfig } from '../types';

// Shaped like the real feed at https://www.campbellca.gov/common/modules/iCalendar/iCalendar.aspx?catID=32&feed=calendar
const CAMPBELL_FIXTURE = `BEGIN:VCALENDAR
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

const SOURCE: CivicPlusSourceConfig = {
  id: 'campbell',
  name: 'Campbell',
  committeeName: 'Bicycle & Pedestrian Advisory Committee',
  adapter: 'civicplus',
  domain: 'www.campbellca.gov',
  catId: 32,
};

describe('fetchCivicPlusEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the iCalendar.aspx feed and normalizes into NormalizedEvent', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('https://www.campbellca.gov/common/modules/iCalendar/iCalendar.aspx?catID=32&feed=calendar');
      return new Response(CAMPBELL_FIXTURE, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchCivicPlusEvents(SOURCE);

    expect(events).toEqual([
      {
        sourceId: 'campbell',
        externalId: 'campbell-bpac-2026-11-19@campbellca.gov',
        title: 'Bicycle and Pedestrian Advisory Committee Meeting',
        committeeName: 'Bicycle & Pedestrian Advisory Committee',
        startUtc: '2026-11-20T01:00:00.000Z',
        endUtc: '2026-11-20T02:00:00.000Z',
        location: 'Council Chamber, 70 N First St, Campbell, CA 95008',
        url: 'https://www.campbellca.gov/calendar.aspx?EID=1234',
      },
    ]);
  });

  it('throws with a descriptive message on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404, statusText: 'Not Found' }))
    );

    await expect(fetchCivicPlusEvents(SOURCE)).rejects.toThrow(
      'civicplus: www.campbellca.gov catID=32 fetch failed: 404 Not Found'
    );
  });
});
