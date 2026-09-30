import { describe, it, expect, vi } from 'vitest';
import { computePercent, loadPledgeData, parseAmount } from './loadPledgeData';
import type { MondayClient } from '../monday/client';
import type { PledgeRecord } from '../types';

function fakeMonday(names: { id: string; name: string }[], pledgesById: Record<string, PledgeRecord[]>): MondayClient {
  return {
    findDonorsByEmail: vi.fn(),
    getMemberPortalData: vi.fn(),
    getDiscountOrganizations: vi.fn(),
    getDonorContactInfo: vi.fn(),
    findChangeRequestItem: vi.fn().mockResolvedValue(null),
    createChangeRequestItem: vi.fn(),
    getVolunteerShiftsForDonor: vi.fn(),
    getDonorNames: vi.fn().mockResolvedValue(names),
    getPledgesForDonor: vi.fn().mockImplementation((id: string) => Promise.resolve(pledgesById[id] ?? [])),
    getEventRegistrationsForDonor: vi.fn().mockResolvedValue([]),
    getLetterSettings: vi.fn(),
    listDonorIdsWithDonationsInYear: vi.fn(),
  };
}

describe('parseAmount', () => {
  it('parses common Monday amount renderings', () => {
    expect(parseAmount('$1,200.00')).toBe(1200);
    expect(parseAmount('1200')).toBe(1200);
    expect(parseAmount('US$1 200.50')).toBe(1200.5);
  });

  it('returns null for text with no digits, never 0', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('pending')).toBeNull();
    expect(parseAmount('$')).toBeNull();
  });
});

describe('computePercent', () => {
  it('computes a whole-number percent', () => {
    expect(computePercent('$1,000', '$250')).toBe(25);
  });

  it('caps overpayment at 100', () => {
    expect(computePercent('$100', '$150')).toBe(100);
  });

  it('returns null when either amount is unparseable or pledged is not positive', () => {
    expect(computePercent('', '$50')).toBeNull();
    expect(computePercent('$100', 'n/a')).toBeNull();
    expect(computePercent('$0', '$0')).toBeNull();
  });
});

describe('loadPledgeData', () => {
  it('labels each donor section by name and attaches per-pledge progress', async () => {
    const monday = fakeMonday(
      [
        { id: 'donor-1', name: 'Jane' },
        { id: 'donor-2', name: 'Sam' },
      ],
      {
        'donor-1': [{ name: '2026 Annual Pledge', pledged: '$1,000.00', fulfilled: '$400.00', status: 'Active', dueDate: '2026-12-31' }],
      }
    );

    const sections = await loadPledgeData(['donor-1', 'donor-2'], monday);

    expect(sections).toEqual([
      {
        donorItemId: 'donor-1',
        donorName: 'Jane',
        pledges: [
          {
            name: '2026 Annual Pledge',
            pledged: '$1,000.00',
            fulfilled: '$400.00',
            status: 'Active',
            dueDate: '2026-12-31',
            percentComplete: 40,
          },
        ],
      },
      { donorItemId: 'donor-2', donorName: 'Sam', pledges: [] },
    ]);
  });

  it('falls back to the item id rather than dropping a donor whose Monday item vanished', async () => {
    const monday = fakeMonday([], { 'donor-1': [] });
    const sections = await loadPledgeData(['donor-1'], monday);
    expect(sections).toEqual([{ donorItemId: 'donor-1', donorName: 'donor-1', pledges: [] }]);
  });
});
