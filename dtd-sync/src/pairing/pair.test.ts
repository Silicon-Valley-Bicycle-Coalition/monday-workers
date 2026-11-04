import { describe, it, expect } from 'vitest';
import { MATCHING_GIFT_TYPE, normalizeCompany, pairMatch } from './pair';
import type { DonationItem } from '../monday/client';

const CFG = { windowMonths: 18, amountTolerance: 0.01 };

function gift(over: Partial<DonationItem> = {}): DonationItem {
  return {
    id: '1', amount: 100, date: '2026-09-01', status: 'Received', giftType: 'Donation', funraiseId: null,
    salesforceId: null, benevityTransactionId: null, anonymous: false, donorItemId: '900', matchedByItemId: null,
    matchesGiftItemId: null, matchPairing: null, matchStatus: null, sentToDtd: null, updatedAt: '', ...over,
  };
}
const match = gift({ id: '50', giftType: MATCHING_GIFT_TYPE, date: '2026-10-01', matchedByItemId: '700', benevityTransactionId: 'bv-1-match' });
const companies: Record<string, string> = { '1': 'Example Corp', '2': 'Example Corp', '3': 'Other Co' };
const companyOf = (id: string): string | null => companies[id] ?? null;

describe('normalizeCompany', () => {
  it('"Google, LLC" equals "Google"', () => {
    expect(normalizeCompany('Google, LLC')).toBe(normalizeCompany('Google'));
  });
  it('"Acme Co., Inc." equals "Acme"', () => {
    expect(normalizeCompany('Acme Co., Inc.')).toBe('acme');
  });
});

describe('pairMatch', () => {
  it('pairs a same-row Benevity match as certain', () => {
    const r = pairMatch(match, null, [gift({ id: '9', benevityTransactionId: 'bv-1' }), gift({ id: '1' })], companyOf, CFG);
    expect(r).toEqual({ kind: 'certain', giftItemId: '9' });
  });

  it('pairs the only same-company gift as auto', () => {
    const r = pairMatch({ ...match, benevityTransactionId: null }, 'Example Corp, Inc.', [gift({ id: '1' }), gift({ id: '3' })], companyOf, CFG);
    expect(r).toEqual({ kind: 'auto', giftItemId: '1' });
  });

  it('a match with no amount → review, though a same-row Benevity match stays certain', () => {
    const noAmount = { ...match, amount: null, benevityTransactionId: null };
    expect(pairMatch(noAmount, 'Example Corp', [gift({ id: '1' })], companyOf, CFG)).toEqual({ kind: 'review', candidates: ['1'] });
    const certain = pairMatch({ ...match, amount: null }, null, [gift({ id: '9', benevityTransactionId: 'bv-1' })], companyOf, CFG);
    expect(certain).toEqual({ kind: 'certain', giftItemId: '9' });
  });
  it('two candidates → review', () => {
    const r = pairMatch(match, 'Example Corp', [gift({ id: '1' }), gift({ id: '2' })], companyOf, CFG);
    expect(r).toEqual({ kind: 'review', candidates: ['1', '2'] });
  });

  it('no candidates → review', () => {
    expect(pairMatch(match, 'Example Corp', [], companyOf, CFG)).toEqual({ kind: 'review', candidates: [] });
    expect(pairMatch(match, null, [gift({ id: '1' })], companyOf, CFG)).toEqual({ kind: 'review', candidates: [] });
  });

  it('ignores other Matching Donations as candidates', () => {
    const other = gift({ id: '2', giftType: MATCHING_GIFT_TYPE });
    expect(pairMatch(match, 'Example Corp', [gift({ id: '1' }), other], companyOf, CFG)).toEqual({ kind: 'auto', giftItemId: '1' });
  });

  it('excludes gifts that are too small, too old or after the match', () => {
    const small = gift({ id: '1', amount: 50 });
    const old = gift({ id: '2', date: '2025-01-01' });
    const after = gift({ id: '3', date: '2026-10-02' });
    const r = pairMatch(match, 'Example Corp', [small, old, after], (id) => (id === '3' ? 'Example Corp' : 'Example Corp'), CFG);
    expect(r).toEqual({ kind: 'review', candidates: [] });
  });
});
