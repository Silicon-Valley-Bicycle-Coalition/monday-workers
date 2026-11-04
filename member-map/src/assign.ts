// Point-to-block-group assignment. A bbox grid narrows each lookup to the few polygons whose
// bounding boxes touch the point's cell, so ~1,700 polygons are never all scanned per point.

import bbox from '@turf/bbox';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';

export interface BlockGroupIndex { find(lng: number, lat: number): string | null }

type BgFeature = Feature<Polygon | MultiPolygon, { GEOID: string }>;

// Degrees per grid cell; a block group is typically a few cells wide at most.
const CELL = 0.02;

const cellOf = (v: number): number => Math.floor(v / CELL);
const key = (cx: number, cy: number): string => `${cx},${cy}`;

export function buildIndex(fc: FeatureCollection<Polygon | MultiPolygon, { GEOID: string }>): BlockGroupIndex {
  const cells = new Map<string, BgFeature[]>();
  for (const feature of fc.features) {
    const [minX, minY, maxX, maxY] = bbox(feature);
    for (let cx = cellOf(minX); cx <= cellOf(maxX); cx++) {
      for (let cy = cellOf(minY); cy <= cellOf(maxY); cy++) {
        const k = key(cx, cy);
        const list = cells.get(k);
        if (list) list.push(feature); else cells.set(k, [feature]);
      }
    }
  }
  return {
    find(lng, lat) {
      for (const feature of cells.get(key(cellOf(lng), cellOf(lat))) ?? []) {
        if (booleanPointInPolygon([lng, lat], feature)) return feature.properties.GEOID;
      }
      return null;
    },
  };
}
