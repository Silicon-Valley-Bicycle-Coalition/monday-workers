import { describe, expect, it } from 'vitest';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { buildIndex } from './assign';

const sq = (x: number, y: number, s: number): number[][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];

const fc: FeatureCollection<Polygon | MultiPolygon, { GEOID: string }> = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { GEOID: 'A' }, geometry: { type: 'Polygon', coordinates: [sq(0, 0, 0.01)] } },
    { type: 'Feature', properties: { GEOID: 'B' }, geometry: { type: 'Polygon', coordinates: [sq(0.01, 0, 0.01)] } },
    {
      type: 'Feature', properties: { GEOID: 'M' },
      geometry: { type: 'MultiPolygon', coordinates: [[sq(0.5, 0.5, 0.1), sq(0.53, 0.53, 0.02)], [sq(0.8, 0.8, 0.05)]] },
    },
  ],
};
const idx = buildIndex(fc);

describe('buildIndex', () => {
  it('finds the containing block group', () => {
    expect(idx.find(0.005, 0.005)).toBe('A');
    expect(idx.find(0.015, 0.005)).toBe('B');
  });
  it('returns null outside', () => expect(idx.find(1, 1)).toBeNull());
  it('handles MultiPolygon and holes', () => {
    expect(idx.find(0.52, 0.52)).toBe('M'); // in the outer ring, outside the hole
    expect(idx.find(0.54, 0.54)).toBeNull(); // inside the hole
    expect(idx.find(0.82, 0.82)).toBe('M'); // second polygon of the multi
  });
  it('finds a point in a polygon spanning several grid cells', () => {
    const big = buildIndex({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { GEOID: 'Z' }, geometry: { type: 'Polygon', coordinates: [sq(10, 10, 1)] } }],
    });
    expect(big.find(10.95, 10.95)).toBe('Z');
    expect(big.find(10.5, 10.5)).toBe('Z');
    expect(big.find(11.05, 10.5)).toBeNull();
  });
});
