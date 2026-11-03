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

// Crossings further apart than this are different places (the same street pair in two cities),
// not one intersection of divided roads.
const CLUSTER_MILES = 0.5;

export async function resolveLocation(q: LocationQuery, osm: OsmClient, area: Area): Promise<Resolved> {
  switch (q.kind) {
    case 'address':
    case 'place':
      return resolveSearch(q.text, osm, area);
    case 'intersection':
    case 'segment': {
      let bbox = area;
      if (q.city !== undefined) {
        const cityArea = await findCity(q.city, osm, area);
        if (!cityArea) return { kind: 'not-found', message: `OpenStreetMap couldn't find the city '${q.city}'.` };
        bbox = cityArea;
      }
      return q.kind === 'intersection'
        ? resolveIntersection(q.a, q.b, q.city, osm, bbox)
        : resolveSegment(q.road, q.from, q.to, q.city, osm, bbox);
    }
  }
}

function nominatimQuery(text: string, [south, west, north, east]: Area): string {
  return new URLSearchParams({
    q: text,
    format: 'jsonv2',
    limit: '1',
    countrycodes: 'us',
    bounded: '1',
    viewbox: `${west},${north},${east},${south}`,
  }).toString();
}

// The city's bounding box clipped to the service area, or null if Nominatim doesn't know it or it
// lies outside the area.
async function findCity(city: string, osm: OsmClient, area: Area): Promise<Area | null> {
  const [hit]: (NominatimHit | undefined)[] = await osm.nominatim(nominatimQuery(`${city}, CA`, area));
  const box = hit?.boundingbox?.map(Number);
  if (!box || box.length !== 4 || box.some((n) => !Number.isFinite(n))) return null;
  const [s, n, w, e] = box as [number, number, number, number];
  const clipped: Area = [Math.max(s, area[0]), Math.max(w, area[1]), Math.min(n, area[2]), Math.min(e, area[3])];
  return clipped[0] < clipped[2] && clipped[1] < clipped[3] ? clipped : null;
}

// Single-linkage clusters of [lng, lat] points at CLUSTER_MILES; returns the number of clusters.
function clusterCount(points: [number, number][]): number {
  const parent = points.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (haversineMiles(points[i]!, points[j]!) <= CLUSTER_MILES) parent[find(i)] = find(j);
    }
  }
  return new Set(points.map((_, i) => find(i))).size;
}

function ambiguous(what: string, city: string | undefined): Resolved {
  return {
    kind: 'not-found',
    message: city === undefined
      ? `${what} was found in more than one place — add the city, e.g. "${what}, San Jose".`
      : `${what} was found in more than one place in ${city}.`,
  };
}

// The OSM name of the first way matching `matcher` that passes through `node`, else `fallback`.
function matchedName(ways: Way[], matcher: RegExp, node: number, fallback: string): string {
  return ways.find((w) => w.nodes.includes(node) && matcher.test(w.tags?.name ?? ''))?.tags?.name ?? fallback;
}

async function resolveSearch(text: string, osm: OsmClient, area: Area): Promise<Resolved> {
  const [hit]: (NominatimHit | undefined)[] = await osm.nominatim(nominatimQuery(text, area));
  const lat = Number(hit?.lat);
  const lng = Number(hit?.lon);
  if (!hit || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { kind: 'not-found', message: `OpenStreetMap couldn't find '${text}' in Santa Clara or San Mateo County.` };
  }
  return { kind: 'point', lat, lng, label: hit.display_name };
}

async function resolveIntersection(a: string, b: string, city: string | undefined, osm: OsmClient, area: Area): Promise<Resolved> {
  // The shared nodes, then the ways of each street through them (for the names OSM matched).
  const ql = [
    header(area),
    `way["highway"]${nameFilter(a)}->.a;`,
    `way["highway"]${nameFilter(b)}->.b;`,
    'node(w.a)(w.b)->.x;',
    '.x out;',
    'way.a(bn.x);',
    'out;',
    'way.b(bn.x);',
    'out;',
  ].join('\n');
  const { elements } = await osm.overpass(ql);
  const nodes = elements.filter((e): e is Node => e.type === 'node');
  const node = nodes[0];
  if (!node) return { kind: 'not-found', message: `${a} and ${b} don't meet in OpenStreetMap.` };
  if (clusterCount(nodes.map((n) => [n.lon, n.lat])) > 1) return ambiguous(`${a} & ${b}`, city);
  const ways = elements.filter((e): e is Way => e.type === 'way');
  const label = `${matchedName(ways, nameMatcher(a), node.id, a)} & ${matchedName(ways, nameMatcher(b), node.id, b)}`;
  return { kind: 'point', lat: node.lat, lng: node.lon, label };
}

type Way = Extract<OverpassElement, { type: 'way' }>;
type Node = Extract<OverpassElement, { type: 'node' }>;

async function resolveSegment(road: string, from: string, to: string, city: string | undefined, osm: OsmClient, area: Area): Promise<Resolved> {
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
  const spread = (ids: number[]) => clusterCount(ids.map((id) => coords.get(id)!));
  if (spread(fromNodes) > 1 || spread(toNodes) > 1) return ambiguous(`${road} between ${from} and ${to}`, city);

  let best: { miles: number; path: number[] } | null = null;
  const targets = new Set(toNodes);
  for (const source of fromNodes) {
    const found = shortestPath(graph, source, targets);
    if (found && (!best || found.miles < best.miles)) best = found;
  }
  if (!best || best.path.length < 2) return { kind: 'not-found', message: `Couldn't follow ${road} from ${from} to ${to}.` };

  const first = best.path[0]!;
  const last = best.path.at(-1)!;
  const roadName = matchedName(ways, isRoad, first, road);
  const label = `${roadName} from ${matchedName(ways, nameMatcher(from), first, from)} to ${matchedName(ways, nameMatcher(to), last, to)}`;
  return {
    kind: 'line',
    geometry: { type: 'LineString', coordinates: best.path.map((id) => coords.get(id)!) },
    label,
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
