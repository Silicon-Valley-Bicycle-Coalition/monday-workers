import { describe, it, expect, vi } from 'vitest';
import { createFetchSourceEvents } from './dispatch';
import type { EventbriteSourceConfig, LegistarSourceConfig } from '../types';

describe('createFetchSourceEvents', () => {
  it('routes an eventbrite source to fetchEventbriteEvents with the closed-over token', async () => {
    const source: EventbriteSourceConfig = {
      id: 'eventbrite-public-events',
      name: 'SVBC Public Events',
      committeeName: 'SVBC Events',
      adapter: 'eventbrite',
      organizerId: 'org-1',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
        return new Response(JSON.stringify({ events: [], pagination: { has_more_items: false } }), { status: 200 });
      })
    );

    const fetchSourceEvents = createFetchSourceEvents('secret-token');
    const events = await fetchSourceEvents(source, new Date());

    expect(events).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('routes a legistar source to fetchLegistarEvents, ignoring the token', async () => {
    const source: LegistarSourceConfig = { id: 'santa-clara', name: 'Santa Clara', committeeName: 'BPAC', adapter: 'legistar', client: 'santaclara', bodyId: 232 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));

    const fetchSourceEvents = createFetchSourceEvents('unused-token');
    const events = await fetchSourceEvents(source, new Date('2026-01-01T00:00:00Z'));

    expect(events).toEqual([]);
    vi.unstubAllGlobals();
  });
});
