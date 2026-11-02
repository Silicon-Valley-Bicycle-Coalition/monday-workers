// Turns a parsed LocationQuery into something geo-filter can buffer: a point (address, place,
// intersection) or a LineString (a road between two cross streets). The organizer confirms the
// result on a map before anything is searched, and the design's top anti-goal is a wrong
// resolution applied unseen — so anything that can't be found is a `not-found` with a message
// saying what's missing, never a guess or a fallback.
import type { LineString } from 'geojson';
import type { NominatimHit, OsmClient, OverpassElement } from './osm';
import type { LocationQuery } from './parse';

export type Resolved =
  | { kind: 'point'; lat: number; lng: number; label: string }
  | { kind: 'line'; geometry: LineString; label: string; lengthMiles: number }
  | { kind: 'not-found'; message: string };

type Area = [number, number, number, number]; // [south, west, north, east]

const EARTH_RADIUS_MILES = 3958.7613;

// Parse expands "S Bascom Ave" but can't know that OSM calls plain "Bascom Ave" "South Bascom
// Avenue" — so a compass prefix is optional on every name. Matching stays anchored at both ends.
const COMPASS_PREFIX = '((north|south|east|west) )?';

const escapeRegex = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// An Overpass QL string literal unescapes backslashes and ends at a quote, so both are escaped
// again on top of the regex escaping.
const nameFilter = (name: string): string =>
  `["name"~"${`^${COMPASS_PREFIX}${escapeRegex(name)}$`.replace(/[\\"]/g, '\\$&')}",i]`;

const nameMatcher = (name: string): RegExp => new RegExp(`^${COMPASS_PREFIX}${escapeRegex(name)}$`, 'i');

const header = ([south, west, north, east]: Area): string => `[out:json][timeout:25][bbox:${south},${west},${north},${east}];`;

