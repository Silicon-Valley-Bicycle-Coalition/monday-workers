import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAN_JOSE_CLASS_MAPPING, sanJoseClass } from './bike-classes.mjs';

test('the ported svbc-bike-lanes mapping maps all four classes', () => {
  assert.deepEqual(SAN_JOSE_CLASS_MAPPING, { 'Class 1': 1, 'Class 2': 2, 'Class 3': 3, 'Class 4': 4 });
  assert.equal(sanJoseClass('Class 1'), 1);
  assert.equal(sanJoseClass('Class 4'), 4);
});
test('a qualified class value maps by its "Class N" prefix', () => {
  assert.equal(sanJoseClass('Class 2 (Basic)'), 2);
  assert.equal(sanJoseClass('Class 2 (Buffered)'), 2);
  assert.equal(sanJoseClass('Class 3 (Sharrows)'), 3);
  assert.equal(sanJoseClass('Class 3 (Bike Blvd)'), 3);
});
test('blank or unknown classes map to null', () => {
  assert.equal(sanJoseClass(null), null);
  assert.equal(sanJoseClass(''), null);
  assert.equal(sanJoseClass('Class 5'), null);
  assert.equal(sanJoseClass('Class 10'), null);
});
