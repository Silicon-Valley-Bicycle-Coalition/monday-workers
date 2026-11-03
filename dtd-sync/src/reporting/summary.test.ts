import { describe, it, expect } from 'vitest';
import { computeSummary, fiscalYearBounds, fiscalYearOf } from './summary';
import type { StoredRecord } from '../db/records';
import type { DonationItem } from '../monday/client';

function rec(over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    donationIdentifier: 'monday-1', mondayItemId: '1', source: null, status: ':in-progress', matchingGiftStatus: null,
    employerStatus: ':complete', companyId: null, companyName: null, matchedAmount: null,
    donationDatetime: '2026-09-01T00:00:00Z', updatedSeenAt: '', unmatched: false, donorEmailHash: null, donationAmount: null, ...over,
  };
}
function match(over: Partial<DonationItem> = {}): DonationItem {
  return {
    id: '50', amount: 100, date: '2026-10-01', status: 'Received', giftType: 'Matching Donation', funraiseId: null,
    salesforceId: null, benevityTransactionId: null, anonymous: false, donorItemId: '900', matchedByItemId: '700',
    matchesGiftItemId: null, matchPairing: null, matchStatus: null, sentToDtd: null, updatedAt: '', ...over,
  };
}
const none = new Set<string>();
const sum = (r: StoredRecord[], m: DonationItem[] = [], g = new Map<string, number>(), c = none, d = none) =>
  computeSummary(r, m, g, c, d);

describe('fiscal years', () => {
  it('FY boundaries: 2026-06-30 is FY2026, 2026-07-01 is FY2027', () => {
    expect(fiscalYearOf('2026-06-30')).toBe('FY2026');
    expect(fiscalYearOf('2026-07-01')).toBe('FY2027');
    expect(fiscalYearOf('2026-11-03T12:00:00Z')).toBe('FY2027');
  });
  it('bounds are half-open July 1 UTC', () => {
    expect(fiscalYearBounds('FY2027')).toEqual({ startISO: '2026-07-01T00:00:00.000Z', endISO: '2027-07-01T00:00:00.000Z' });
  });
});

describe('computeSummary', () => {
  it('screened counts every record', () => {
    expect(sum([rec(), rec({ donationIdentifier: 'b' })]).screened).toBe(2);
  });
  it('employerIdentified counts :complete employers', () => {
    expect(sum([rec(), rec({ employerStatus: ':unknown' }), rec({ employerStatus: null })]).employerIdentified).toBe(1);
  });
  it('eligible excludes ineligible statuses and unidentified employers', () => {
    const r = [
      rec(),
      rec({ status: ':ineligible' }),
      rec({ status: ':closed-program-eligibility' }),
      rec({ status: ':closed-no-matching-gift-program' }),
      rec({ status: ':unknown-employer' }),
      rec({ employerStatus: ':incomplete' }),
    ];
    expect(sum(r).eligible).toBe(1);
  });
  it('eligible reads matching_gift_status before status, like pull', () => {
    const r = [
      rec({ status: ':in-progress', matchingGiftStatus: ':ineligible' }),
      rec({ status: ':in-progress', matchingGiftStatus: ':closed-no-matching-gift-program' }),
      rec({ status: ':ineligible', matchingGiftStatus: ':waiting-for-verification' }),
    ];
    expect(sum(r).eligible).toBe(1);
  });
  it('submitted counts waiting-for-verification or paired, once each', () => {
    const r = [
      rec({ mondayItemId: '1', matchingGiftStatus: ':waiting-for-verification' }),
      rec({ mondayItemId: '2' }),
      rec({ mondayItemId: '3', matchingGiftStatus: ':waiting-for-verification' }),
      rec({ mondayItemId: '4' }),
    ];
    const m = [match({ matchesGiftItemId: '2' }), match({ id: '51', matchesGiftItemId: '3' })];
    expect(sum(r, m).submitted).toBe(3);
  });
  it('matchesPaid and matchDollars cover the FY matches, rounded to cents', () => {
    const s = sum([], [match({ amount: 10.1 }), match({ id: '51', amount: 20.2 }), match({ id: '52', amount: null })]);
    expect(s.matchesPaid).toBe(3);
    expect(s.matchDollars).toBe(30.3);
  });
  it('matchedGiftDollars sums the paired gifts', () => {
    const g = new Map([['1', 50.5], ['2', 25.25]]);
    const m = [match({ matchesGiftItemId: '1' }), match({ id: '51', matchesGiftItemId: '2' }), match({ id: '52' })];
    expect(sum([], m, g).matchedGiftDollars).toBe(75.75);
  });
  it('newMatchingCompanies counts distinct companies not seen before', () => {
    const m = [match(), match({ id: '51' }), match({ id: '52', matchedByItemId: '701' }), match({ id: '53', matchedByItemId: '702' }), match({ id: '54', matchedByItemId: null })];
    expect(sum([], m, new Map(), new Set(['701'])).newMatchingCompanies).toBe(2);
  });
  it('firstTimeMatchedDonors counts distinct donors not matched before', () => {
    const m = [match(), match({ id: '51' }), match({ id: '52', donorItemId: '901' }), match({ id: '53', donorItemId: '902' }), match({ id: '54', donorItemId: null })];
    expect(sum([], m, new Map(), none, new Set(['902'])).firstTimeMatchedDonors).toBe(2);
  });
});
