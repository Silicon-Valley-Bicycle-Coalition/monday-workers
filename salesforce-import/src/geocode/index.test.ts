import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGeocode } from './index.js';
import { writeNdjson, dataPath } from '../artifacts.js';
import { GeoCache } from './cache.js';

const censusCsv = '"1","123 MAIN ST, SAN JOSE, CA, 95112","Match","Exact","123 MAIN ST, SAN JOSE, CA, 95112","-121.9,37.34","1","L"';

describe('runGeocode', () => {
  beforeEach(async () => {
    process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-')));
    delete process.env['GOOGLE_MAPS_API_KEY'];
    await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
      { Id: 'c1', MailingStreet: '123 Main St', MailingCity: 'San Jose', MailingState: 'CA', MailingPostalCode: '95112' },
      { Id: 'c2', MailingStreet: null, MailingCity: null }, // ungeocodable — skipped
    ]);
    await writeNdjson(dataPath('extract', 'accounts.ndjson'), []);
  });

  it('geocodes via census and caches the result', async () => {
    const fetchFn = (async () => new Response(censusCsv)) as typeof fetch;
    expect(await runGeocode([], { fetchFn })).toBe(0);
    const cache = new GeoCache();
    await cache.load();
    expect(cache.get('123 MAIN ST|SAN JOSE|CA|95112')?.source).toBe('census');
  });

  it('is idempotent — second run sends nothing to census', async () => {
    const first = (async () => new Response(censusCsv)) as typeof fetch;
    await runGeocode([], { fetchFn: first });
    let called = 0;
    const second = (async () => { called++; return new Response(''); }) as typeof fetch;
    await runGeocode([], { fetchFn: second });
    expect(called).toBe(0); // everything already cached
  });

  it('falls back to Google when census does not match, caching source:google', async () => {
    process.env['GOOGLE_MAPS_API_KEY'] = 'TEST_KEY';
    try {
      await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
        { Id: 'c1', MailingStreet: '123 Main St', MailingCity: 'San Jose', MailingState: 'CA', MailingPostalCode: '95112' },
        { Id: 'c2', MailingStreet: '456 Apple Ave', MailingCity: 'Cupertino', MailingState: 'CA', MailingPostalCode: '95014' },
      ]);
      const fetchFn = (async (url: string) => {
        // Census matches first, not second
        if (url.includes('geocoding.geo.census.gov')) {
          return new Response(censusCsv); // only matches first address
        }
        // Google returns OK for the unmatched address
        return Response.json({
          status: 'OK',
          results: [{
            geometry: { location: { lat: 37.32, lng: -122.03 } },
            address_components: [
              { long_name: 'Cupertino', types: ['locality', 'political'] },
              { long_name: '95014', types: ['postal_code'] },
            ],
          }],
        });
      }) as typeof fetch;
      expect(await runGeocode([], { fetchFn })).toBe(0);
      const cache = new GeoCache();
      await cache.load();
      expect(cache.get('123 MAIN ST|SAN JOSE|CA|95112')?.source).toBe('census');
      expect(cache.get('456 APPLE AVE|CUPERTINO|CA|95014')?.source).toBe('google');
    } finally {
      delete process.env['GOOGLE_MAPS_API_KEY'];
    }
  });

  it('warns and continues when census unmatchedand no API key set', async () => {
    await writeNdjson(dataPath('extract', 'contacts.ndjson'), [
      { Id: 'c1', MailingStreet: '999 Nowhere', MailingCity: 'Gibberish', MailingState: 'XX', MailingPostalCode: '00000' },
    ]);
    const fetchFn = (async () => new Response('')) as typeof fetch;
    let warnCalled = false;
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warnCalled = true; orig(...args); };
    try {
      expect(await runGeocode([], { fetchFn })).toBe(0);
      expect(warnCalled).toBe(true); // Should have logged the unmatched warning
      const cache = new GeoCache();
      await cache.load();
      expect(cache.get('999 NOWHERE|GIBBERISH|XX|00000')).toBeUndefined(); // Not cached
    } finally {
      console.warn = orig;
    }
  });
});
