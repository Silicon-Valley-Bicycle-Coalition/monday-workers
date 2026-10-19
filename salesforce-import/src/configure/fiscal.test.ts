import { describe, it, expect } from 'vitest';
import { fiscalYearEnding, fiscalYearLabel, fiscalYearRange, isFiscalYearValue, pacificDate } from './fiscal.js';

const at = (iso: string) => new Date(iso);

describe('fiscal year', () => {
  it('labels the year by the calendar year it ends in', () => {
    expect(fiscalYearLabel(at('2026-10-14T12:00:00Z'))).toBe('FY2027');
    expect(fiscalYearLabel(at('2026-10-14T12:00:00Z'), -1)).toBe('FY2026');
    expect(fiscalYearLabel(at('2027-03-01T12:00:00Z'))).toBe('FY2027');
    expect(fiscalYearEnding(at('2026-10-14T12:00:00Z'), 1)).toBe(2028);
  });

  it('returns the July-to-June range, inclusive of both ends', () => {
    expect(fiscalYearRange(at('2026-10-14T12:00:00Z'))).toEqual(['2026-07-01', '2027-06-30']);
    expect(fiscalYearRange(at('2026-10-14T12:00:00Z'), -1)).toEqual(['2025-07-01', '2026-06-30']);
  });

  it('follows Pacific time at the July 1 boundary (Review Focus 5)', () => {
    expect(fiscalYearLabel(at('2026-07-01T06:59:59Z'))).toBe('FY2026'); // 23:59:59 PDT, June 30
    expect(fiscalYearLabel(at('2026-07-01T07:00:00Z'))).toBe('FY2027'); // 00:00:00 PDT, July 1
  });

  it('reads a Pacific date in winter too, where California is UTC-8', () => {
    expect(pacificDate(at('2027-01-01T07:59:59Z'))).toBe('2026-12-31');
    expect(pacificDate(at('2027-01-01T08:00:00Z'))).toBe('2027-01-01');
  });

  it('recognises only the two fiscal-year compare values', () => {
    expect(isFiscalYearValue({ fiscalYear: 'current' })).toBe(true);
    expect(isFiscalYearValue({ fiscalYear: 'previous' })).toBe(true);
    expect(isFiscalYearValue({ fiscalYear: 'next' })).toBe(false);
    expect(isFiscalYearValue(['DAYS', 60])).toBe(false);
    expect(isFiscalYearValue(null)).toBe(false);
  });
});
