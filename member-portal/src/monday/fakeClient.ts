import type { MondayClient } from './client';
import type { AffiliationRecord } from '../changeRequests/employer';
import type { OrganizationCandidate } from '../changeRequests/employerName';
import type {
  ChangeRequestColumns,
  EmployerAnswerConfig,
  DiscountOrganization,
  DonationRecord,
  DonorContactInfo,
  DonorMatch,
  MemberPortalData,
  EventRegistrationColumns,
  EventRegistrationRecord,
  LetterCronColumns,
  LetterSettings,
  PledgeRecord,
  VolunteerShift,
} from '../types';

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
      {
        date: '2025-01-20',
        amount: '75.00',
        description: 'Annual membership renewal',
        match: { date: '2025-02-10', amount: '75.00', company: 'Example Corp' },
      },
      { date: '2025-02-10', amount: '75.00', description: 'Matching gift' },
      {
        date: '2025-06-11',
        amount: '40.00',
        description: 'General donation',
        matchHintUrl: 'https://example.com/match-lookup',
      },
      // Previews a letter's separately listed and left-off gifts (taxLetter in config/local.json).
      { date: '2025-08-04', amount: '500.00', description: 'Donor Advised Fund' },
      { date: '2025-09-20', amount: '35.00', description: 'Event Ticket' },
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

// Only Jordan (1001) has volunteer/pledge/event data — the household donors and the lapsed
// member stay empty, so the empty-state rendering for each of these sections gets exercised too.
const VOLUNTEER_SHIFTS: Record<string, VolunteerShift[]> = {
  '1001': [
    { date: '2025-04-12', hours: '3.5', job: 'Bike Valet', status: 'Completed' },
    { date: '2025-09-06', hours: '2', job: 'Tabling — Bike to Work Day', status: 'Completed' },
  ],
};

const PLEDGES: Record<string, PledgeRecord[]> = {
  '1001': [{ name: 'Annual Giving Pledge', pledged: '500.00', fulfilled: '340.00', status: 'In Progress', dueDate: '2026-12-31' }],
};

const EVENT_REGISTRATIONS: Record<string, EventRegistrationRecord[]> = {
  '1001': [{ registrationName: 'Jordan Alvarez', eventName: 'Bike to Work Day 2025', eventDate: '2025-05-08', attended: true }],
};

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

  async getMemberPortalData(donorItemId: string, options: { includeDonations?: boolean } = {}): Promise<MemberPortalData> {
    const donor = findDonor(donorItemId);
    const includeDonations = options.includeDonations ?? true;
    return {
      id: donor.id,
      name: donor.name,
      membershipStatus: donor.membershipStatus,
      membershipTier: donor.membershipTier,
      totalDonated: includeDonations ? totalDonated(donor.donations) : '',
      donations: includeDonations ? donor.donations : [],
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
      employer: '',
      // No communication-preference columns configured for local preview — same "not
      // knowable yet" null the real client returns for an unconfigured column.
      emailOptOut: null,
      smsOptOut: null,
      doNotMail: null,
    };
  }

  async getVolunteerShiftsForDonor(donorItemId: string): Promise<VolunteerShift[]> {
    return VOLUNTEER_SHIFTS[donorItemId] ?? [];
  }

  async getDonorNames(donorItemIds: string[]): Promise<{ id: string; name: string }[]> {
    return donorItemIds.map((id) => ({ id, name: findDonor(id).name }));
  }

  async getPledgesForDonor(donorItemId: string): Promise<PledgeRecord[]> {
    return PLEDGES[donorItemId] ?? [];
  }

  async getEventRegistrationsForDonor(params: {
    donorItemId: string;
    boardId: number;
    columns: EventRegistrationColumns;
    eventDateColumnId: string;
  }): Promise<EventRegistrationRecord[]> {
    return EVENT_REGISTRATIONS[params.donorItemId] ?? [];
  }

  // Letter-cron settings and the year-end donor sweep are cron-only concerns, never exercised by
  // the interactive portal preview this fake backs — safe no-op defaults.
  async getLetterSettings(_params: {
    boardId: number;
    columns: LetterCronColumns;
    settingsItemName: string;
  }): Promise<LetterSettings | null> {
    return null;
  }

  async listDonorIdsWithDonationsInYear(_year: number, _excludedGiftTypes: string[]): Promise<string[]> {
    return [];
  }

  async findChangeRequestItem(_params: { boardId: number; itemName: string }): Promise<string | null> {
    return null;
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

  // Local preview has no Organizations or Affiliations data: every employer answer goes to staff.
  async findOrganizationsByNames(_params: { boardId: number; names: string[] }): Promise<OrganizationCandidate[]> {
    return [];
  }

  async getPersonAffiliations(_params: { donorItemId: string; employer: EmployerAnswerConfig }): Promise<AffiliationRecord[]> {
    return [];
  }

  async createAffiliation(params: { employer: EmployerAnswerConfig; itemName: string; donorItemId: string; organizationItemId: string }): Promise<void> {
    console.log(`[fakeMondayClient] would create affiliation: donor ${params.donorItemId} -> organization ${params.organizationItemId}`);
  }

  async updateAffiliation(params: { employer: EmployerAnswerConfig; itemId: string; makeCurrent: boolean; primary: boolean }): Promise<void> {
    console.log(`[fakeMondayClient] would update affiliation ${params.itemId}: makeCurrent=${params.makeCurrent} primary=${params.primary}`);
  }
}
