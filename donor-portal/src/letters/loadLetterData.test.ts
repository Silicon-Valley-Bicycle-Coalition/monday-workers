import { describe, it, expect, vi } from 'vitest';
import { parseAmount, giftYear, listLetterYears, loadLetterData } from './loadLetterData';
import type { MondayClient } from '../monday/client';
import type { DonorPortalData, TaxLetterConfig } from '../types';

const taxLetter: TaxLetterConfig = {
  orgLegalName: 'SVBC', ein: '00-0000000', orgAddress: 'addr',
  signatureName: 'Alex', signatureTitle: 'ED',
  plainStatement: 'PLAIN-STATEMENT', benefitStatement: 'BENEFIT-STATEMENT',
  benefitTiers: ['Champion'],
};

const NOW = new Date('2026-08-24T00:00:00.000Z'); // current year 2026 → letters exist for ≤2025

function donor(overrides: Partial<DonorPortalData>): DonorPortalData {
  return {
    id: 'donor-1', name: 'Jane Example', membershipStatus: 'Active', membershipTier: 'Member',
    totalDonated: '0',
    donations: [],
    ...overrides,
  };
}

function fakeMonday(data: Record<string, DonorPortalData>): MondayClient {
  return {
    findDonorsByEmail: vi.fn(),
    getDonorPortalData: vi.fn().mockImplementation((id: string) => Promise.resolve(data[id])),
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
    const result = await listLetterYears(['donor-1', 'donor-2'], fakeMonday({ 'donor-1': a, 'donor-2': b }), NOW);
    expect(result).toEqual([
      { donorId: 'donor-1', donorName: 'Jane Example', years: [2025, 2024] },
      { donorId: 'donor-2', donorName: 'Sam Example', years: [] },
    ]);
  });
});
