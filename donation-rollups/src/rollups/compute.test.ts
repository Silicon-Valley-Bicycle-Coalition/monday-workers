import { describe, it, expect } from 'vitest';
import { computeRollup, currentFiscalYear, fiscalYearFromDate, localDateParts, type DonationRow } from './compute';

// SVBC's shipped config (config/svbc.json "fiscalYear"); the functions take it as a parameter.
const JULY_PACIFIC = { startMonth: 7, timeZone: 'America/Los_Angeles' };

describe('currentFiscalYear', () => {
  it('rolls July onward into next fiscal year', () => {
    expect(currentFiscalYear(new Date('2025-07-01T12:00:00Z'), JULY_PACIFIC)).toBe(2026);
    expect(currentFiscalYear(new Date('2025-12-31T20:00:00Z'), JULY_PACIFIC)).toBe(2026);
  });
  it('keeps January-June in the current fiscal year', () => {
    expect(currentFiscalYear(new Date('2026-01-01T12:00:00Z'), JULY_PACIFIC)).toBe(2026);
    expect(currentFiscalYear(new Date('2026-06-30T12:00:00Z'), JULY_PACIFIC)).toBe(2026);
  });

  // Issue #27: in UTC, "This Year" rolled over at 5pm Pacific on June 30.
  it('rolls over at midnight in the configured time zone, not at midnight UTC', () => {
    expect(currentFiscalYear(new Date('2026-07-01T00:00:00Z'), JULY_PACIFIC)).toBe(2026); // 5pm PDT June 30
    expect(currentFiscalYear(new Date('2026-07-01T06:59:59Z'), JULY_PACIFIC)).toBe(2026); // 11:59:59pm PDT
    expect(currentFiscalYear(new Date('2026-07-01T07:00:00Z'), JULY_PACIFIC)).toBe(2027); // midnight PDT July 1
  });

  it('honors a different start month and time zone from config', () => {
    const aprilLondon = { startMonth: 4, timeZone: 'Europe/London' };
    expect(currentFiscalYear(new Date('2026-03-31T22:59:59Z'), aprilLondon)).toBe(2026); // 11:59pm BST Mar 31
    expect(currentFiscalYear(new Date('2026-03-31T23:00:00Z'), aprilLondon)).toBe(2027); // midnight BST Apr 1
  });

  it('a January start makes the fiscal year the calendar year', () => {
    const calendar = { startMonth: 1, timeZone: 'UTC' };
    expect(currentFiscalYear(new Date('2026-01-01T00:00:00Z'), calendar)).toBe(2026);
    expect(currentFiscalYear(new Date('2026-12-31T23:59:59Z'), calendar)).toBe(2026);
  });
});

describe('fiscalYearFromDate', () => {
  it('applies the configured start month to a plain calendar date', () => {
    expect(fiscalYearFromDate('2026-06-30', 7)).toBe(2026);
    expect(fiscalYearFromDate('2026-07-01', 7)).toBe(2027);
    expect(fiscalYearFromDate('2026-07-01 00:00', 7)).toBe(2027);
    expect(fiscalYearFromDate('2026-03-31', 4)).toBe(2026);
    expect(fiscalYearFromDate('2026-04-01', 4)).toBe(2027);
    expect(fiscalYearFromDate('2026-12-31', 1)).toBe(2026);
  });
});

describe('localDateParts', () => {
  it('reads the calendar date in the given zone', () => {
    expect(localDateParts(new Date('2026-07-01T06:59:59Z'), 'America/Los_Angeles')).toEqual({ year: 2026, month: 6, day: 30 });
    expect(localDateParts(new Date('2026-07-01T07:00:00Z'), 'America/Los_Angeles')).toEqual({ year: 2026, month: 7, day: 1 });
  });
});

