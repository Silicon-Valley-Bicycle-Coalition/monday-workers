import { describe, it, expect } from 'vitest';
import { computeRollup, currentFiscalYear, type DonationRow } from './compute';

describe('currentFiscalYear', () => {
  it('rolls July onward into next fiscal year', () => {
    expect(currentFiscalYear(new Date('2025-07-01T00:00:00Z'))).toBe(2026);
    expect(currentFiscalYear(new Date('2025-12-31T23:59:59Z'))).toBe(2026);
  });
  it('keeps January-June in the current fiscal year', () => {
    expect(currentFiscalYear(new Date('2026-01-01T00:00:00Z'))).toBe(2026);
    expect(currentFiscalYear(new Date('2026-06-30T00:00:00Z'))).toBe(2026);
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
