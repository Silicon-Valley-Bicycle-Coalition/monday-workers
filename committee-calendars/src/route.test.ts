import { describe, it, expect } from 'vitest';
import { createApp } from './route';
import type { EventStore } from './db/events';
import type { NormalizedEvent } from './types';

function fakeEventStore(events: NormalizedEvent[]): EventStore {
  return {
    async replaceSourceEvents() {},
    async recordSourceSuccess() {},
    async recordSourceFailure() {
      return 1;
    },
    async getFutureEvents() {
      return events;
    },
  };
}

describe('GET /committees.ics', () => {
  it('returns a merged ICS calendar with the correct content-type and cache-control headers', async () => {
    const events: NormalizedEvent[] = [
      { sourceId: 'campbell', externalId: '1', title: 'BPAC Meeting', committeeName: 'BPAC', startUtc: '2026-09-01T00:00:00.000Z', endUtc: null, location: null, url: null },
    ];
    const app = createApp({ eventStore: fakeEventStore(events), now: () => new Date('2026-08-22T00:00:00.000Z') });

    const response = await app.request('/committees.ics');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = await response.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('SUMMARY:BPAC Meeting');
  });

  it('returns a valid empty calendar when D1 has zero rows (fresh deploy)', async () => {
    const app = createApp({ eventStore: fakeEventStore([]), now: () => new Date('2026-08-22T00:00:00.000Z') });

    const response = await app.request('/committees.ics');

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).not.toContain('BEGIN:VEVENT');
  });

  it('answers /health', async () => {
    const app = createApp({ eventStore: fakeEventStore([]), now: () => new Date() });
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('still returns 200 with a valid empty calendar when a stored event has a malformed url that would make createEvents throw', async () => {
    const events: NormalizedEvent[] = [
      {
        sourceId: 'campbell',
        externalId: '1',
        title: 'BPAC Meeting',
        committeeName: 'BPAC',
        startUtc: '2026-09-01T00:00:00.000Z',
        endUtc: null,
        location: null,
        // Not a well-formed absolute URL -- the ics package's schema validator rejects this
        // and buildMergedCalendar throws. This should never propagate to a 500.
        url: 'not a valid url',
      },
    ];
    const app = createApp({ eventStore: fakeEventStore(events), now: () => new Date('2026-08-22T00:00:00.000Z') });

    const response = await app.request('/committees.ics');

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('END:VCALENDAR');
  });
});