describe('computeRollup', () => {
  // Amounts in whole dollars for readability; rows carry integer cents.
  const row = (dollars: number, dateISO: string, fiscalYear: number, status = 'Received'): DonationRow =>
    ({ amountCents: Math.round(dollars * 100), dateISO, fiscalYear, status });
  const cents = (amountCents: number, dateISO = '2025-08-01'): DonationRow =>
    ({ amountCents, dateISO, fiscalYear: 2026, status: 'Received' });

  it('sums lifetime giving and gift count over Received rows only', () => {
    const r = computeRollup([
      row(100, '2024-01-01', 2024),
      row(50, '2024-06-01', 2024),
      row(999, '2024-03-01', 2024, 'Received (Historical)'), // excluded
      row(1, '2024-03-01', 2024, 'Failed'), // excluded
    ], 'Received', 2026);
    expect(r.lifetimeGivingCents).toBe(15000);
    expect(r.giftCount).toBe(2);
  });

  it('splits This Year / Last Year by fiscal year, not calendar year', () => {
    const r = computeRollup([
      row(100, '2025-08-01', 2026), // FY2026 = this year
      row(200, '2025-01-01', 2025), // FY2025 = last year
      row(300, '2020-01-01', 2020), // neither
    ], 'Received', 2026);
    expect(r.thisYearCents).toBe(10000);
    expect(r.thisYearCount).toBe(1);
    expect(r.lastYearCents).toBe(20000);
    expect(r.lastYearCount).toBe(1);
  });

  it('tracks first gift (earliest date) and last gift (latest date + its amount)', () => {
    const r = computeRollup([
      row(100, '2020-01-01', 2020),
      row(50, '2024-06-15', 2025),
      row(75, '2022-03-01', 2022),
    ], 'Received', 2026);
    expect(r.firstGiftISO).toBe('2020-01-01');
    expect(r.lastGiftDate).toBe('2024-06-15');
    expect(r.lastGiftCents).toBe(5000);
  });

  it('computes largest, smallest, and average gift', () => {
    const r = computeRollup([row(10, '2024-01-01', 2024), row(100, '2024-02-01', 2024), row(40, '2024-03-01', 2024)],
      'Received', 2026);
    expect(r.largestGiftCents).toBe(10000);
    expect(r.smallestGiftCents).toBe(1000);
    expect(r.averageGiftCents).toBe(5000);
  });

  it('returns nulls, not NaN or zero-that-looks-like-data, for a donor with no received gifts', () => {
    const r = computeRollup([row(50, '2024-01-01', 2024, 'Pending')], 'Received', 2026);
    expect(r).toEqual({
      lifetimeGivingCents: 0, giftCount: 0, firstGiftISO: null,
      thisYearCents: 0, thisYearCount: 0, lastYearCents: 0, lastYearCount: 0,
      largestGiftCents: null, smallestGiftCents: null, averageGiftCents: null,
      lastGiftDate: null, lastGiftCents: null,
    });
  });

  it('excludes "Received (Historical)" from lifetime giving — the migrated Closed Won records', () => {
    const r = computeRollup([row(500, '2015-01-01', 2015, 'Received (Historical)')], 'Received', 2026);
    expect(r.lifetimeGivingCents).toBe(0);
    expect(r.giftCount).toBe(0);
  });

  it('sums in integer cents — no float drift (issue #27: Monday showed 714.9300000000001)', () => {
    const r = computeRollup([cents(12345), cents(23456), cents(35692)], 'Received', 2026);
    expect(r.lifetimeGivingCents).toBe(71493);
    expect(r.thisYearCents).toBe(71493);
    expect(r.averageGiftCents).toBe(23831); // 71493 / 3
  });

  it('counts a negative (refund) gift against the totals', () => {
    const r = computeRollup([cents(10000, '2025-08-01'), cents(-2550, '2025-09-01')], 'Received', 2026);
    expect(r.lifetimeGivingCents).toBe(7450);
    expect(r.smallestGiftCents).toBe(-2550);
    expect(r.lastGiftCents).toBe(-2550);
  });

  it('rounds a fractional-cent average to a whole cent', () => {
    const r = computeRollup([cents(100), cents(100), cents(101)], 'Received', 2026);
    expect(r.averageGiftCents).toBe(100); // 100.33...
  });
});
