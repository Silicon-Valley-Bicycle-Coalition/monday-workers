import { describe, it, expect } from 'vitest';
import { toISODate } from './isoDate';

// Eventbrite sends `created` as an ISO UTC timestamp; epoch milliseconds are kept for parity with
// funraise-sync's copy. Monday's date column and the fiscal-year rule both want a YYYY-MM-DD.
describe('toISODate', () => {
  it('converts epoch milliseconds to the calendar date in SVBC\'s time zone', () => {
    expect(toISODate(1599067880174)).toBe('2020-09-02');
  });

  it('accepts epoch milliseconds as a numeric string', () => {
    expect(toISODate('1599067880174')).toBe('2020-09-02');
  });

  // #25: dates were the UTC day, so a gift after ~5 pm Pacific on June 30 or Dec 31 landed in
  // the next fiscal/calendar year, disagreeing with migrated Salesforce CloseDates (a local date).
  it('dates an evening-Pacific gift on June 30 as June 30, not July 1 (fiscal-year boundary, PDT)', () => {
    // 2026-06-30 18:30 PDT = 2026-07-01T01:30:00Z
    expect(toISODate(Date.parse('2026-07-01T01:30:00Z'))).toBe('2026-06-30');
  });

  it('dates an evening-Pacific gift on Dec 31 as Dec 31, not Jan 1 (calendar-year boundary, PST)', () => {
    // 2025-12-31 20:00 PST = 2026-01-01T04:00:00Z
    expect(toISODate(Date.parse('2026-01-01T04:00:00Z'))).toBe('2025-12-31');
  });

  it('rolls over at Pacific midnight, not UTC midnight', () => {
    expect(toISODate(Date.parse('2026-07-01T06:59:59Z'))).toBe('2026-06-30');
    expect(toISODate(Date.parse('2026-07-01T07:00:00Z'))).toBe('2026-07-01');
  });

  it('keeps a bare date as-is and converts a full ISO timestamp to the Pacific date', () => {
    expect(toISODate('2026-06-30')).toBe('2026-06-30');
    expect(toISODate('2026-08-15T18:30:12.000Z')).toBe('2026-08-15');
    expect(toISODate('2026-07-01T01:30:00.000Z')).toBe('2026-06-30');
    expect(toISODate('2026-06-30T18:30:00-07:00')).toBe('2026-06-30');
  });

  it('returns null for anything that is not a date', () => {
    expect(toISODate(undefined)).toBeNull();
    expect(toISODate(null)).toBeNull();
    expect(toISODate('not a date')).toBeNull();
    expect(toISODate(Number.NaN)).toBeNull();
    expect(toISODate({})).toBeNull();
  });
});
