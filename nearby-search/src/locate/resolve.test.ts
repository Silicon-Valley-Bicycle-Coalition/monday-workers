import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOsmClient, OsmError, type NominatimHit, type OsmClient, type OverpassResponse } from './osm';
import { resolveLocation } from './resolve';
import segment from './fixtures/stevens-creek-segment.json';
import intersection from './fixtures/bascom-hamilton-intersection.json';
import divided from './fixtures/divided-carriageway.json';

const AREA: [number, number, number, number] = [36.89, -122.53, 37.71, -121.2];
const OSM_CONFIG = {
  nominatimUrl: 'https://nominatim.example',
  overpassUrl: 'https://overpass.example/api/interpreter',
  userAgent: 'svbc-nearby-search (test)',
};

type Way = { type: 'way'; id: number; nodes: number[]; tags: Record<string, string>; geometry?: { lat: number; lon: number }[] };

// A fake client that answers every Overpass query with one canned response and records the QL.
function fakeOsm(overpass: unknown, hits: NominatimHit[] = []) {
  const calls = { overpass: [] as string[], nominatim: [] as string[] };
  const osm: OsmClient = {
    async nominatim(q) {
      calls.nominatim.push(q);
      return hits;
    },
    async overpass(ql) {
      calls.overpass.push(ql);
      return overpass as OverpassResponse;
    },
  };
  return { osm, calls };
}

// [lng, lat] of every node a road way shares with a way of the cross street, read straight from
// the fixture, so the test doesn't reuse the code under test to find crossings.
function crossingCoords(elements: unknown[], road: string, cross: RegExp): number[][] {
  const ways = elements as Way[];
  const coords = new Map<number, number[]>();
  for (const w of ways.filter((w) => w.tags.name === road && w.geometry)) {
    w.nodes.forEach((n, i) => coords.set(n, [w.geometry![i]!.lon, w.geometry![i]!.lat]));
  }
  const shared = ways.filter((w) => cross.test(w.tags.name ?? '')).flatMap((w) => w.nodes.filter((n) => coords.has(n)));
  return [...new Set(shared)].map((n) => coords.get(n)!);
}

