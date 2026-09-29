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
      expect(String(url)).toBe(
        'https://www.eventbriteapi.com/v3/organizers/org-123/events/?expand=venue&status=live&order_by=start_asc&time_filter=current_future'
      );
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

  it("includes Eventbrite's error code and description in the message on a non-OK response", async () => {
    const body = { status_code: 400, error: 'ARGUMENTS_ERROR', error_description: 'There are errors with your arguments: time_filter - INVALID' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 400, statusText: 'Bad Request' })));
    await expect(fetchEventbriteEvents(SOURCE, 'test-token')).rejects.toThrow(
      'eventbrite: organizer org-123 fetch failed: 400 Bad Request — ARGUMENTS_ERROR: There are errors with your arguments: time_filter - INVALID'
    );
  });

  it('caps a non-JSON error body so a huge HTML error page cannot flood the status or log line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(5000), { status: 502, statusText: 'Bad Gateway' })));
    const err = await fetchEventbriteEvents(SOURCE, 'test-token').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^eventbrite: organizer org-123 fetch failed: 502 Bad Gateway — x{300}…$/);
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

  it('excludes unlisted and invite-only events', async () => {
    const page = {
      events: [
        { ...PAGE_1.events[0], id: 'evt-public' },
        { ...PAGE_1.events[0], id: 'evt-unlisted', name: { text: 'Private Board Meeting' }, listed: false },
        { ...PAGE_1.events[0], id: 'evt-invite-only', name: { text: 'Invite-Only Donor Reception' }, invite_only: true },
      ],
      pagination: { has_more_items: false },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })));

    const events = await fetchEventbriteEvents(SOURCE, 'test-token');

    expect(events.map((e) => e.externalId)).toEqual(['evt-public']);
  });

  it('strips crop/resize params from the logo URL, keeping only auto/q/sharp/s', async () => {
    const page = {
      events: [
        {
          ...PAGE_1.events[0],
          logo: {
            url: 'https://img.example.com/cropped.jpg?w=100&h=100&auto=format',
            original: { url: 'https://img.example.com/original.jpg?crop=1&w=800&h=600&auto=format&q=75&sharp=10&s=abc123&fit=crop' },
          },
        },
      ],
      pagination: { has_more_items: false },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })));

    const [event] = await fetchEventbriteEvents(SOURCE, 'test-token');

    expect(event.logoUrl).toBe('https://img.example.com/original.jpg?auto=format&q=75&sharp=10&s=abc123');
  });
});
