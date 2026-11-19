import { describe, it, expect, vi } from 'vitest';
import { parseAmount, giftYear, listLetterYears, loadLetterData } from './loadLetterData';
import { HttpMondayClient } from '../monday/client';
import type { MondayClient } from '../monday/client';
import type { MemberPortalData, MondayColumns, TaxLetterConfig } from '../types';

const taxLetter: TaxLetterConfig = {
  orgLegalName: 'SVBC', ein: '00-0000000', officeAddress: 'addr',
  signatureName: 'Alex', signatureTitle: 'ED',
  plainStatement: 'PLAIN-STATEMENT', benefitStatement: 'BENEFIT-STATEMENT',
  benefitTiers: ['Champion'],
  excludedGiftTypes: ['Event Ticket', 'Sponsorship', 'In Kind Donation / Sponsorship', 'Matching Donation', 'Grants', 'Contracts'],
  separateGiftTypes: ['Donor Advised Fund'],
  separateGiftsStatement: 'SEPARATE-STATEMENT',
};

const NOW = new Date('2026-08-24T00:00:00.000Z'); // current year 2026 → letters exist for ≤2025

function donor(overrides: Partial<MemberPortalData>): MemberPortalData {
  return {
    id: 'donor-1', name: 'Jane Example', membershipStatus: 'Active', membershipTier: 'Member',
    totalDonated: '0',
    donations: [],
    membershipExpiry: '', memberSince: '', memberType: '',
    ...overrides,
  };
}

function fakeMonday(data: Record<string, MemberPortalData>): MondayClient {
  return {
    findDonorsByEmail: vi.fn(),
    getMemberPortalData: vi.fn().mockImplementation((id: string) => Promise.resolve(data[id])),
    getDiscountOrganizations: vi.fn(),
  } as unknown as MondayClient;
}

describe('parseAmount', () => {
  it('parses currency-formatted text', () => {
    expect(parseAmount('$1,234.56')).toBe(1234.56);
  });
  it('treats unparseable text as zero', () => {
    expect(parseAmount('pending')).toBe(0);
  });
});

describe('giftYear', () => {
  it('reads the year off a YYYY-MM-DD date', () => {
    expect(giftYear('2025-03-14')).toBe(2025);
  });
  it('returns null for a date it cannot read', () => {
    expect(giftYear('')).toBeNull();
  });
});

describe('loadLetterData', () => {
  const d = donor({
    donations: [
      { date: '2025-06-01', amount: '$50.00', description: 'gift' },
      { date: '2025-01-15', amount: '$25.00', description: 'gift' },
      { date: '2024-12-31', amount: '$999.00', description: 'prior year' },
      { date: '2026-02-01', amount: '$10.00', description: 'current year' },
    ],
  });

  it('includes only the requested year, ascending, with a formatted total', async () => {
    const result = await loadLetterData('donor-1', 2025, fakeMonday({ 'donor-1': d }), taxLetter, NOW);
    expect(result).not.toBeNull();
    expect(result!.gifts.map((g) => g.date)).toEqual(['2025-01-15', '2025-06-01']);
    expect(result!.totalFormatted).toBe('$75.00');
  });

  it('selects the plain statement for a non-benefit tier', async () => {
    const result = await loadLetterData('donor-1', 2025, fakeMonday({ 'donor-1': d }), taxLetter, NOW);
    expect(result!.statement).toBe('PLAIN-STATEMENT');
  });

  it('selects the benefit statement for a benefit-carrying tier', async () => {
    const champ = donor({ membershipTier: 'Champion', donations: d.donations });
    const result = await loadLetterData('donor-1', 2025, fakeMonday({ 'donor-1': champ }), taxLetter, NOW);
    expect(result!.statement).toBe('BENEFIT-STATEMENT');
  });

  it('returns null for the current (incomplete) year', async () => {
    expect(await loadLetterData('donor-1', 2026, fakeMonday({ 'donor-1': d }), taxLetter, NOW)).toBeNull();
  });

  it('returns null for a completed year with no gifts', async () => {
    expect(await loadLetterData('donor-1', 2023, fakeMonday({ 'donor-1': d }), taxLetter, NOW)).toBeNull();
  });
});

