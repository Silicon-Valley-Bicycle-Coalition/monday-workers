import { describe, it, expect } from 'vitest';
import { toISODate } from './isoDate';

// Funraise sends dates as epoch milliseconds (`donationDate: 1599067880174` in its documented
// webhook example); Monday's date column and the fiscal-year rule both want a YYYY-MM-DD.
describe('toISODate', () => {
  it('converts epoch milliseconds to the UTC calendar date', () => {
    expect(toISODate(1599067880174)).toBe('2020-09-02');
  });

  it('accepts epoch milliseconds as a numeric string', () => {
    expect(toISODate('1599067880174')).toBe('2020-09-02');
  });

  it('keeps the date prefix of an ISO timestamp', () => {
    expect(toISODate('2026-08-15T18:30:12.000Z')).toBe('2026-08-15');
    expect(toISODate('2026-06-30')).toBe('2026-06-30');
  });

  it('returns null for anything that is not a date', () => {
    expect(toISODate(undefined)).toBeNull();
    expect(toISODate(null)).toBeNull();
    expect(toISODate('not a date')).toBeNull();
    expect(toISODate(Number.NaN)).toBeNull();
    expect(toISODate({})).toBeNull();
  });
});
