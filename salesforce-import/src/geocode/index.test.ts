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
});
