import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreCollapsed } from './simplify.mjs';

const line = (coordinates, geometry = { type: 'LineString', coordinates }) => ({
  type: 'Feature', properties: { class: 2 }, geometry,
});
const loop = [[-121.9, 37.3], [-121.9012345678, 37.3], [-121.9, 37.301], [-121.9, 37.3]];

test('a simplified line is left as mapshaper wrote it', () => {
  const kept = line([[-121.9, 37.3], [-121.8, 37.4]]);
  assert.deepEqual(restoreCollapsed([kept], [line(loop)]), [kept]);
});

test('a collapsed loop comes back as its source line, rounded to 6 decimals', () => {
  assert.deepEqual(restoreCollapsed([line(null, null)], [line(loop)]), [
    line([[-121.9, 37.3], [-121.901235, 37.3], [-121.9, 37.301], [-121.9, 37.3]]),
  ]);
});

test('a collapsed line that rounds to one point is dropped', () => {
  const tiny = line([[-121.9, 37.3], [-121.90000001, 37.3]]);
  assert.deepEqual(restoreCollapsed([line(null, null)], [tiny]), []);
});

test('lists that do not line up throw', () => {
  assert.throws(() => restoreCollapsed([], [line(loop)]), /0 features for 1 lines/);
});
