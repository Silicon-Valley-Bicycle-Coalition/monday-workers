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
  const row = (amount: number, dateISO: string, fiscalYear: number, status = 'Received'): DonationRow =>
    ({ amount, dateISO, fiscalYear, status });

  it('sums lifetime giving and gift count over Received rows only', () => {
    const r = computeRollup([
      row(100, '2024-01-01', 2024),
      row(50, '2024-06-01', 2024),
      row(999, '2024-03-01', 2024, 'Received (Historical)'), // excluded
      row(1, '2024-03-01', 2024, 'Failed'), // excluded
    ], 'Received', 2026);
    expect(r.lifetimeGiving).toBe(150);
    expect(r.giftCount).toBe(2);
  });

  it('splits This Year / Last Year by fiscal year, not calendar year', () => {
    const r = computeRollup([
      row(100, '2025-08-01', 2026), // FY2026 = this year
      row(200, '2025-01-01', 2025), // FY2025 = last year
      row(300, '2020-01-01', 2020), // neither
    ], 'Received', 2026);
    expect(r.thisYearAmount).toBe(100);
    expect(r.thisYearCount).toBe(1);
    expect(r.lastYearAmount).toBe(200);
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
    expect(r.lastGiftAmount).toBe(50);
  });

  it('computes largest, smallest, and average gift', () => {
    const r = computeRollup([row(10, '2024-01-01', 2024), row(100, '2024-02-01', 2024), row(40, '2024-03-01', 2024)],
      'Received', 2026);
    expect(r.largestGift).toBe(100);
    expect(r.smallestGift).toBe(10);
    expect(r.averageGift).toBeCloseTo(50);
  });

  it('returns nulls, not NaN or zero-that-looks-like-data, for a donor with no received gifts', () => {
    const r = computeRollup([row(50, '2024-01-01', 2024, 'Pending')], 'Received', 2026);
    expect(r).toEqual({
      lifetimeGiving: 0, giftCount: 0, firstGiftISO: null,
      thisYearAmount: 0, thisYearCount: 0, lastYearAmount: 0, lastYearCount: 0,
      largestGift: null, smallestGift: null, averageGift: null,
      lastGiftDate: null, lastGiftAmount: null,
    });
  });

  it('excludes "Received (Historical)" from lifetime giving — the migrated Closed Won records', () => {
    const r = computeRollup([row(500, '2015-01-01', 2015, 'Received (Historical)')], 'Received', 2026);
    expect(r.lifetimeGiving).toBe(0);
    expect(r.giftCount).toBe(0);
  });
});
