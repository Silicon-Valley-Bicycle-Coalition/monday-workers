import { describe, it, expect } from 'vitest';
import { effectiveEventStatus, mapEvent } from './event';
import { testConfig } from '../test/testConfig';
import type { EventbriteEvent } from '../eventbrite/client';

const config = testConfig();
// Before every fixture's event, so a date doesn't decide the status unless a test means it to.
const NOW = new Date('2026-10-01T00:00:00Z');

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
    const m = mapEvent(event(), config, NOW);
    expect(m.itemName).toBe('Adult Learn to Ride');
    // 2026-10-31T02:00Z is the evening of Friday Oct 30 in California.
    expect(m.classDate).toBe('2026-10-30');
    expect(m.classDay).toBe('Friday');
    expect(m.startsAt).toBe('2026-10-31T02:00:00.000Z');
    expect(m.endsAt).toBe('2026-10-31T04:00:00.000Z');
  });

  it('writes the Events board columns and never the class type or follow-ups columns', () => {
    const m = mapEvent(event(), config, NOW);
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

  describe('Send class email link', () => {
    const withPage = (pageUrl: string | null) => {
      const c = testConfig();
      c.attendeeSync.classEmails.pageUrl = pageUrl;
      return c;
    };

    it('writes the link for a Public event', () => {
      const m = mapEvent(event(), withPage('https://example.org/classes'), NOW);
      expect(m.columnValues['ev_send_col']).toEqual({ url: 'https://example.org/classes?event=9001', text: 'Send class email' });
    });

    it('omits it for other programs', () => {
      const m = mapEvent(event({ organizer_id: undefined, organizer: { name: 'Silicon Valley Bicycle Coalition (volunteering)' } }), withPage('https://example.org/classes'), NOW);
      expect(m.program).toBe('Volunteering');
      expect(m.columnValues).not.toHaveProperty('ev_send_col');
    });

    it('omits it when pageUrl is null', () => {
      expect(mapEvent(event(), withPage(null), NOW).columnValues).not.toHaveProperty('ev_send_col');
    });

    it('URL-encodes the event id', () => {
      const m = mapEvent(event({ id: 'a b&c' }), withPage('https://example.org/classes'), NOW);
      expect(m.columnValues['ev_send_col']).toEqual({ url: 'https://example.org/classes?event=a%20b%26c', text: 'Send class email' });
    });
  });

  it('is online for online events', () => {
    const m = mapEvent(event({ online_event: true, venue: null }), config, NOW);
    expect(m.classLocation).toBe('online');
    expect(m.locationKey).toBe('online');
  });

  it('is "<venue name>, <localized address>" for a venue', () => {
    const m = mapEvent(event(), config, NOW);
    expect(m.classLocation).toBe('Mitchell Park, 600 E Meadow Dr, Palo Alto, CA 94306');
    expect(m.locationKey).toBe('mitchell park, 600 e meadow dr, palo alto, ca 94306');
  });

  it('has an empty location with no venue and not online', () => {
    expect(mapEvent(event({ venue: null }), config, NOW).classLocation).toBe('');
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
    expect(mapEvent(event({ status }), config, NOW).columnValues.ev_status_col).toBe(label);
  });

  describe('a canceled event Eventbrite still reports as live or started', () => {
    const canceled = { sales_status: 'sales_ended', message_code: 'event_cancelled' };
    const afterEnd = new Date('2030-01-01T00:00:00Z');

    it.each(['live', 'started'])('writes Canceled for %s, before and after the event', (status) => {
      const e = event({ status, event_sales_status: canceled });
      expect(mapEvent(e, config, NOW).columnValues.ev_status_col).toBe('Canceled');
      expect(mapEvent(e, config, afterEnd).columnValues.ev_status_col).toBe('Canceled');
    });

    it('ignores a sales status that is not a cancellation', () => {
      const e = event({ status: 'live', event_sales_status: { sales_status: 'sales_ended', message_code: 'tickets_not_on_sale' } });
      expect(mapEvent(e, config, NOW).columnValues.ev_status_col).toBe('Upcoming');
    });

    it('reports the status the ledger should keep', () => {
      expect(effectiveEventStatus(event({ status: 'live', event_sales_status: canceled }))).toBe('canceled');
      expect(effectiveEventStatus(event({ status: 'live' }))).toBe('live');
      expect(effectiveEventStatus({ id: '1' })).toBeUndefined();
    });
  });

  describe('once the event has ended', () => {
    const END = '2026-10-31T04:00:00Z';
    const status = (e: EventbriteEvent, now: string) => mapEvent(e, config, new Date(now)).columnValues.ev_status_col;

    // Eventbrite's `started` can outlive the event (84 of them in the 2026-11-02 Salesforce org,
    // all over): a replay of one must not write Upcoming back over a corrected row.
    it.each(['live', 'started'])('writes Completed for a finished %s event', (s) => {
      expect(status(event({ status: s }), '2026-10-31T04:00:01Z')).toBe('Completed');
    });

    it('is Upcoming until the end, and Completed from the end itself', () => {
      expect(status(event({ status: 'started', end: { utc: END } }), '2026-10-31T03:59:59Z')).toBe('Upcoming');
      expect(status(event({ status: 'started', end: { utc: END } }), END)).toBe('Completed');
    });

    it('falls back to the start when the event has no usable end', () => {
      const noEnd = event({ status: 'live', start: { utc: '2026-10-31T02:00:00Z' }, end: null });
      expect(status(noEnd, '2026-10-31T01:59:59Z')).toBe('Upcoming');
      expect(status(noEnd, '2026-10-31T02:00:00Z')).toBe('Completed');
      expect(status({ ...noEnd, end: { utc: 'not a date' } }, '2026-10-31T02:00:00Z')).toBe('Completed');
    });

    it('stays Upcoming with no dates at all', () => {
      expect(status({ id: '1', status: 'live' }, '2030-01-01T00:00:00Z')).toBe('Upcoming');
    });

    it.each([
      ['canceled', 'Canceled'],
      ['deleted', 'Canceled'],
      ['draft', 'Draft'],
    ])('leaves a finished %s event as %s', (s, label) => {
      expect(status(event({ status: s }), '2030-01-01T00:00:00Z')).toBe(label);
    });
  });

  it('takes Program from the organizer name suffix', () => {
    const m = mapEvent(event({ organizer: { name: 'Silicon Valley Bicycle Coalition (volunteering)' } }), config, NOW);
    expect(m.program).toBe('Volunteering');
    expect(m.columnValues.ev_program_col).toBe('Volunteering');
  });

  it('defaults Program to Public with no suffix', () => {
    expect(mapEvent(event(), config, NOW).program).toBe('Public');
  });

  it('lets programByOrganizer override the organizer name', () => {
    const m = mapEvent(event({ organizer_id: 'org-volunteering' }), config, NOW);
    expect(m.program).toBe('Volunteering');
    expect(m.columnValues.ev_program_col).toBe('Volunteering');
  });

  it('honours the fall-back DST change', () => {
    const after = mapEvent(event({ start: { utc: '2026-11-01T16:00:00Z' } }), config, NOW);
    expect(after.classDate).toBe('2026-11-01');
    expect(after.classDay).toBe('Sunday');
    const before = mapEvent(event({ start: { utc: '2026-11-01T06:30:00Z' } }), config, NOW);
    expect(before.classDate).toBe('2026-10-31');
    expect(before.classDay).toBe('Saturday');
  });

  it('copes with a bare event: no dates, name, venue or url', () => {
    const m = mapEvent({ id: '1' }, config, NOW);
    expect(m.itemName).toBe('Eventbrite event 1');
    expect(m.startsAt).toBeNull();
    expect(m.endsAt).toBeNull();
    expect(m.classDate).toBeNull();
    expect(m.classDay).toBeNull();
    expect(m.columnValues).not.toHaveProperty('ev_date_col');
    expect(m.columnValues).not.toHaveProperty('ev_url_col');
  });
});
