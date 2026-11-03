import { describe, it, expect } from 'vitest';
import { mapEvent } from './event';
import { testConfig } from '../test/testConfig';
import type { EventbriteEvent } from '../eventbrite/client';

const config = testConfig();

function event(overrides: Partial<EventbriteEvent> = {}): EventbriteEvent {
  return {
    id: '9001',
    name: { text: 'Adult Learn to Ride' },
    start: { utc: '2026-10-31T02:00:00Z', timezone: 'America/Los_Angeles' },
    end: { utc: '2026-10-31T04:00:00Z' },
    status: 'live',
    url: 'https://www.eventbrite.com/e/9001',
    organizer_id: 'org-public',
    organizer: { name: 'Silicon Valley Bicycle Coalition' },
    online_event: false,
    venue: { name: 'Mitchell Park', address: { address_1: '600 E Meadow Dr', city: 'Palo Alto', localized_address_display: '600 E Meadow Dr, Palo Alto, CA 94306' } },
    ...overrides,
  };
}

describe('mapEvent', () => {
  it('maps the Pacific class date and day of the start, and normalizes timestamps', () => {
    const m = mapEvent(event(), config);
    expect(m.itemName).toBe('Adult Learn to Ride');
    // 2026-10-31T02:00Z is the evening of Friday Oct 30 in California.
    expect(m.classDate).toBe('2026-10-30');
    expect(m.classDay).toBe('Friday');
    expect(m.startsAt).toBe('2026-10-31T02:00:00.000Z');
    expect(m.endsAt).toBe('2026-10-31T04:00:00.000Z');
  });

  it('writes the Events board columns and never the class type or follow-ups columns', () => {
    const m = mapEvent(event(), config);
    expect(m.columnValues).toEqual({
      ev_id_col: '9001',
      ev_date_col: { date: '2026-10-30' },
      ev_end_col: { date: '2026-10-30' },
      ev_venue_col: 'Mitchell Park',
      ev_address_col: '600 E Meadow Dr, Palo Alto, CA 94306',
      ev_city_col: 'Palo Alto',
      ev_program_col: 'Public',
      ev_status_col: 'Upcoming',
      ev_source_col: 'Eventbrite',
      ev_url_col: { url: 'https://www.eventbrite.com/e/9001', text: 'Eventbrite' },
    });
  });

  it('is online for online events', () => {
    const m = mapEvent(event({ online_event: true, venue: null }), config);
    expect(m.classLocation).toBe('online');
    expect(m.locationKey).toBe('online');
  });

  it('is "<venue name>, <localized address>" for a venue', () => {
    const m = mapEvent(event(), config);
    expect(m.classLocation).toBe('Mitchell Park, 600 E Meadow Dr, Palo Alto, CA 94306');
    expect(m.locationKey).toBe('mitchell park, 600 e meadow dr, palo alto, ca 94306');
  });

  it('has an empty location with no venue and not online', () => {
    expect(mapEvent(event({ venue: null }), config).classLocation).toBe('');
  });

  it.each([
    ['live', 'Upcoming'],
    ['started', 'Upcoming'],
    ['ended', 'Completed'],
    ['completed', 'Completed'],
    ['canceled', 'Canceled'],
    ['deleted', 'Canceled'],
    ['draft', 'Draft'],
    ['something-new', 'Completed'],
  ])('maps Eventbrite status %s to Event Status %s', (status, label) => {
    expect(mapEvent(event({ status }), config).columnValues.ev_status_col).toBe(label);
  });

  it('takes Program from the organizer name suffix', () => {
    const m = mapEvent(event({ organizer: { name: 'Silicon Valley Bicycle Coalition (volunteering)' } }), config);
    expect(m.program).toBe('Volunteering');
    expect(m.columnValues.ev_program_col).toBe('Volunteering');
  });

  it('defaults Program to Public with no suffix', () => {
    expect(mapEvent(event(), config).program).toBe('Public');
  });

  it('lets programByOrganizer override the organizer name', () => {
    const m = mapEvent(event({ organizer_id: 'org-volunteering' }), config);
    expect(m.program).toBe('Volunteering');
    expect(m.columnValues.ev_program_col).toBe('Volunteering');
  });

  it('honours the fall-back DST change', () => {
    const after = mapEvent(event({ start: { utc: '2026-11-01T16:00:00Z' } }), config);
    expect(after.classDate).toBe('2026-11-01');
    expect(after.classDay).toBe('Sunday');
    const before = mapEvent(event({ start: { utc: '2026-11-01T06:30:00Z' } }), config);
    expect(before.classDate).toBe('2026-10-31');
    expect(before.classDay).toBe('Saturday');
  });

  it('copes with a bare event: no dates, name, venue or url', () => {
    const m = mapEvent({ id: '1' }, config);
    expect(m.itemName).toBe('Eventbrite event 1');
    expect(m.startsAt).toBeNull();
    expect(m.endsAt).toBeNull();
    expect(m.classDate).toBeNull();
    expect(m.classDay).toBeNull();
    expect(m.columnValues).not.toHaveProperty('ev_date_col');
    expect(m.columnValues).not.toHaveProperty('ev_url_col');
  });
});
