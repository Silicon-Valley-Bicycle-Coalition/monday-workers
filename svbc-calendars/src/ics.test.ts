import { describe, it, expect } from 'vitest';
import { buildCalendar } from './ics';
import type { NormalizedEvent } from './types';

const EVENT: NormalizedEvent = {
  sourceId: 'santa-clara',
  externalId: '123',
  title: 'Bicycle & Pedestrian Advisory Committee',
  committeeName: 'Bicycle & Pedestrian Advisory Committee',
  startUtc: '2026-11-04T03:00:00.000Z',
  endUtc: null,
  location: '1500 Warburton Ave, Santa Clara, CA',
  url: 'https://santaclara.legistar.com/MeetingDetail.aspx?ID=1',
};

describe('buildCalendar', () => {
  it('produces a VCALENDAR with the given calName and one VEVENT per event', () => {
    const ics = buildCalendar([EVENT], 'Santa Clara BPAC');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('X-WR-CALNAME:Santa Clara BPAC');
    expect(ics).toContain('UID:santa-clara:123@calendars.bikesiliconvalley.org');
    expect(ics).toContain('SUMMARY:Bicycle & Pedestrian Advisory Committee');
    expect(ics).toContain('LOCATION:1500 Warburton Ave\\, Santa Clara\\, CA');
  });

  it('produces a valid empty calendar when there are no events', () => {
    const ics = buildCalendar([], 'Empty Feed');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});
