import { existsSync } from 'node:fs';
import { appendNdjson, dataPath, readNdjson } from '../artifacts.js';

export interface GeoResult { lat: number; lng: number; city: string; zip: string; source: 'census' | 'google' }

export class GeoCache {
  private map = new Map<string, GeoResult>();
  private path = dataPath('geocode', 'cache.ndjson');

  async load(): Promise<void> {
    this.map.clear();
    if (!existsSync(this.path)) return;
    for (const row of await readNdjson<{ key: string } & GeoResult>(this.path)) {
      const { key, ...r } = row;
      this.map.set(key, r);
    }
  }
  get(key: string): GeoResult | undefined { return this.map.get(key); }
  async set(key: string, r: GeoResult): Promise<void> {
    this.map.set(key, r);
    await appendNdjson(this.path, { key, ...r });
  }
  size(): number { return this.map.size; }
}
