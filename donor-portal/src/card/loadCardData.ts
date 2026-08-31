import type { DonorPortalData } from '../types';

export interface CardData {
  donorId: string;
  donorName: string;
  memberNumber: string;
  membershipTier: string;
  membershipStatus: string;
  expiryDisplay: string;
  // Compact "Mon YYYY" form for the dashboard's wallet-card widget, which has no room for a full
  // date — expiryDisplay (day-precision) stays the one shown on the public verify page, where a
  // shop clerk checking validity wants full precision.
  expiryShort: string;
}

// Dashboard widget + verify page render one card per donor — bundles the widget's rendering
// inputs (view-model data plus its already-generated QR) so routes.ts only builds this once per
// donor and views.ts just renders it.
export interface PortalCard {
  data: CardData;
  qrSvg: string;
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

export function formatExpiryShort(membershipExpiry: string): string {
  if (membershipExpiry.length === 0) {
    return NO_EXPIRATION;
  }
  const date = new Date(`${membershipExpiry}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return NO_EXPIRATION;
  }
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function buildCardData(donor: DonorPortalData): CardData {
  return {
    donorId: donor.id,
    donorName: donor.name,
    memberNumber: formatMemberNumber(donor.id),
    membershipTier: donor.membershipTier,
    membershipStatus: donor.membershipStatus,
    expiryDisplay: formatExpiry(donor.membershipExpiry),
    expiryShort: formatExpiryShort(donor.membershipExpiry),
  };
}
