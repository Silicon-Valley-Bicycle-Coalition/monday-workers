// Line-length attribution for the offline reference build: bike-lane and road miles per block
// group, with each line split at block-group edges so every mile is counted exactly once.
// Strip-only TypeScript: the build script imports this file directly through Node.
import type { Feature, LineString, MultiLineString, MultiPolygon, Polygon } from 'geojson';
import { along, bbox, booleanPointInPolygon, length, lineSplit, polygonToLine } from '@turf/turf';

export type Poly = Feature<Polygon | MultiPolygon, { GEOID: string }>;
type Line = Feature<LineString | MultiLineString>;

const EARTH_RADIUS_MILES = 3958.8; // same as svbc-bike-lanes' haversineDistance
const toRad = Math.PI / 180;

/** Haversine length of a [lon, lat] polyline, in miles. */
export function lineMiles(coords: [number, number][]): number {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i]!;
    const [lon2, lat2] = coords[i + 1]!;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    total += EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return total;
}

function lineParts(line: Line): Feature<LineString>[] {
  const g = line.geometry;
  const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
  return parts
    .filter((c) => c.length >= 2)
    .map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }));
}

function midpoint(piece: Feature<LineString>): [number, number] {
  const mid = along(piece, length(piece, { units: 'miles' }) / 2, { units: 'miles' });
  return mid.geometry.coordinates as [number, number];
}

type Boundary = Feature<LineString | MultiLineString>[];

/** The polygon's rings as splitters (polygonToLine returns a FeatureCollection for a MultiPolygon). */
function boundaryOf(area: Feature<Polygon | MultiPolygon>): Boundary {
  const b = polygonToLine(area);
  return b.type === 'FeatureCollection' ? b.features : [b];
}

function splitBy(piece: Feature<LineString>, boundary: Boundary): Feature<LineString>[] {
  let pieces = [piece];
  for (const splitter of boundary) {
    // lineSplit returns nothing when the line never meets the splitter; keep the piece whole then.
    pieces = pieces.flatMap((p) => {
      const split = lineSplit(p, splitter).features;
      return split.length > 0 ? split : [p];
    });
  }
  return pieces.filter((f) => f.geometry.coordinates.length >= 2);
}

function bboxesIntersect(a: number[], b: number[]): boolean {
  return a[0]! <= b[2]! && a[2]! >= b[0]! && a[1]! <= b[3]! && a[3]! >= b[1]!;
}

const keyOf = (p: [number, number]) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

/**
 * Miles of line inside each polygon, by GEOID. A piece is credited to the polygon whose interior
 * holds its midpoint. A piece lying on a shared edge is credited once, to the first polygon (in
 * list order) whose boundary it touches, so no mile is counted twice.
 */
export function milesByPolygon(lines: Line[], polys: Poly[]): Map<string, number> {
  const out = new Map<string, number>();
  const polyBoxes = polys.map((p) => bbox(p));
  const boundaries = new Map<number, Boundary>(); // built lazily: most polygons never meet a line
  const boundaryFor = (i: number) => {
    let b = boundaries.get(i);
    if (!b) {
      b = boundaryOf(polys[i]!);
      boundaries.set(i, b);
    }
    return b;
  };
  const add = (geoid: string, miles: number) => out.set(geoid, (out.get(geoid) ?? 0) + miles);

  for (const line of lines) {
    const box = bbox(line);
    const candidates: number[] = [];
    polyBoxes.forEach((pb, i) => {
      if (bboxesIntersect(box, pb)) candidates.push(i);
    });
    if (candidates.length === 0) continue;

    for (const part of lineParts(line)) {
      const onEdge = new Set<string>(); // midpoints of edge pieces already credited
      for (const i of candidates) {
        const poly = polys[i]!;
        for (const piece of splitBy(part, boundaryFor(i))) {
          const mid = midpoint(piece);
          const miles = lineMiles(piece.geometry.coordinates as [number, number][]);
          if (booleanPointInPolygon(mid, poly, { ignoreBoundary: true })) {
            add(poly.properties.GEOID, miles);
          } else if (booleanPointInPolygon(mid, poly)) {
            const key = keyOf(mid);
            if (onEdge.has(key)) continue;
            onEdge.add(key);
            add(poly.properties.GEOID, miles);
          }
        }
      }
    }
  }
  return out;
}

/** Pieces of the lines whose midpoint lies outside `area` (a piece on its edge is kept). */
export function dropInside(lines: Line[], area: Feature<Polygon | MultiPolygon>): Feature<LineString>[] {
  const boundary = boundaryOf(area);
  const areaBox = bbox(area);
  const kept: Feature<LineString>[] = [];
  for (const line of lines) {
    const parts = lineParts(line);
    if (!bboxesIntersect(bbox(line), areaBox)) {
      kept.push(...parts);
      continue;
    }
    for (const part of parts) {
      for (const piece of splitBy(part, boundary)) {
        if (!booleanPointInPolygon(midpoint(piece), area, { ignoreBoundary: true })) kept.push(piece);
      }
    }
  }
  return kept;
}

type Class = '1' | '2' | '3' | '4';

/** Sum of per-class miles times per-class weight. */
export function weightedMiles(byClass: Record<Class, number>, weights: Record<Class, number>): number {
  return (['1', '2', '3', '4'] as const).reduce((sum, c) => sum + byClass[c] * weights[c], 0);
}
