import type { MondayClient } from './client';
import type { ChangeRequestColumns, DiscountOrganization, DonationRecord, DonorContactInfo, DonorMatch, DonorPortalData } from '../types';

// Dummy data for local preview only (see src/index.local.ts) — never imported by the real
// Worker entrypoint (src/index.ts). Deliberately covers the interesting cases the read-only
// portal needs to demonstrate: a normal single-match donor, a shared-email household (two
// donor items behind one email, per the README's "show all matches, explicitly labeled"
// decision), and a lapsed member with no donations (empty-state check).

interface FakeDonor {
  id: string;
  name: string;
  email: string;
  membershipStatus: string;
  membershipTier: string;
  membershipExpiry: string;
  address: string;
  phone: string;
  preferredLanguage: string;
  donations: DonationRecord[];
}

function totalDonated(donations: DonationRecord[]): string {
  const cents = donations.reduce((sum, d) => sum + Math.round(Number(d.amount.replace(/[^0-9.-]/g, '')) * 100), 0);
  return (cents / 100).toFixed(2);
}

const DONORS: FakeDonor[] = [
  {
    id: '1001',
    name: 'Jordan Alvarez',
    email: 'jordan@example.com',
    membershipStatus: 'Active',
    membershipTier: 'Gold',
    membershipExpiry: '2027-06-30',
    address: '456 Willow St, San Jose, CA 95112',
    phone: '408-555-0142',
    preferredLanguage: 'English',
    donations: [
      { date: '2024-03-14', amount: '75.00', description: 'Annual membership' },
      { date: '2024-09-02', amount: '150.00', description: 'Bike to Work Day sponsorship' },
      { date: '2025-01-20', amount: '75.00', description: 'Annual membership renewal' },
      { date: '2025-06-11', amount: '40.00', description: 'General donation' },
    ],
  },
  {
    id: '1002',
    name: 'Sam Rivera',
    email: 'family@example.com',
    membershipStatus: 'Active',
    membershipTier: 'Household',
    membershipExpiry: '2027-01-15',
    address: '789 Oak Ave, Sunnyvale, CA 94086',
    phone: '408-555-0187',
    preferredLanguage: 'Spanish',
    donations: [{ date: '2024-11-05', amount: '100.00', description: 'Household membership' }],
  },
  {
    id: '1003',
    name: 'Riley Rivera',
    email: 'family@example.com',
    membershipStatus: 'Active',
    membershipTier: 'Household',
    membershipExpiry: '2027-01-15',
    address: '789 Oak Ave, Sunnyvale, CA 94086',
    phone: '408-555-0187',
    preferredLanguage: 'English',
    donations: [{ date: '2025-02-18', amount: '25.00', description: 'Trail maintenance day match' }],
  },
  {
    id: '1004',
    name: 'Casey Nguyen',
    email: 'casey@example.com',
    membershipStatus: 'Lapsed',
    membershipTier: 'Individual',
    membershipExpiry: '2024-01-01',
    address: '',
    phone: '',
    preferredLanguage: 'Chinese (Simplified)',
    donations: [],
  },
];

const DISCOUNT_ORGANIZATIONS: DiscountOrganization[] = [
  { name: 'Wheel Works Cyclery', discountOffered: '15% off tune-ups and accessories' },
  { name: 'Valley Bike Depot', discountOffered: '10% off new bike purchases' },
  { name: 'South Bay Cycles', discountOffered: 'Free flat repair for members' },
];

function findDonor(donorItemId: string): FakeDonor {
  const donor = DONORS.find((d) => d.id === donorItemId);
  if (!donor) {
    throw new Error(`fakeMondayClient: donor item "${donorItemId}" not found in dummy data`);
  }
  return donor;
}

export class FakeMondayClient implements MondayClient {
  async findDonorsByEmail(email: string): Promise<DonorMatch[]> {
    return DONORS.filter((d) => d.email.toLowerCase() === email.toLowerCase()).map((d) => ({
      id: d.id,
      name: d.name,
      preferredLanguage: d.preferredLanguage,
    }));
  }

  async getDonorPortalData(donorItemId: string): Promise<DonorPortalData> {
    const donor = findDonor(donorItemId);
    return {
      id: donor.id,
      name: donor.name,
      membershipStatus: donor.membershipStatus,
      membershipTier: donor.membershipTier,
      totalDonated: totalDonated(donor.donations),
      donations: donor.donations,
      membershipExpiry: donor.membershipExpiry,
    };
  }

  async getDiscountOrganizations(): Promise<DiscountOrganization[]> {
    return DISCOUNT_ORGANIZATIONS;
  }

  async getDonorContactInfo(donorItemId: string): Promise<DonorContactInfo> {
    const donor = findDonor(donorItemId);
    return {
      id: donor.id,
      name: donor.name,
      email: donor.email,
      address: donor.address,
      phone: donor.phone,
      preferredLanguage: donor.preferredLanguage,
    };
  }

  async createChangeRequestItem(params: {
    boardId: number;
    columns: ChangeRequestColumns;
    itemName: string;
    donorItemId: string;
    fieldLabel: string;
    oldValue: string;
    newValue: string;
    submittedAtISO: string;
  }): Promise<void> {
    // Local preview has no real Change Requests board to write to — log instead so the
    // submission is visible in `wrangler dev`'s console output.
    console.log(
      `[fakeMondayClient] would create change-request item on board ${params.boardId}: ` +
        `donor ${params.donorItemId} — ${params.fieldLabel}: "${params.oldValue}" -> "${params.newValue}"`
    );
  }
}
