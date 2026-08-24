import { describe, it, expect, vi } from 'vitest';
import { searchPlace } from './places.js';

function fakeFetch(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as typeof fetch;
}

describe('searchPlace', () => {
  it('queries Places text search with a Santa Clara/San Mateo county bias and field mask', async () => {
    const fetchFn = fakeFetch({
      places: [{ displayName: { text: 'Recology Inc' }, websiteUri: 'https://www.recology.com/',
        formattedAddress: '1680 Vista Bella Dr, Milpitas, CA 95035, USA' }],
    });

    const result = await searchPlace('Recology Inc.', { apiKey: 'k', fetchFn });

    expect(result).toEqual({
      name: 'Recology Inc',
      website: 'https://www.recology.com/',
      address: '1680 Vista Bella Dr, Milpitas, CA 95035, USA',
    });
    const [url, init] = (fetchFn as any).mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(init.headers['X-Goog-Api-Key']).toBe('k');
    expect(init.headers['X-Goog-FieldMask']).toContain('websiteUri');
    const body = JSON.parse(init.body);
    expect(body.textQuery).toBe('Recology Inc.');
    expect(body.locationBias.rectangle.low.latitude).toBeLessThan(37.8);
  });

  it('returns null when Places has no result', async () => {
    const result = await searchPlace('Morimoto Family Fund', { apiKey: 'k', fetchFn: fakeFetch({}) });
    expect(result).toBeNull();
  });

  it('throws on an HTTP error so the caller can stop instead of recording misses', async () => {
    await expect(searchPlace('X', { apiKey: 'k', fetchFn: fakeFetch({ error: {} }, false) }))
      .rejects.toThrow(/places: HTTP 500/);
  });
});
