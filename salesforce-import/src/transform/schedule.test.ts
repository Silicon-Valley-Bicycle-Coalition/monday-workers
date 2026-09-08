import { describe, it, expect } from 'vitest';
import { donationArchivePlan, shouldArchive, fiscalYearLoadOrder } from './schedule.js';
import type { ItemPayload } from './types.js';

const gift = (fy: string | null): ItemPayload => ({
  board: 'donations', sfId: `o-${fy ?? 'x'}-${Math.floor(Math.random() * 1e9)}`, name: 'g',
  columns: { 'Fiscal Year Ending': fy ?? '' },
});

describe('donationArchivePlan', () => {
  // cutover 2026-10-01 → FY2027; activeFiscalYears 2 → FY2026+ stay active.
  it('keeps the retention window active and flags everything older', () => {
    const donations = [gift('2015'), gift('2026'), gift('2027')];
    const plan = donationArchivePlan(donations, '2026-10-01', 2);
    expect(plan.cutoffFY).toBe(2026);
    expect(shouldArchive(donations[0]!, plan)).toBe(true);
    expect(shouldArchive(donations[1]!, plan)).toBe(false);
    expect(shouldArchive(donations[2]!, plan)).toBe(false);
  });

  it('archives undated gifts and retains future-dated ones', () => {
    const undated = gift(null);
    const future = gift('2031');
    const plan = donationArchivePlan([undated, future], '2026-10-01', 2);
    expect(shouldArchive(undated, plan)).toBe(true);
    expect(shouldArchive(future, plan)).toBe(false);
  });

  it('peak active is max(largest archived year, total retained)', () => {
    const donations = [
      ...Array.from({ length: 5 }, () => gift('2015')), // archived batch of 5
      ...Array.from({ length: 2 }, () => gift('2020')), // archived batch of 2
      ...Array.from({ length: 3 }, () => gift('2026')), // retained
      ...Array.from({ length: 1 }, () => gift('2027')), // retained
    ];
    expect(donationArchivePlan(donations, '2026-10-01', 2).peakActive).toBe(5);
    // With a bigger retention window the retained sum dominates.
    expect(donationArchivePlan(donations, '2026-10-01', 20).peakActive).toBe(11);
  });

  it('throws on a malformed cutover date', () => {
    expect(() => donationArchivePlan([], 'nope', 2)).toThrow(/cutoverDateISO/);
  });
});

describe('fiscalYearLoadOrder', () => {
  it('sorts undated first, then fiscal years ascending', () => {
    expect(fiscalYearLoadOrder(['2027', '', '2015', '2020'])).toEqual(['', '2015', '2020', '2027']);
  });
});
