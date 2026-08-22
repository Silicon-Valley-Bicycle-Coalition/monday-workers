import { describe, it, expect } from 'vitest';
import { zonedTimeToUtc } from './zonedTime';

describe('zonedTimeToUtc', () => {
  it('converts a winter (PST, UTC-8) local time correctly', () => {
    // Jan 29, 2026, 7:00 PM Pacific Standard Time -> Jan 30, 2026, 03:00 UTC
    const result = zonedTimeToUtc(2026, 1, 29, 19, 0, 'America/Los_Angeles');
    expect(result.toISOString()).toBe('2026-01-30T03:00:00.000Z');
  });

  it('converts a summer (PDT, UTC-7) local time correctly', () => {
    // Aug 24, 2026, 6:30 PM Pacific Daylight Time -> Aug 25, 2026, 01:30 UTC
    const result = zonedTimeToUtc(2026, 8, 24, 18, 30, 'America/Los_Angeles');
    expect(result.toISOString()).toBe('2026-08-25T01:30:00.000Z');
  });

  it('resumes PST correctly the week after the November DST transition', () => {
    // DST ends Nov 1, 2026 in the US. Nov 9, 2026, 5:00 PM PST -> Nov 10, 2026, 01:00 UTC.
    const result = zonedTimeToUtc(2026, 11, 9, 17, 0, 'America/Los_Angeles');
    expect(result.toISOString()).toBe('2026-11-10T01:00:00.000Z');
  });
});