describe('resolveLocation: segment', () => {
  const query = { kind: 'segment', road: 'Stevens Creek Boulevard', from: 'Saratoga Avenue', to: 'Winchester Boulevard' } as const;

  it('follows the road between the two crossings', async () => {
    const { osm, calls } = fakeOsm(segment);
    const result = await resolveLocation(query, osm, AREA);
    expect(calls.overpass).toEqual([segment._query.trim()]);
    if (result.kind !== 'line') throw new Error(`expected a line, got ${JSON.stringify(result)}`);
    expect(result.label).toBe('Stevens Creek Boulevard from Saratoga Avenue to Winchester Boulevard');
    expect(result.geometry.type).toBe('LineString');
    const coords = result.geometry.coordinates;
    expect(crossingCoords(segment.elements, 'Stevens Creek Boulevard', /Saratoga Avenue$/)).toContainEqual(coords[0]);
    expect(crossingCoords(segment.elements, 'Stevens Creek Boulevard', /Winchester Boulevard$/)).toContainEqual(coords.at(-1));
    expect(Math.abs(result.lengthMiles - segment._handMeasuredMiles) / segment._handMeasuredMiles).toBeLessThan(0.05);
  });

  it('still returns a line on a divided road of two one-way ways', async () => {
    const { osm } = fakeOsm(divided);
    const result = await resolveLocation({ kind: 'segment', road: 'Example Road', from: 'West Street', to: 'East Street' }, osm, AREA);
    if (result.kind !== 'line') throw new Error(`expected a line, got ${JSON.stringify(result)}`);
    // The shorter, north carriageway: nodes 1-2-3-4.
    expect(result.geometry.coordinates).toEqual([
      [-121.93, 37.301],
      [-121.925, 37.301],
      [-121.92, 37.301],
      [-121.915, 37.301],
    ]);
    expect(result.lengthMiles).toBeCloseTo(0.8245, 2);
  });

  it('names the cross street that never meets the road', async () => {
    const withoutSaratoga = { ...segment, elements: (segment.elements as unknown as Way[]).filter((e) => !/Saratoga/.test(e.tags.name ?? '')) };
    const { osm } = fakeOsm(withoutSaratoga);
    expect(await resolveLocation(query, osm, AREA)).toEqual({
      kind: 'not-found',
      message: "Saratoga Avenue doesn't cross Stevens Creek Boulevard in OpenStreetMap.",
    });
  });

  it('names the to street when that crossing is the missing one', async () => {
    const withoutWinchester = { ...segment, elements: (segment.elements as unknown as Way[]).filter((e) => !/Winchester/.test(e.tags.name ?? '')) };
    const { osm } = fakeOsm(withoutWinchester);
    expect(await resolveLocation(query, osm, AREA)).toEqual({
      kind: 'not-found',
      message: "Winchester Boulevard doesn't cross Stevens Creek Boulevard in OpenStreetMap.",
    });
  });

  it('reports a road it cannot follow between the crossings', async () => {
    // Two stretches of Example Road that share no node: each cross street meets a different one.
    const broken = {
      elements: [
        { type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'primary', name: 'Example Road' }, geometry: [{ lat: 37.3, lon: -121.93 }, { lat: 37.3, lon: -121.925 }] },
        { type: 'way', id: 2, nodes: [3, 4], tags: { highway: 'primary', name: 'Example Road' }, geometry: [{ lat: 37.3, lon: -121.92 }, { lat: 37.3, lon: -121.915 }] },
        { type: 'way', id: 3, nodes: [9, 1], tags: { highway: 'secondary', name: 'West Street' } },
        { type: 'way', id: 4, nodes: [4, 9], tags: { highway: 'secondary', name: 'East Street' } },
      ],
    };
    const { osm } = fakeOsm(broken);
    expect(await resolveLocation({ kind: 'segment', road: 'Example Road', from: 'West Street', to: 'East Street' }, osm, AREA)).toEqual({
      kind: 'not-found',
      message: "Couldn't follow Example Road from West Street to East Street.",
    });
  });

  it('escapes regex characters in names', async () => {
    const { osm, calls } = fakeOsm({ elements: [] });
    await resolveLocation({ kind: 'segment', road: 'St. James (Old) Street', from: 'A+ Street', to: 'B Street' }, osm, AREA);
    // Regex-escaped (\. \( \) \+), then each backslash doubled inside the QL string literal.
    expect(calls.overpass[0]).toContain('"name"~"^((north|south|east|west) )?St\\\\. James \\\\(Old\\\\) Street$",i]->.road;');
    expect(calls.overpass[0]).toContain('"name"~"^((north|south|east|west) )?A\\\\+ Street$",i]->.from;');
  });
});

describe('resolveLocation: intersection', () => {
  it('returns the first node the two streets share', async () => {
    const { osm, calls } = fakeOsm(intersection);
    const result = await resolveLocation({ kind: 'intersection', a: 'Bascom Avenue', b: 'Hamilton Avenue' }, osm, AREA);
    expect(calls.overpass).toEqual([intersection._query.trim()]);
    expect(result).toEqual({ kind: 'point', lat: 37.2942561, lng: -121.9316119, label: 'Bascom Avenue & Hamilton Avenue' });
  });

  it('reports streets that never meet', async () => {
    const { osm } = fakeOsm({ elements: [] });
    expect(await resolveLocation({ kind: 'intersection', a: 'Bascom Avenue', b: 'Page Mill Road' }, osm, AREA)).toEqual({
      kind: 'not-found',
      message: "Bascom Avenue and Page Mill Road don't meet in OpenStreetMap.",
    });
  });
});

