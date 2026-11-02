import { describe, expect, it } from 'vitest';
import { classify, populationRate, quantile } from './score';

describe('classify', () => {
  it('low-is-gap: bottom fifth is 3, top 40% unshaded', () =>
    expect(classify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'low-is-gap')).toEqual([3, 3, 2, 2, 1, 1, 0, 0, 0, 0]));
  it('high-is-gap mirrors it', () =>
    expect(classify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'high-is-gap')).toEqual([0, 0, 0, 0, 1, 1, 2, 2, 3, 3]));
  it('nulls stay null and do not move the breaks', () =>
    expect(classify([null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null], 'low-is-gap')).toEqual([
      null, 3, 3, 2, 2, 1, 1, 0, 0, 0, 0, null,
    ]));
  it('zero warm leads is never a gap', () =>
    expect(classify([0, 0, 0, 0, 0, 0, 0, 0, 1, 2], 'high-is-gap').slice(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]));
  it('many zero-member block groups all land in the worst class', () =>
    expect(classify([0, 0, 0, 0, 0, 1, 2, 3, 4, 5], 'low-is-gap').slice(0, 5)).toEqual([3, 3, 3, 3, 3]));
  it('all-null input', () => expect(classify([null, null], 'low-is-gap')).toEqual([null, null]));
  it('empty input', () => expect(classify([], 'low-is-gap')).toEqual([]));
});

describe('populationRate', () => {
  it('is per 1,000 and null under the minimum', () => {
    expect(populationRate(6, 4200, 100)).toBeCloseTo(1.4286, 4);
    expect(populationRate(3, 99, 100)).toBeNull();
  });
  it('is computed at exactly the minimum', () => expect(populationRate(1, 100, 100)).toBeCloseTo(10, 6));
});

describe('quantile', () => {
  it('interpolates linearly (type 7)', () => {
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.2)).toBeCloseTo(2.8, 10);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
  it('hits the endpoints', () => {
    expect(quantile([3, 9], 0)).toBe(3);
    expect(quantile([3, 9], 1)).toBe(9);
  });
  it('handles a single value', () => expect(quantile([7], 0.4)).toBe(7));
});
