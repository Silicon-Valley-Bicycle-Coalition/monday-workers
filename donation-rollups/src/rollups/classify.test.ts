import { describe, it, expect } from 'vitest';
import { classifyGift, acknowledgmentTier, fiscalYearEnding, FUNDING_STREAMS, GIFT_SIZES } from './classify';

const g = (over: Partial<Parameters<typeof classifyGift>[0]> = {}) =>
  classifyGift({ amountCents: 5000, dateISO: '2025-08-01', giftType: 'Donation', ...over }, 7);

describe('classifyGift — funding stream', () => {
  it.each([
    ['Membership', 'Membership'],
    ['Sponsorship', 'Sponsorships'],
    ['In Kind Donation / Sponsorship', 'Sponsorships'],
    ['In_Kind_Donation_Sponsorship', 'Sponsorships'],
    ['Grants', 'Grants & Contracts'],
    ['Contracts', 'Grants & Contracts'],
    ['Matching Donation', 'Matching Donations'],
    ['MatchingDonation', 'Matching Donations'],
    ['  matching donation ', 'Matching Donations'],
    ['Commute Workshop', 'Other Program Revenue'],
    ['Driver_Training', 'Other Program Revenue'],
    ['Donor Advised Fund', 'Donor Advised Funds'],
    ['  donor-advised fund ', 'Donor Advised Funds'],
    ['Event Ticket', 'Event Tickets'],
    ['  event_ticket ', 'Event Tickets'],
    ['Donation', 'Individual Giving'],
    ['Major Gift', 'Individual Giving'],
    ['Funraise Online', 'Individual Giving'],
    ['Click & Pledge (historical)', 'Individual Giving'],
    ['Some Brand New Type', 'Individual Giving'],
    [null, 'Individual Giving'],
  ])('%s → %s', (giftType, stream) => {
    expect(g({ giftType }).fundingStream).toBe(stream);
  });

  it('only ever returns a label from FUNDING_STREAMS', () => {
    for (const t of ['Membership', 'x', 'Grants', 'Sponsorship', 'Donor Advised Fund', 'Event Ticket']) {
      expect(FUNDING_STREAMS).toContain(g({ giftType: t }).fundingStream);
    }
  });
});

describe('classifyGift — gift size', () => {
  it.each([
    [1, '< $100'], [9999, '< $100'], [10000, '$100–199'], [19999, '$100–199'],
    [20000, '$200–999'], [24999, '$200–999'], [25000, '$200–999'], [99999, '$200–999'], [100000, '$1k–4.9k'], [499999, '$1k–4.9k'],
    [500000, '$5k+'], [12345678, '$5k+'],
  ])('%i cents → %s', (amountCents, size) => {
    expect(g({ amountCents }).giftSize).toBe(size);
    expect(GIFT_SIZES).toContain(size);
  });

  it.each([[0], [-500], [null]])('blank for a %s amount', (amountCents) => {
    expect(g({ amountCents }).giftSize).toBe('');
  });
});

describe('classifyGift — fiscal quarter and year (July fiscal year)', () => {
  it.each([
    ['2025-07-01', 'FY26 Q1', 'FY2026'],
    ['2025-09-30', 'FY26 Q1', 'FY2026'],
    ['2025-10-01', 'FY26 Q2', 'FY2026'],
    ['2026-01-15', 'FY26 Q3', 'FY2026'],
    ['2026-04-01', 'FY26 Q4', 'FY2026'],
    ['2026-06-30', 'FY26 Q4', 'FY2026'],
    ['2026-07-01', 'FY27 Q1', 'FY2027'],
    ['2009-12-31', 'FY10 Q2', 'FY2010'],
  ])('%s → %s / %s', (dateISO, q, fy) => {
    const c = g({ dateISO });
    expect(c.fiscalQuarter).toBe(q);
    expect(c.giftFiscalYear).toBe(fy);
  });

  it('accepts a timestamp-shaped date by its first 10 characters', () => {
    expect(g({ dateISO: '2025-10-01T00:00:00Z' }).fiscalQuarter).toBe('FY26 Q2');
  });

  it.each([[null], [''], ['not-a-date'], ['2025-13-01']])('blank quarter and year for %s', (dateISO) => {
    const c = g({ dateISO });
    expect(c.fiscalQuarter).toBe('');
    expect(c.giftFiscalYear).toBe('');
  });

  it('calendar fiscal year (startMonth 1) puts January in Q1', () => {
    expect(classifyGift({ amountCents: 1, dateISO: '2025-01-05', giftType: null }, 1))
      .toMatchObject({ fiscalQuarter: 'FY25 Q1', giftFiscalYear: 'FY2025' });
  });
});

describe('acknowledgmentTier', () => {
  it.each([
    [20000, 'Major'],
    [500000, 'Major'],
    [19999, 'Standard'],
    [1000, 'Standard'],
    [0, 'Standard'],
    [-5000, 'Standard'],
  ])('%s cents → %s', (cents, tier) => {
    expect(acknowledgmentTier(cents)).toBe(tier);
  });

  it('is null without a usable amount, so the cell is left alone', () => {
    expect(acknowledgmentTier(null)).toBeNull();
    expect(acknowledgmentTier(NaN)).toBeNull();
  });
});

describe('fiscalYearEnding', () => {
  it('names the fiscal year by the calendar year it ends in', () => {
    expect(fiscalYearEnding('2025-08-01', 7)).toBe('2026');
    expect(fiscalYearEnding('2026-06-30', 7)).toBe('2026');
    expect(fiscalYearEnding('2026-07-01', 7)).toBe('2027');
    expect(fiscalYearEnding('2025-12-31T10:00:00Z', 7)).toBe('2026');
  });
  it('is null for a missing or malformed date', () => {
    expect(fiscalYearEnding(null, 7)).toBeNull();
    expect(fiscalYearEnding('', 7)).toBeNull();
    expect(fiscalYearEnding('2025-13-01', 7)).toBeNull();
    expect(fiscalYearEnding('not a date', 7)).toBeNull();
  });
});
