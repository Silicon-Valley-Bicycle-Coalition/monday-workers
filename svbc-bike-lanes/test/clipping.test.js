const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBoundaryIndex, attributePolyline, haversineDistance } = require('../_data/clipping');

// A one-degree-square county, its western half a city.
const square = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const index = buildBoundaryIndex(
  { Test: { name: 'Test', rings: square(0, 0, 1, 1) } },
  [{ name: 'Westville', county: 'Test', polygons: [square(0, 0, 0.5, 1)] }]
);

const byPlace = parts => Object.fromEntries(parts.map(p => [`${p.county}/${p.city}`, p.miles]));

test('a segment crossing the county is cut at each boundary and the outside part dropped', () => {
  const parts = byPlace(attributePolyline([[[-0.5, 0.5], [1.5, 0.5]]], index));
  const half = haversineDistance(0.5, 0, 0.5, 0.5);

  assert.deepEqual(Object.keys(parts).sort(), ['Test/Unincorporated', 'Test/Westville']);
  assert.ok(Math.abs(parts['Test/Westville'] - half) < 1e-6);
  assert.ok(Math.abs(parts['Test/Unincorporated'] - half) < 1e-6);
});

test('a segment entirely outside every county counts nothing', () => {
  assert.deepEqual(attributePolyline([[[2, 2], [3, 3]]], index), []);
});

test('a multi-vertex path inside one city is counted once, in full', () => {
  const path = [[0.1, 0.1], [0.1, 0.4], [0.4, 0.4]];
  const parts = byPlace(attributePolyline([path], index));
  const expected = haversineDistance(0.1, 0.1, 0.4, 0.1) + haversineDistance(0.4, 0.1, 0.4, 0.4);

  assert.deepEqual(Object.keys(parts), ['Test/Westville']);
  assert.ok(Math.abs(parts['Test/Westville'] - expected) < 1e-6);
});