export function haversineMiles(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

export async function resolveLocation(q: LocationQuery, osm: OsmClient, area: Area): Promise<Resolved> {
  switch (q.kind) {
    case 'address':
    case 'place':
      return resolveSearch(q.text, osm, area);
    case 'intersection':
      return resolveIntersection(q.a, q.b, osm, area);
    case 'segment':
      return resolveSegment(q.road, q.from, q.to, osm, area);
  }
}

async function resolveSearch(text: string, osm: OsmClient, [south, west, north, east]: Area): Promise<Resolved> {
  const params = new URLSearchParams({
    q: text,
    format: 'jsonv2',
    limit: '1',
    countrycodes: 'us',
    bounded: '1',
    viewbox: `${west},${north},${east},${south}`,
  });
  const [hit]: (NominatimHit | undefined)[] = await osm.nominatim(params.toString());
  const lat = Number(hit?.lat);
  const lng = Number(hit?.lon);
  if (!hit || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { kind: 'not-found', message: `OpenStreetMap couldn't find '${text}' in Santa Clara or San Mateo County.` };
  }
  return { kind: 'point', lat, lng, label: hit.display_name };
}

async function resolveIntersection(a: string, b: string, osm: OsmClient, area: Area): Promise<Resolved> {
  const ql = [
    header(area),
    `way["highway"]${nameFilter(a)}->.a;`,
    `way["highway"]${nameFilter(b)}->.b;`,
    'node(w.a)(w.b);',
    'out;',
  ].join('\n');
  const { elements } = await osm.overpass(ql);
  const node = elements.find((e) => e.type === 'node');
  if (!node) return { kind: 'not-found', message: `${a} and ${b} don't meet in OpenStreetMap.` };
  return { kind: 'point', lat: node.lat, lng: node.lon, label: `${a} & ${b}` };
}

type Way = Extract<OverpassElement, { type: 'way' }>;

async function resolveSegment(road: string, from: string, to: string, osm: OsmClient, area: Area): Promise<Resolved> {
  // The road's ways come back with geometry; the cross streets' ways only with their node ids,
  // which is enough to find the nodes they share with the road.
  const ql = [
    header(area),
    `way["highway"]${nameFilter(road)}->.road;`,
    `way["highway"]${nameFilter(from)}->.from;`,
    `way["highway"]${nameFilter(to)}->.to;`,
    '.road out geom;',
    '.from out;',
    '.to out;',
  ].join('\n');
  const { elements } = await osm.overpass(ql);
  const ways = elements.filter((e): e is Way => e.type === 'way');

  const isRoad = nameMatcher(road);
  const coords = new Map<number, [number, number]>(); // node id → [lng, lat]
  const graph = new Map<number, Map<number, number>>(); // undirected, oneway ignored
  const link = (u: number, v: number, miles: number) => {
    if (!graph.has(u)) graph.set(u, new Map());
    const prev = graph.get(u)!.get(v);
    if (prev === undefined || miles < prev) graph.get(u)!.set(v, miles);
  };
  for (const way of ways) {
    if (!way.geometry || !isRoad.test(way.tags?.name ?? '')) continue;
    way.nodes.forEach((id, i) => {
      const g = way.geometry![i];
      if (g) coords.set(id, [g.lon, g.lat]);
    });
    for (let i = 1; i < way.nodes.length; i++) {
      const u = way.nodes[i - 1]!;
      const v = way.nodes[i]!;
      const cu = coords.get(u);
      const cv = coords.get(v);
      if (!cu || !cv) continue;
      const miles = haversineMiles(cu, cv);
      link(u, v, miles);
      link(v, u, miles);
    }
  }

  // A crossing is a road node that a cross-street way also passes through. A divided road or
  // cross street yields several per crossing; all are kept and Dijkstra picks the closest pair.
  const crossings = (name: string): number[] => {
    const matcher = nameMatcher(name);
    const ids = ways.filter((w) => matcher.test(w.tags?.name ?? '')).flatMap((w) => w.nodes.filter((id) => graph.has(id)));
    return [...new Set(ids)];
  };
  const fromNodes = crossings(from);
  if (fromNodes.length === 0) return { kind: 'not-found', message: `${from} doesn't cross ${road} in OpenStreetMap.` };
  const toNodes = crossings(to);
  if (toNodes.length === 0) return { kind: 'not-found', message: `${to} doesn't cross ${road} in OpenStreetMap.` };

  let best: { miles: number; path: number[] } | null = null;
  const targets = new Set(toNodes);
  for (const source of fromNodes) {
    const found = shortestPath(graph, source, targets);
    if (found && (!best || found.miles < best.miles)) best = found;
  }
  if (!best || best.path.length < 2) return { kind: 'not-found', message: `Couldn't follow ${road} from ${from} to ${to}.` };

  return {
    kind: 'line',
    geometry: { type: 'LineString', coordinates: best.path.map((id) => coords.get(id)!) },
    label: `${road} from ${from} to ${to}`,
    lengthMiles: best.miles,
  };
}

// Dijkstra from one source, stopping at the first target settled (the nearest one).
function shortestPath(
  graph: Map<number, Map<number, number>>,
  source: number,
  targets: Set<number>,
): { miles: number; path: number[] } | null {
  const dist = new Map<number, number>([[source, 0]]);
  const prev = new Map<number, number>();
  const done = new Set<number>();
  const heap = new MinHeap();
  heap.push(0, source);
  while (heap.size > 0) {
    const [d, u] = heap.pop()!;
    if (done.has(u)) continue;
    done.add(u);
    if (targets.has(u)) {
      const path = [u];
      for (let n = prev.get(u); n !== undefined; n = prev.get(n)) path.push(n);
      return { miles: d, path: path.reverse() };
    }
    for (const [v, w] of graph.get(u) ?? []) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, u);
        heap.push(nd, v);
      }
    }
  }
  return null;
}

class MinHeap {
  private items: [number, number][] = [];

  get size(): number {
    return this.items.length;
  }

  push(priority: number, value: number): void {
    const items = this.items;
    items.push([priority, value]);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent]![0] <= items[i]![0]) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }

  pop(): [number, number] | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let min = i;
        if (l < items.length && items[l]![0] < items[min]![0]) min = l;
        if (r < items.length && items[r]![0] < items[min]![0]) min = r;
        if (min === i) break;
        [items[min], items[i]] = [items[i]!, items[min]!];
        i = min;
      }
    }
    return top;
  }
}
