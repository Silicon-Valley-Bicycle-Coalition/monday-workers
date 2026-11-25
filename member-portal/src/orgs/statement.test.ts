import { describe, it, expect } from 'vitest';
import { buildStatement, statementYears } from './statement';
import type { OrgGift } from '../monday/client';
import type { TaxLetterConfig } from '../types';

const taxLetter: TaxLetterConfig = {
  orgLegalName: 'SVBC', ein: '00-0000000', officeAddress: 'addr',
  signatureName: 'Alex', signatureTitle: 'ED',
  plainStatement: 'PLAIN-STATEMENT', benefitStatement: 'BENEFIT-STATEMENT',
  benefitTiers: [],
  acknowledgedGiftTypes: ['Donation', 'Foundation & Corporate Gifts'],
  excludedGiftTypes: ['Event Ticket', 'Sponsorship', 'Matching Donation', 'Grants', 'Contracts'],
  separateGiftTypes: ['Donor Advised Fund'],
  separateGiftsStatement: 'SEPARATE-STATEMENT',
};
const org = { id: 'o1', name: 'Acme', address: '1 Main St' };

function gift(itemId: string, date: string, amount: string, giftType: string): OrgGift {
  return { itemId, date, amount, giftType };
}

function build(over: Partial<Parameters<typeof buildStatement>[0]> = {}) {
  return buildStatement({
    org, year: 2026, gifts: [], matches: [], volunteerHoursByPerson: null, employeeIds: [],
    taxLetter, volunteerFloor: 3, acknowledgmentOn: true, ...over,
  });
}

describe('buildStatement', () => {
  it('returns null when the year has nothing', () => {
    expect(build({ gifts: [gift('1', '2025-03-01', '$10.00', 'Donation')] })).toBeNull();
    expect(build()).toBeNull();
  });

  it('groups by Gift Type with subtotals, in date order', () => {
    const s = build({
      gifts: [
        gift('2', '2026-05-01', '$200.00', 'Sponsorship'),
        gift('1', '2026-02-01', '$100.00', 'Donation'),
        gift('3', '2026-03-01', '$50.00', ' Donation '),
        gift('4', '2026-04-01', '$5.00', ''),
      ],
    })!;
    expect(s.groups.map((g) => [g.label, g.subtotal])).toEqual([
      ['Donation', '$150.00'], ['Other', '$5.00'], ['Sponsorship', '$200.00'],
    ]);
    expect(s.groups[0]!.gifts.map((g) => g.itemId)).toEqual(['1', '3']);
    expect(s.summary).toEqual([
      { label: 'Donation', count: 2, total: '$150.00' },
      { label: 'Other', count: 1, total: '$5.00' },
      { label: 'Sponsorship', count: 1, total: '$200.00' },
    ]);
    expect(s.totalSupport).toBe('$355.00');
  });

  it('lists excluded types but keeps them out of the acknowledgment total', () => {
    const s = build({
      gifts: [
        gift('1', '2026-01-01', '$100.00', 'Donation'),
        gift('2', '2026-01-02', '$200.00', 'Sponsorship'),
        gift('3', '2026-01-03', '$300.00', 'Grants'),
        gift('4', '2026-01-04', '$400.00', 'Contracts'),
        gift('5', '2026-01-05', '$500.00', 'Event Ticket'),
        gift('6', '2026-01-06', '$600.00', 'Matching Donation'),
        gift('7', '2026-01-07', '$25.00', 'Donor Advised Fund'),
      ],
    })!;
    expect(s.groups.map((g) => g.label)).toEqual(
      ['Donation', 'Sponsorship', 'Grants', 'Contracts', 'Event Ticket', 'Matching Donation', 'Donor Advised Fund']
    );
    expect(s.acknowledgment!.total).toBe('$100.00');
    expect(s.acknowledgment!.gifts.map((g) => g.itemId)).toEqual(['1']);
    expect(s.acknowledgment!.separateGifts.map((g) => g.itemId)).toEqual(['7']);
    expect(s.acknowledgment!.statement).toBe('PLAIN-STATEMENT');
  });

  it('a DAF-only year has no deductible gifts but still lists the separate gifts', () => {
    const gifts = [gift('3', '2026-01-01', '$9.00', 'Donor Advised Fund')];
    const on = build({ gifts })!;
    expect(on.hasDeductibleGifts).toBe(false);
    expect(on.acknowledgment!.gifts).toEqual([]);
    expect(on.acknowledgment!.separateGifts.map((g) => g.itemId)).toEqual(['3']);
    const off = build({ gifts, acknowledgmentOn: false })!;
    expect(off.hasDeductibleGifts).toBe(false);
    expect(off.acknowledgment).toBeNull();
  });

  it('has no acknowledgment when the switch is off or nothing survives', () => {
    const gifts = [gift('1', '2026-01-01', '$100.00', 'Donation')];
    expect(build({ gifts, acknowledgmentOn: false })!.acknowledgment).toBeNull();
    expect(build({ gifts: [gift('2', '2026-01-01', '$9.00', 'Grants')] })!.acknowledgment).toBeNull();
    expect(build({ gifts: [gift('3', '2026-01-01', '$9.00', 'Donor Advised Fund')] })!.acknowledgment!.total).toBe('$0.00');
  });

  it('counts an item in both gifts and matches once', () => {
    const both = gift('1', '2026-02-01', '$100.00', 'Matching Donation');
    const s = build({ gifts: [both], matches: [both, gift('9', '2026-03-01', '$40.00', '')] })!;
    expect(s.matches).toEqual([{ date: '2026-03-01', amount: '$40.00' }]);
    expect(s.matchTotal).toBe('$40.00');
    expect(s.totalSupport).toBe('$140.00');
    expect(s.summary.at(-1)).toEqual({ label: 'Employee matching', count: 1, total: '$40.00' });
  });

  it('shows matches with only date and amount, and builds from matches alone', () => {
    const s = build({ matches: [gift('9', '2026-03-01', '$40.00', 'x')] })!;
    expect(Object.keys(s.matches[0]!).sort()).toEqual(['amount', 'date']);
    expect(s.groups).toEqual([]);
    expect(s.acknowledgment).toBeNull();
  });

  it('omits the matching line without matches', () => {
    const s = build({ gifts: [gift('1', '2026-01-01', '$1.00', 'Donation')] })!;
    expect(s.summary.map((r) => r.label)).toEqual(['Donation']);
    expect(s.matchTotal).toBe('$0.00');
  });

  it('reports volunteering only at or above the floor, counting employees only', () => {
    const hours = new Map([['p1', 4], ['p2', 2.5], ['p3', 1], ['stranger', 100]]);
    const gifts = [gift('1', '2026-01-01', '$1.00', 'Donation')];
    expect(build({ gifts, volunteerHoursByPerson: hours, employeeIds: ['p1', 'p2'] })!.volunteering).toBeNull();
    expect(build({ gifts, volunteerHoursByPerson: hours, employeeIds: ['p1', 'p2', 'p3'] })!.volunteering).toEqual({ people: 3, hours: '7.5' });
    expect(build({ gifts, volunteerHoursByPerson: null, employeeIds: ['p1', 'p2', 'p3'] })!.volunteering).toBeNull();
  });
});

