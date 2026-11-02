import { describe, expect, it } from 'vitest';
import type { Feature, LineString, MultiLineString, MultiPolygon, Polygon } from 'geojson';
import { dropInside, lineMiles, milesByPolygon, weightedMiles, type Poly } from './lines';

function square(geoid: string, x0: number, x1: number): Poly {
  return {
    type: 'Feature',
    properties: { GEOID: geoid },
    geometry: { type: 'Polygon', coordinates: [[[x0, 0], [x1, 0], [x1, 0.01], [x0, 0.01], [x0, 0]]] },
  };
}
const A = square('A', 0, 0.01);
const B = square('B', 0.01, 0.02);

function line(coords: [number, number][]): Feature<LineString> {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
}

describe('lineMiles', () => {
  it('matches haversine for 0.01 degrees of latitude', () => {
    expect(lineMiles([[0, 0], [0, 0.01]])).toBeCloseTo(0.6909, 3);
  });
});

describe('milesByPolygon', () => {
  it('splits a line crossing the shared edge between both squares', () => {
    const m = milesByPolygon([line([[0.005, 0.005], [0.015, 0.005]])], [A, B]);
    expect(m.get('A')).toBeCloseTo(lineMiles([[0.005, 0.005], [0.01, 0.005]]), 4);
    expect(m.get('B')).toBeCloseTo(lineMiles([[0.01, 0.005], [0.015, 0.005]]), 4);
  });

  it('totals equal the line length when fully covered', () => {
    const coords: [number, number][] = [[0.002, 0.003], [0.012, 0.007], [0.018, 0.002]];
    const m = milesByPolygon([line(coords)], [A, B]);
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(lineMiles(coords), 4);
  });

  it('counts a line lying along the shared edge exactly once', () => {
    const coords: [number, number][] = [[0.01, 0.002], [0.01, 0.008]];
    const m = milesByPolygon([line(coords)], [A, B]);
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(lineMiles(coords), 6);
    expect(m.size).toBe(1);
  });

  it('adds nothing for a line outside every polygon', () => {
    const m = milesByPolygon([line([[1, 1], [1.01, 1]])], [A, B]);
    expect(m.size).toBe(0);
  });

  it('handles MultiLineString', () => {
    const ml: Feature<MultiLineString> = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [[0.002, 0.005], [0.008, 0.005]],
          [[0.012, 0.005], [0.018, 0.005]],
        ],
      },
    };
    const m = milesByPolygon([ml], [A, B]);
    expect(m.get('A')).toBeCloseTo(lineMiles([[0.002, 0.005], [0.008, 0.005]]), 4);
    expect(m.get('B')).toBeCloseTo(lineMiles([[0.012, 0.005], [0.018, 0.005]]), 4);
  });

  it('handles a MultiPolygon block group', () => {
    const mp: Feature<MultiPolygon, { GEOID: string }> = {
      type: 'Feature',
      properties: { GEOID: 'M' },
      geometry: { type: 'MultiPolygon', coordinates: [A.geometry.coordinates as Polygon['coordinates']] },
    };
    const m = milesByPolygon([line([[0.002, 0.005], [0.008, 0.005]])], [mp]);
    expect(m.get('M')).toBeCloseTo(lineMiles([[0.002, 0.005], [0.008, 0.005]]), 4);
  });
});

describe('dropInside', () => {
  it('removes only the part inside the area', () => {
    const area: Feature<Polygon> = { type: 'Feature', properties: {}, geometry: A.geometry as Polygon };
    const pieces = dropInside([line([[0.005, 0.005], [0.015, 0.005]])], area);
    expect(pieces).toHaveLength(1);
    const c = pieces[0]!.geometry.coordinates;
    expect(c[0]![0]).toBeCloseTo(0.01, 6);
    expect(c[c.length - 1]![0]).toBeCloseTo(0.015, 6);
  });
});

describe('weightedMiles', () => {
  it('applies the class weights', () => {
    expect(
      weightedMiles({ '1': 1, '2': 2, '3': 5, '4': 1 }, { '1': 1, '2': 0.5, '3': 0.2, '4': 1 }),
    ).toBeCloseTo(4, 6);
  });
});
