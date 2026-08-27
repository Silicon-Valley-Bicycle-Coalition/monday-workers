import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchEventbriteEvents } from './eventbrite';
import type { EventbriteSourceConfig } from '../types';

const SOURCE: EventbriteSourceConfig = {
  id: 'eventbrite-public-events',
  name: 'SVBC Public Events',
  committeeName: 'SVBC Events — Public Events',
  adapter: 'eventbrite',
  organizerId: 'org-123',
};

const PAGE_1 = {
  events: [
    {
      id: 'evt-1',
      name: { text: 'Group Ride: Los Gatos Loop' },
      description: { text: 'Subtype: Family Ride' },
      summary: 'A short, family-friendly ride.',
      url: 'https://www.eventbrite.com/e/evt-1',
      is_free: true,
      online_event: false,
      logo: { url: 'https://img.example.com/cropped.jpg', original: { url: 'https://img.example.com/original.jpg' } },
      start: { timezone: 'America/Los_Angeles', local: '2026-10-01T10:00:00', utc: '2026-10-01T17:00:00Z' },
      end: { timezone: 'America/Los_Angeles', local: '2026-10-01T12:00:00', utc: '2026-10-01T19:00:00Z' },
      venue: { name: 'Los Gatos Plaza', address: { city: 'Los Gatos', localized_address_display: 'Los Gatos, CA' } },
    },
  ],
  pagination: { has_more_items: true, continuation: 'cont-token-1' },
};

const PAGE_2 = {
  events: [
    {
      id: 'evt-2',
      name: { text: '', html: '<b>Bike Month Kickoff</b>' },
      description: null,
      summary: null,
      url: 'not a valid url',
      is_free: false,
      online_event: true,
      logo: null,
      start: { timezone: 'America/Los_Angeles', local: '2026-05-01T09:00:00', utc: '2026-05-01T16:00:00Z' },
      end: { timezone: 'America/Los_Angeles', local: '2026-05-01T11:00:00', utc: '2026-05-01T18:00:00Z' },
      venue: null,
    },
  ],
  pagination: { has_more_items: false },
};

describe('fetchEventbriteEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches all pages, normalizes into NormalizedEvent, and carries the widget-display fields', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
      if (String(url).includes('continuation=cont-token-1')) {
        return new Response(JSON.stringify(PAGE_2), { status: 200 });
      }
      expect(String(url)).toBe('https://www.eventbriteapi.com/v3/organizers/org-123/events/?expand=venue&status=live&order_by=start_asc');
      return new Response(JSON.stringify(PAGE_1), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchEventbriteEvents(SOURCE, 'test-token');

    expect(events).toEqual([
      {
        sourceId: 'eventbrite-public-events',
        externalId: 'evt-1',
        title: 'Group Ride: Los Gatos Loop',
        committeeName: 'SVBC Events — Public Events',
        startUtc: '2026-10-01T17:00:00Z',
        endUtc: '2026-10-01T19:00:00Z',
        location: 'Los Gatos, CA',
        url: 'https://www.eventbrite.com/e/evt-1',
        description: 'Subtype: Family Ride',
        startLocal: '2026-10-01T10:00:00',
        endLocal: '2026-10-01T12:00:00',
        timezone: 'America/Los_Angeles',
        isFree: true,
        onlineEvent: false,
        summary: 'A short, family-friendly ride.',
        logoUrl: 'https://img.example.com/original.jpg',
        venueName: 'Los Gatos Plaza',
        venueCity: 'Los Gatos',
        venueAddress: 'Los Gatos, CA',
      },
      {
        sourceId: 'eventbrite-public-events',
        externalId: 'evt-2',
        title: 'Bike Month Kickoff',
        committeeName: 'SVBC Events — Public Events',
        startUtc: '2026-05-01T16:00:00Z',
        endUtc: '2026-05-01T18:00:00Z',
        location: null,
        url: null,
        description: null,
        startLocal: '2026-05-01T09:00:00',
        endLocal: '2026-05-01T11:00:00',
        timezone: 'America/Los_Angeles',
        isFree: false,
        onlineEvent: true,
        summary: null,
        logoUrl: null,
        venueName: null,
        venueCity: null,
        venueAddress: null,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws with a descriptive message on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403, statusText: 'Forbidden' })));
    await expect(fetchEventbriteEvents(SOURCE, 'test-token')).rejects.toThrow('eventbrite: organizer org-123 fetch failed: 403 Forbidden');
  });

  it('stops paginating once maxEvents is reached, without fetching further pages', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(PAGE_1), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchEventbriteEvents(SOURCE, 'test-token', 1);

    expect(events).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps pagination at 20 pages instead of looping forever', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ events: [{ ...PAGE_1.events[0], id: `evt-${calls}` }], pagination: { has_more_items: true, continuation: `cont-${calls}` } }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await fetchEventbriteEvents(SOURCE, 'test-token');

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(events).toHaveLength(20);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('hit the 20-page cap'));
    errorSpy.mockRestore();
  });
});
