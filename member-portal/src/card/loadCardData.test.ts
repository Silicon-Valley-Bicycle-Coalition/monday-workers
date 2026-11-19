import { describe, it, expect } from 'vitest';
import { formatMemberNumber, formatExpiry, formatExpiryShort, buildCardData } from './loadCardData';
import type { MemberPortalData } from '../types';

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

describe('formatExpiryShort', () => {
  it('formats an ISO date as "Mon YYYY", for the dashboard card widget', () => {
    expect(formatExpiryShort('2026-12-31')).toBe('Dec 2026');
  });

  it('treats an empty string as no expiration', () => {
    expect(formatExpiryShort('')).toBe('No expiration');
  });

  it('treats an unparseable value as no expiration', () => {
    expect(formatExpiryShort('not-a-date')).toBe('No expiration');
  });
});

describe('buildCardData', () => {
  it('combines member number, tier, status, and formatted expiry', () => {
    const donor: MemberPortalData = {
      id: 'donor-1',
      name: 'Jane Example',
      membershipStatus: 'Active',
      membershipTier: 'Champion',
      totalDonated: '$500.00',
      donations: [],
      membershipExpiry: '2026-12-31',
      memberSince: '',
      memberType: '',
    };

    expect(buildCardData(donor)).toEqual({
      donorId: 'donor-1',
      donorName: 'Jane Example',
      memberNumber: 'Member #donor-1',
      membershipTier: 'Champion',
      membershipStatus: 'Active',
      expiryDisplay: 'December 31, 2026',
      expiryShort: 'Dec 2026',
    });
  });

  it('shows "No expiration" for a lifetime membership with no expiry set', () => {
    const donor: MemberPortalData = {
      id: 'donor-2',
      name: 'Sam Example',
      membershipStatus: 'Active',
      membershipTier: 'Lifetime',
      totalDonated: '$1000.00',
      donations: [],
      membershipExpiry: '',
      memberSince: '',
      memberType: '',
    };

    expect(buildCardData(donor).expiryDisplay).toBe('No expiration');
    expect(buildCardData(donor).expiryShort).toBe('No expiration');
  });
});