describe('loadLetterData by Gift Type', () => {
  const gift = (date: string, amount: string, description: string) => ({ date, amount, description });

  it('moves a Donor Advised Fund gift to its own list, out of the total', async () => {
    const d = donor({
      donations: [
        gift('2025-02-01', '$100.00', 'Donation'),
        gift('2025-03-01', '$500.00', 'Donor Advised Fund'),
        gift('2025-04-01', '$250.00', 'Donor Advised Fund'),
      ],
    });
    const result = await loadLetterData('donor-1', 2025, fakeMonday({ 'donor-1': d }), taxLetter, NOW);
    expect(result!.gifts).toEqual([{ date: '2025-02-01', amount: '$100.00' }]);
    expect(result!.separateGifts).toEqual([
      { date: '2025-03-01', amount: '$500.00' },
      { date: '2025-04-01', amount: '$250.00' },
    ]);
    expect(result!.totalFormatted).toBe('$100.00');
  });

  it('still produces a letter for a donor whose only gifts that year are separately listed', async () => {
    const d = donor({ donations: [gift('2025-03-01', '$500.00', 'Donor Advised Fund')] });
    const result = await loadLetterData('donor-1', 2025, fakeMonday({ 'donor-1': d }), taxLetter, NOW);
    expect(result!.gifts).toEqual([]);
    expect(result!.separateGifts).toHaveLength(1);
    expect(result!.totalFormatted).toBe('$0.00');
  });

  it.each(['Event Ticket', 'Sponsorship', 'In Kind Donation / Sponsorship', 'Matching Donation', 'Grants', 'Contracts'])('leaves %s off the letter entirely', async (type) => {
    const d = donor({ donations: [gift('2025-02-01', '$100.00', 'Donation'), gift('2025-03-01', '$75.00', type)] });
    const result = await loadLetterData('donor-1', 2025, fakeMonday({ 'donor-1': d }), taxLetter, NOW);
    expect(result!.gifts).toEqual([{ date: '2025-02-01', amount: '$100.00' }]);
    expect(result!.separateGifts).toEqual([]);
    expect(result!.totalFormatted).toBe('$100.00');
  });

  it('returns null when every gift that year is left off', async () => {
    const d = donor({ donations: [gift('2025-03-01', '$75.00', 'Event Ticket')] });
    expect(await loadLetterData('donor-1', 2025, fakeMonday({ 'donor-1': d }), taxLetter, NOW)).toBeNull();
  });

  it('matches a hand-typed label regardless of case and spacing', async () => {
    const d = donor({
      donations: [gift('2025-02-01', '$10.00', ' donor-advised  fund '), gift('2025-03-01', '$20.00', 'event ticket')],
    });
    const result = await loadLetterData('donor-1', 2025, fakeMonday({ 'donor-1': d }), taxLetter, NOW);
    expect(result!.separateGifts).toEqual([{ date: '2025-02-01', amount: '$10.00' }]);
    expect(result!.gifts).toEqual([]);
  });

  it('keeps a blank or unknown Gift Type as an ordinary gift', async () => {
    const d = donor({ donations: [gift('2025-02-01', '$10.00', ''), gift('2025-03-01', '$20.00', 'Membership')] });
    const result = await loadLetterData('donor-1', 2025, fakeMonday({ 'donor-1': d }), taxLetter, NOW);
    expect(result!.gifts).toHaveLength(2);
    expect(result!.totalFormatted).toBe('$30.00');
  });
});

