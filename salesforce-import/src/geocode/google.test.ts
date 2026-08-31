import { describe, it, expect } from 'vitest';
import { googleGeocode } from './google.js';

const ok = {
  status: 'OK',
  results: [{
    geometry: { location: { lat: 37.32, lng: -122.03 } },
    address_components: [
      { long_name: 'Cupertino', types: ['locality', 'political'] },
      { long_name: '95014', types: ['postal_code'] },
    ],
  }],
};

describe('googleGeocode', () => {
  it('parses lat/lng/city/zip', async () => {
    const fetchFn = (async () => Response.json(ok)) as typeof fetch;
    expect(await googleGeocode('1 Infinite Loop, Cupertino, CA', 'KEY', { fetchFn })).toEqual({
      lat: 37.32, lng: -122.03, city: 'Cupertino', zip: '95014', source: 'google',
    });
  });
  it('returns null on ZERO_RESULTS', async () => {
    const fetchFn = (async () => Response.json({ status: 'ZERO_RESULTS', results: [] })) as typeof fetch;
    expect(await googleGeocode('gibberish', 'KEY', { fetchFn })).toBeNull();
  });
});

describe('googleGeocode error handling', () => {
  it('returns null on a 4xx (bad address) instead of crashing the stage', async () => {
    const fetchFn = (async () => ({ ok: false, status: 400, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await googleGeocode('garbage address', 'k', { fetchFn })).toBeNull();
  });

  it('retries server errors with backoff, then throws so the caller can skip the address', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; return { ok: false, status: 500, json: async () => ({}) }; }) as unknown as typeof fetch;
    await expect(googleGeocode('1 Main St', 'k', { fetchFn, sleepFn: async () => {} }))
      .rejects.toThrow(/HTTP 500/);
    expect(calls).toBe(4); // all retry attempts consumed
  });

  it('a transient network throw recovers on retry', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return Response.json(ok);
    }) as typeof fetch;
    const r = await googleGeocode('1 Infinite Loop', 'k', { fetchFn, sleepFn: async () => {} });
    expect(r?.city).toBe('Cupertino');
    expect(calls).toBe(2);
  });
});