describe('statementYears', () => {
  it('lists completed years from gifts and matches, newest first', () => {
    const now = new Date('2026-08-24T00:00:00Z');
    expect(
      statementYears(
        [gift('1', '2024-01-01', '$1', 'a'), gift('2', '2026-01-01', '$1', 'a')],
        [gift('3', '2025-05-05', '$1', ''), gift('4', '2024-06-06', '$1', '')],
        now
      )
    ).toEqual([2025, 2024]);
  });
});

describe('hasDeductibleGifts', () => {
  const base = { year: 2026, matches: [], volunteerHoursByPerson: null, employeeIds: [], volunteerFloor: 3, org: { id: 'o', name: 'O', address: '' } };
  const taxLetter = { acknowledgedGiftTypes: ['Donation'], excludedGiftTypes: ['Sponsorship'], separateGiftTypes: [], plainStatement: 'P', separateGiftsStatement: 'S' } as never;
  it.each([false, true])('is false for sponsor-only gifts and true with a Donation (switch %s)', (acknowledgmentOn) => {
    const sponsor = buildStatement({ ...base, taxLetter, acknowledgmentOn, gifts: [gift('a', '2026-02-01', '$500.00', 'Sponsorship')] })!;
    expect(sponsor.hasDeductibleGifts).toBe(false);
    const donation = buildStatement({ ...base, taxLetter, acknowledgmentOn, gifts: [gift('b', '2026-02-01', '$5.00', 'Donation')] })!;
    expect(donation.hasDeductibleGifts).toBe(true);
  });

  it.each(['Commute Workshop', ''])('never acknowledges a Gift Type no list names: %j', (type) => {
    const statement = buildStatement({
      ...base, taxLetter, acknowledgmentOn: true,
      gifts: [gift('a', '2026-02-01', '$500.00', type), gift('b', '2026-03-01', '$5.00', 'Donation')],
    })!;
    expect(statement.acknowledgment!.gifts.map((g) => g.itemId)).toEqual(['b']);
    expect(statement.totalSupport).toBe('$505.00');
  });
});