// Regression for the Failed/Pending overstatement bug: the letter total must count only gifts
// whose Donations-board status is a countable label. Goes through the real HttpMondayClient
// (mocked fetch) rather than a fake, because the status filter lives at the client layer.
describe('loadLetterData with the real client (status filtering)', () => {
  const columns: MondayColumns = {
    donorEmail: 'email_col',
    membershipStatus: 'status_col',
    membershipTier: 'tier_col',
    dollarDonated: 'donated_col',
    donationDonorLink: 'link_col',
    donationAmount: 'amount_col',
    donationDate: 'date_col',
    donationDescription: 'desc_col',
    donationStatus: 'donation_status_col',
    discountOffered: 'offer_col',
    discountActive: 'active_col',
    donorAddress: 'addr_col',
    donorPhone: 'phone_col',
    membershipExpiry: 'expiry_col',
    memberSince: 'since_col',
    memberType: 'member_type_col',
    donorEmailConsent: 'email_consent_col',
    donorHouseholdEmailConsent: 'household_consent_col',
    preferredLanguage: 'lang_col',
    donorHouseholdEmail: 'REPLACE_WITH_COLUMN_ID',
    donorEmailOptOut: 'check_email_opt',
    donorSmsOptOut: 'check_sms_opt',
    donorDoNotMail: 'check_no_mail',
    volunteerDonorLink: 'vol_link_col',
    volunteerHours: 'vol_hours_col',
    volunteerDate: 'vol_date_col',
    volunteerJob: 'vol_job_col',
    volunteerStatus: 'vol_status_col',
    donationMatchesGift: 'REPLACE_WITH_COLUMN_ID',
    donationMatchStatus: 'REPLACE_WITH_COLUMN_ID',
    donationMatchedBy: 'REPLACE_WITH_COLUMN_ID',
    donorDtdLink: 'REPLACE_WITH_COLUMN_ID',
    donorEmployer: 'REPLACE_WITH_COLUMN_ID',
  };

  const donationItem = (id: string, status: string, amount: string) => ({
    id,
    column_values: [
      { id: 'amount_col', text: amount },
      { id: 'date_col', text: '2025-03-01' },
      { id: 'desc_col', text: 'gift' },
      { id: 'donation_status_col', text: status },
    ],
  });

  it('excludes Failed and Pending gifts from the letter total (a migrated Failed $500 must not inflate it)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [
              {
                id: 'donor-1',
                name: 'Jane Example',
                column_values: [
                  { id: 'status_col', text: 'Active' },
                  { id: 'tier_col', text: 'Member' },
                  { id: 'donated_col', text: '75' },
                ],
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            boards: [
              {
                items_page: {
                  cursor: null,
                  items: [
                    donationItem('d-1', 'Received', '$50.00'),
                    donationItem('d-2', 'Failed', '$500.00'),
                    donationItem('d-3', 'Pending', '$40.00'),
                    donationItem('d-4', 'Received (Historical)', '$25.00'),
                  ],
                },
              },
            ],
          },
        }),
      });
    const client = new HttpMondayClient(
      'https://api.monday.com/v2',
      'token',
      columns,
      999,
      1,
      2,
      { countableStatuses: ['Received', 'Received (Historical)'], historyStartISO: null },
      null,
      null,
      fetchMock
    );

    const result = await loadLetterData('donor-1', 2025, client, taxLetter, NOW);

    expect(result).not.toBeNull();
    // $50 Received + $25 Received (Historical); the Failed $500 and Pending $40 never count.
    expect(result!.totalFormatted).toBe('$75.00');
    expect(result!.gifts.map((g) => g.amount)).toEqual(['$50.00', '$25.00']);
  });
});

describe('listLetterYears', () => {
  it('lists completed years with gifts, newest first, per donor', async () => {
    const a = donor({
      id: 'donor-1', name: 'Jane Example',
      donations: [
        { date: '2024-05-01', amount: '$5', description: '' },
        { date: '2025-05-01', amount: '$5', description: '' },
        { date: '2026-01-01', amount: '$5', description: '' }, // current year: excluded
      ],
    });
    const b = donor({ id: 'donor-2', name: 'Sam Example', donations: [] });
    const result = await listLetterYears(['donor-1', 'donor-2'], fakeMonday({ 'donor-1': a, 'donor-2': b }), taxLetter, NOW);
    expect(result).toEqual([
      { donorId: 'donor-1', donorName: 'Jane Example', years: [2025, 2024] },
      { donorId: 'donor-2', donorName: 'Sam Example', years: [] },
    ]);
  });

  it('skips a year holding only left-off gifts but keeps one holding only separately listed gifts', async () => {
    const a = donor({
      donations: [
        { date: '2024-05-01', amount: '$5', description: 'Event Ticket' },
        { date: '2025-05-01', amount: '$5', description: 'Donor Advised Fund' },
      ],
    });
    const result = await listLetterYears(['donor-1'], fakeMonday({ 'donor-1': a }), taxLetter, NOW);
    expect(result[0]!.years).toEqual([2025]);
  });
});
