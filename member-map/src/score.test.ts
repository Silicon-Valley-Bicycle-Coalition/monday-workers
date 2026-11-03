import { describe, expect, it } from 'vitest';
import { classify, populationGapClasses, populationRate, quantile } from './score';

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
  it('ties at a break all take the worse class', () =>
    expect(classify([0, 0, 0, 0, 0, 1, 2, 3, 4, 5], 'low-is-gap').slice(0, 5)).toEqual([3, 3, 3, 3, 3]));
  it('all-null input', () => expect(classify([null, null], 'low-is-gap')).toEqual([null, null]));
  it('empty input', () => expect(classify([], 'low-is-gap')).toEqual([]));
});

const bg = (members: number, population: number) => ({ members, population });

describe('populationGapClasses', () => {
  it('distinct rates: lowest fifth is 3, top 40% unshaded', () =>
    expect(populationGapClasses([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((m) => bg(m, 1000)), 100)).toEqual([
      3, 3, 2, 2, 1, 1, 0, 0, 0, 0,
    ]));
  it('ranks zero-member block groups by population, biggest first', () =>
    expect(populationGapClasses([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((p) => bg(0, p)), 100)).toEqual([
      1, 1, 1, 1, 1, 1, 2, 2, 3, 3,
    ]));
  it('a zero-member block group is never unshaded', () =>
    expect(populationGapClasses([bg(0, 150), bg(0, 5000), bg(0, 4000), bg(0, 3000), bg(0, 2000)], 100)[0]).toBe(1));
  it('zero-member block groups outrank any with members', () =>
    expect(populationGapClasses([bg(1, 5000), bg(0, 120), bg(5, 1000), bg(6, 1000), bg(7, 1000)], 100).slice(0, 2)).toEqual([2, 3]));
  it('equal rates: more residents is the bigger gap', () =>
    expect(populationGapClasses([bg(1, 1000), bg(2, 2000), bg(3, 3000), bg(9, 1000), bg(9, 1000)], 100).slice(0, 3)).toEqual([1, 2, 3]));
  it('under the minimum is null and does not take a rank', () =>
    expect(populationGapClasses([bg(0, 99), bg(1, 1000), bg(2, 1000), bg(3, 1000), bg(4, 1000), bg(5, 1000)], 100)).toEqual([
      null, 3, 2, 1, 0, 0,
    ]));
  it('empty input', () => expect(populationGapClasses([], 100)).toEqual([]));
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