describe('resolveLocation: address and place', () => {
  it('searches Nominatim bounded to the service area', async () => {
    const hit = { lat: '37.4194', lon: '-122.1100', display_name: '600, East Meadow Drive, Palo Alto, CA 94306' } as NominatimHit;
    const { osm, calls } = fakeOsm({ elements: [] }, [hit]);
    const result = await resolveLocation({ kind: 'address', text: '600 E Meadow Dr, Palo Alto, CA 94306' }, osm, AREA);
    expect(result).toEqual({ kind: 'point', lat: 37.4194, lng: -122.11, label: hit.display_name });
    const params = new URLSearchParams(calls.nominatim[0]);
    expect(Object.fromEntries(params)).toEqual({
      q: '600 E Meadow Dr, Palo Alto, CA 94306',
      format: 'jsonv2',
      limit: '1',
      countrycodes: 'us',
      bounded: '1',
      viewbox: '-122.53,37.71,-121.2,36.89',
    });
  });

  it('reports a place Nominatim cannot find', async () => {
    const { osm } = fakeOsm({ elements: [] }, []);
    expect(await resolveLocation({ kind: 'place', text: 'Nowhere Station' }, osm, AREA)).toEqual({
      kind: 'not-found',
      message: "OpenStreetMap couldn't find 'Nowhere Station' in Santa Clara or San Mateo County.",
    });
  });
});

describe('createOsmClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeCache() {
    const store = new Map<string, Response>();
    const cache = {
      async match(req: RequestInfo | URL) {
        const hit = store.get(typeof req === 'string' ? req : req instanceof URL ? req.href : req.url);
        return hit?.clone();
      },
      async put(req: RequestInfo | URL, res: Response) {
        store.set(typeof req === 'string' ? req : req instanceof URL ? req.href : req.url, res.clone());
      },
    };
    return { cache: cache as unknown as Cache, store };
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('sends the User-Agent and serves a repeat Overpass query from the cache', async () => {
    const fetchMock = vi.fn(async () => json({ elements: [{ type: 'node', id: 1, lat: 37, lon: -122 }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { cache, store } = fakeCache();
    const osm = createOsmClient(OSM_CONFIG, cache);

    const first = await osm.overpass('node(1); out;');
    const second = await osm.overpass('node(1); out;');

    expect(first).toEqual(second);
    expect(first.elements).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OSM_CONFIG.overpassUrl);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('user-agent')).toBe(OSM_CONFIG.userAgent);
    expect(new URLSearchParams(init.body as string).get('data')).toBe('node(1); out;');
    // Keyed by a GET URL derived from the POST body, cached for 24 hours.
    const [key] = [...store.keys()];
    expect(key).toMatch(/^https:\/\/overpass\.example\/api\/interpreter\?body=[0-9a-f]{64}$/);
    expect(store.get(key!)!.headers.get('cache-control')).toBe('max-age=86400');

    await osm.overpass('node(2); out;');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends the User-Agent and caches a repeat Nominatim search', async () => {
    const fetchMock = vi.fn(async () => json([{ lat: '37', lon: '-122', display_name: 'Somewhere' }]));
    vi.stubGlobal('fetch', fetchMock);
    const osm = createOsmClient(OSM_CONFIG, fakeCache().cache);

    expect(await osm.nominatim('q=Somewhere&format=jsonv2')).toEqual([{ lat: '37', lon: '-122', display_name: 'Somewhere' }]);
    await osm.nominatim('q=Somewhere&format=jsonv2');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://nominatim.example/search?q=Somewhere&format=jsonv2');
    expect(new Headers(init.headers).get('user-agent')).toBe(OSM_CONFIG.userAgent);
  });

  it('throws OsmError with the status on a non-2xx and does not cache it', async () => {
    const fetchMock = vi.fn(async () => new Response('too many requests', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const { cache, store } = fakeCache();
    const osm = createOsmClient(OSM_CONFIG, cache);

    const error = await osm.overpass('node(1); out;').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OsmError);
    expect((error as OsmError).status).toBe(429);
    expect(store.size).toBe(0);
  });

  it('treats an Overpass runtime error (HTTP 200 with a remark) as a failure, not an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ elements: [], remark: 'runtime error: Query timed out in "query" at line 2 after 26 seconds.' })));
    const { cache, store } = fakeCache();
    const error = await createOsmClient(OSM_CONFIG, cache).overpass('node(1); out;').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OsmError);
    expect(store.size).toBe(0);
  });
});
