import { describe, it, expect, vi } from 'vitest';
import { loadPortalData } from './loadPortalData';
import type { MondayClient } from '../monday/client';
import type { DonorPortalData } from '../types';

function donor(id: string, name: string): DonorPortalData {
  return { id, name, membershipStatus: 'Active', membershipTier: 'Member', totalDonated: '100', donations: [], membershipExpiry: '' };
}

describe('loadPortalData', () => {
  it('fetches each donor id independently and one shared discount list', async () => {
    const monday: MondayClient = {
      findDonorsByEmail: vi.fn(),
      getDonorPortalData: vi
        .fn()
        .mockImplementation((id: string) => Promise.resolve(donor(id, id === 'donor-1' ? 'Jane' : 'Jane Also'))),
      getDiscountOrganizations: vi.fn().mockResolvedValue([{ name: 'Local Bikes', discountOffered: '10% off' }]),
      getDonorContactInfo: vi.fn(),
      createChangeRequestItem: vi.fn(),
      getDonorNames: vi.fn().mockResolvedValue([]),
      getEventRegistrationsForDonor: vi.fn().mockResolvedValue([]),
      getPledgesForDonor: vi.fn().mockResolvedValue([]),
    };

    const result = await loadPortalData(['donor-1', 'donor-2'], monday);

    expect(result.donors).toEqual([donor('donor-1', 'Jane'), donor('donor-2', 'Jane Also')]);
    expect(result.discounts).toEqual([{ name: 'Local Bikes', discountOffered: '10% off' }]);
    expect(monday.getDiscountOrganizations).toHaveBeenCalledTimes(1);
  });
});
