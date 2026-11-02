// Thin client for the two public OpenStreetMap services the locator uses: Nominatim (addresses and
// named places) and Overpass (street geometry). Both ask callers to identify themselves with a
// User-Agent and not to repeat queries, so every successful response is cached for 24 hours in the
// Workers Cache API. A non-2xx — or an Overpass runtime error, which arrives as HTTP 200 with a
// `remark` and partial results — throws OsmError rather than looking like "nothing found".
import type { Config } from '../config';

export interface NominatimHit {
  lat: string;
  lon: string;
  display_name: string;
  // [south, north, west, east] as strings, as Nominatim's jsonv2 sends it.
  boundingbox?: [string, string, string, string];
}

export type OverpassElement =
  | { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
  | { type: 'way'; id: number; nodes: number[]; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string> };

export interface OverpassResponse {
  elements: OverpassElement[];
  remark?: string;
}

export interface OsmClient {
  // `query` is a ready-made query string (q=…&format=jsonv2&…) appended to `<nominatimUrl>/search?`.
  nominatim(query: string): Promise<NominatimHit[]>;
  overpass(ql: string): Promise<OverpassResponse>;
}

export class OsmError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OsmError';
    this.status = status;
  }
}

const CACHE_SECONDS = 24 * 60 * 60;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createOsmClient(cfg: Config['osm'], cache?: Cache): OsmClient {
  // Resolved lazily so tests that pass a fake never touch the Workers-only global. The cast: this
  // tsconfig also loads the DOM lib, whose CacheStorage has no `default`.
  const store = (): Cache => cache ?? (caches as unknown as { default: Cache }).default;

  async function cachedJson<T>(cacheKey: string, url: string, init: RequestInit, service: string, check?: (body: T) => void): Promise<T> {
    const hit = await store().match(cacheKey);
    if (hit) return (await hit.json()) as T;

    const headers = new Headers(init.headers);
    headers.set('User-Agent', cfg.userAgent);
    headers.set('Accept', 'application/json');
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) throw new OsmError(`${service} returned HTTP ${res.status}`, res.status);
    const text = await res.text();
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      throw new OsmError(`${service} returned a response that isn't JSON`, 502);
    }
    check?.(body);

    await store().put(
      cacheKey,
      new Response(text, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` } }),
    );
    return body;
  }

  return {
    nominatim(query) {
      const url = `${cfg.nominatimUrl.replace(/\/+$/, '')}/search?${query}`;
      return cachedJson<NominatimHit[]>(url, url, { method: 'GET' }, 'Nominatim');
    },

    async overpass(ql) {
      const body = new URLSearchParams({ data: ql }).toString();
      // The Cache API only stores GET requests, so a POST is keyed by a synthetic GET URL.
      const cacheKey = `${cfg.overpassUrl}?body=${await sha256Hex(body)}`;
      return cachedJson<OverpassResponse>(
        cacheKey,
        cfg.overpassUrl,
        { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        'Overpass',
        (res) => {
          if (res.remark && /error/i.test(res.remark)) throw new OsmError('Overpass reported a runtime error', 502);
          if (!Array.isArray(res.elements)) throw new OsmError('Overpass returned no elements array', 502);
        },
      );
    },
  };
}
