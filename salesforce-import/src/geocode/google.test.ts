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
