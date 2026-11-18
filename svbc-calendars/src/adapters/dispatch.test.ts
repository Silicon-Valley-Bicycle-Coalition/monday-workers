import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFetchSourceEvents } from './dispatch';
import type { EventbriteSourceConfig, LegistarSourceConfig, SourceConfig } from '../types';
import { SOURCE_FETCH_TIMEOUT_MS } from '../util/fetchTimeout';

describe('createFetchSourceEvents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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

  // GL#73: a hung source must fail like any other fetch error, so the .ics route can serve its KV
  // fallback and the daily cron can move on to the next source.
  const everyAdapter: SourceConfig[] = [
    { id: 'eb', name: 'EB', committeeName: 'SVBC Events', adapter: 'eventbrite', organizerId: 'org-1' },
    { id: 'lg', name: 'LG', committeeName: 'BPAC', adapter: 'legistar', client: 'santaclara', bodyId: 232 },
    { id: 'cp', name: 'CP', committeeName: 'BPAC', adapter: 'civicplus', domain: 'www.campbellca.gov', catId: 32 },
    { id: 'ct', name: 'CT', committeeName: 'BATAC', adapter: 'caltrainBatac', pageUrl: 'https://www.caltrain.com/batac', titleFilter: 'BATAC' },
  ] as SourceConfig[];

  it.each(everyAdapter.map((source) => [source.adapter, source] as const))('times out a hung %s source', async (_adapter, source) => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(1));
    // Never answers; only an abort on the request's signal ends it.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
      )
    );

    await expect(createFetchSourceEvents('token')(source, new Date())).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(timeoutSpy).toHaveBeenCalledWith(SOURCE_FETCH_TIMEOUT_MS);
  });
});
