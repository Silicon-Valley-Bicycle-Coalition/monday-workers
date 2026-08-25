import type { DonorPortalData } from '../types';

export interface CardData {
  donorId: string;
  donorName: string;
  memberNumber: string;
  membershipTier: string;
  membershipStatus: string;
  expiryDisplay: string;
}

const NO_EXPIRATION = 'No expiration';

export function formatMemberNumber(donorItemId: string): string {
  return `Member #${donorItemId}`;
}

export function formatExpiry(membershipExpiry: string): string {
  if (membershipExpiry.length === 0) {
    return NO_EXPIRATION;
  }
  const date = new Date(`${membershipExpiry}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return NO_EXPIRATION;
  }
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function buildCardData(donor: DonorPortalData): CardData {
  return {
    donorId: donor.id,
    donorName: donor.name,
    memberNumber: formatMemberNumber(donor.id),
    membershipTier: donor.membershipTier,
    membershipStatus: donor.membershipStatus,
    expiryDisplay: formatExpiry(donor.membershipExpiry),
  };
}
