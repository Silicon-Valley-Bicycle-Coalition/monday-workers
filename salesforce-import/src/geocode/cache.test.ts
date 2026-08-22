import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeoCache } from './cache.js';

describe('GeoCache', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  it('persists across instances', async () => {
    const a = new GeoCache();
    await a.load();
    await a.set('K', { lat: 37.3, lng: -121.9, city: 'San Jose', zip: '95112', source: 'census' });
    const b = new GeoCache();
    await b.load();
    expect(b.get('K')?.city).toBe('San Jose');
    expect(b.size()).toBe(1);
  });

  it('misses cleanly', async () => {
    const c = new GeoCache();
    await c.load();
    expect(c.get('NOPE')).toBeUndefined();
  });
});
