import { describe, it, expect } from 'vitest';
import { censusBatch } from './census.js';

// Census response CSV: id, input addr, match, exact, matched addr, "lng,lat", tigerId, side
const responseCsv = [
  '"1","123 MAIN ST, SAN JOSE, CA, 95112","Match","Exact","123 MAIN ST, SAN JOSE, CA, 95112","-121.9,37.34","639660","L"',
  '"2","9 NOWHERE, X, CA, 00000","No_Match"',
].join('\n');

describe('censusBatch', () => {
  it('parses matches with lat/lng/city/zip and skips non-matches', async () => {
    const fetchFn = (async () => new Response(responseCsv)) as typeof fetch;
    const out = await censusBatch([
      { key: 'K1', street: '123 Main St', city: 'San Jose', state: 'CA', zip: '95112' },
      { key: 'K2', street: '9 Nowhere', city: 'X', state: 'CA', zip: '00000' },
    ], { fetchFn });
    expect(out.get('K1')).toEqual({ lat: 37.34, lng: -121.9, city: 'San Jose', zip: '95112', source: 'census' });
    expect(out.has('K2')).toBe(false);
  });
});
