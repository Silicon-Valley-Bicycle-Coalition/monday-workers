import { describe, it, expect } from 'vitest';
import { formatMemberNumber, formatExpiry, buildCardData } from './loadCardData';
import type { DonorPortalData } from '../types';

describe('formatMemberNumber', () => {
  it('prefixes the donor item id', () => {
    expect(formatMemberNumber('4821053')).toBe('Member #4821053');
  });
});

describe('formatExpiry', () => {
  it('formats an ISO date as a long-form date', () => {
    expect(formatExpiry('2026-12-31')).toBe('December 31, 2026');
  });

  it('treats an empty string as no expiration', () => {
    expect(formatExpiry('')).toBe('No expiration');
  });

  it('treats an unparseable value as no expiration', () => {
    expect(formatExpiry('not-a-date')).toBe('No expiration');
  });
});

describe('buildCardData', () => {
  it('combines member number, tier, status, and formatted expiry', () => {
    const donor: DonorPortalData = {
      id: 'donor-1',
      name: 'Jane Example',
      membershipStatus: 'Active',
      membershipTier: 'Champion',
      totalDonated: '$500.00',
      donations: [],
      membershipExpiry: '2026-12-31',
    };

    expect(buildCardData(donor)).toEqual({
      donorId: 'donor-1',
      donorName: 'Jane Example',
      memberNumber: 'Member #donor-1',
      membershipTier: 'Champion',
      membershipStatus: 'Active',
      expiryDisplay: 'December 31, 2026',
    });
  });

  it('shows "No expiration" for a lifetime membership with no expiry set', () => {
    const donor: DonorPortalData = {
      id: 'donor-2',
      name: 'Sam Example',
      membershipStatus: 'Active',
      membershipTier: 'Lifetime',
      totalDonated: '$1000.00',
      donations: [],
      membershipExpiry: '',
    };

    expect(buildCardData(donor).expiryDisplay).toBe('No expiration');
  });
});
