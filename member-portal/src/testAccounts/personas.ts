import type { DonationRecord, VolunteerShift } from '../types';

// Sandbox test accounts: fixed addresses that sign in at once (no magic-link email) and show the
// dummy people below instead of anything on a Monday board. Staff use them to try the portal and
// as a reference when helping a member ("what does a lapsed member see?"). One persona per
// membership state on the People board (Membership Status Active/Lapsed/blank × Tier
// Member/Lifetime), plus a renewal-window member, a shared household inbox and a Spanish
// speaker. The list for staff is in docs/uat/member-portal.md; keep the two in step.
//
// Dates are relative to the request's clock so "renews in two weeks" and "lapsed last year"
// stay true however long after this was written someone looks.
//
// Every address is on example.org (RFC 2606 reserved), so none can belong to a real donor, and
// every id starts with TEST_ID_PREFIX, which no Monday item id (all digits) can.

export const TEST_ID_PREFIX = 'test-';

export interface TestPersona {
  id: string;
  email: string;
  name: string;
  membershipStatus: string;
  membershipTier: string;
  membershipExpiry: string;
  address: string;
  phone: string;
  preferredLanguage: string;
  employer: string;
  donations: DonationRecord[];
  volunteerShifts: VolunteerShift[];
}

function isoDate(now: Date, offsetDays: number): string {
  return new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function testPersonas(now: Date): TestPersona[] {
  const d = (offsetDays: number) => isoDate(now, offsetDays);
  return [
    {
      id: 'test-active',
      email: 'test-active@example.org',
      name: 'Alex Active (test)',
      membershipStatus: 'Active',
      membershipTier: 'Member',
      membershipExpiry: d(240),
      address: '100 Test St, San José, CA 95113',
      phone: '408-555-0101',
      preferredLanguage: 'English',
      employer: 'Example Corp',
      donations: [
        {
          date: d(-125),
          amount: '75.00',
          description: 'Membership',
          match: { date: d(-100), amount: '75.00', company: 'Example Corp' },
        },
        { date: d(-100), amount: '75.00', description: 'Matching Donation' },
        { date: d(-60), amount: '50.00', description: 'Donation', matchHintUrl: 'https://doublethedonation.com/' },
        { date: d(-30), amount: '35.00', description: 'Event Ticket' },
        { date: d(-490), amount: '75.00', description: 'Membership' },
        { date: d(-400), amount: '250.00', description: 'Donor Advised Fund' },
      ],
      volunteerShifts: [
        { date: d(-200), hours: '3.5', job: 'Bike Valet', status: 'Completed' },
        { date: d(-45), hours: '2', job: 'Tabling — Bike to Work Day', status: 'Completed' },
      ],
    },
    {
      id: 'test-renewing',
      email: 'test-renewing@example.org',
      name: 'Riley Renewing (test)',
      membershipStatus: 'Active',
      membershipTier: 'Member',
      membershipExpiry: d(14),
      address: '200 Test Ave, Sunnyvale, CA 94086',
      phone: '408-555-0102',
      preferredLanguage: 'English',
      employer: '',
      donations: [
        { date: d(-351), amount: '50.00', description: 'Membership' },
        { date: d(-716), amount: '50.00', description: 'Membership' },
      ],
      volunteerShifts: [],
    },
    {
      id: 'test-lifetime',
      email: 'test-lifetime@example.org',
      name: 'Lee Lifetime (test)',
      membershipStatus: 'Active',
      membershipTier: 'Lifetime',
      // Lifetime members have no Member Until date; the card reads "No expiration".
      membershipExpiry: '',
      address: '300 Test Blvd, Palo Alto, CA 94301',
      phone: '650-555-0103',
      preferredLanguage: 'English',
      employer: '',
      donations: [
        { date: d(-300), amount: '1000.00', description: 'Lifetime Membership' },
        { date: d(-20), amount: '100.00', description: 'Donation' },
      ],
      volunteerShifts: [{ date: d(-150), hours: '4', job: 'Ride Marshal', status: 'Completed' }],
    },
    {
      id: 'test-lapsed',
      email: 'test-lapsed@example.org',
      name: 'Logan Lapsed (test)',
      membershipStatus: 'Lapsed',
      membershipTier: 'Member',
      membershipExpiry: d(-90),
      address: '400 Test Way, Mountain View, CA 94041',
      phone: '',
      preferredLanguage: 'English',
      employer: '',
      donations: [{ date: d(-455), amount: '50.00', description: 'Membership' }],
      volunteerShifts: [],
    },
    {
      id: 'test-donor',
      email: 'test-donor@example.org',
      name: 'Dana Donor (test)',
      // Gave, never joined: Membership Status and Tier both blank on the People board.
      membershipStatus: '',
      membershipTier: '',
      membershipExpiry: '',
      address: '',
      phone: '408-555-0105',
      preferredLanguage: 'English',
      employer: '',
      donations: [
        { date: d(-80), amount: '25.00', description: 'Donation' },
        { date: d(-10), amount: '40.00', description: 'Donation' },
      ],
      volunteerShifts: [],
    },
    {
      id: 'test-household-a',
      email: 'test-household@example.org',
      name: 'Harper Household (test)',
      membershipStatus: 'Active',
      membershipTier: 'Member',
      membershipExpiry: d(180),
      address: '600 Test Ct, Santa Clara, CA 95050',
      phone: '408-555-0106',
      preferredLanguage: 'English',
      employer: '',
      donations: [{ date: d(-185), amount: '75.00', description: 'Membership' }],
      volunteerShifts: [],
    },
    {
      id: 'test-household-b',
      email: 'test-household@example.org',
      name: 'Hayden Household (test)',
      membershipStatus: 'Lapsed',
      membershipTier: 'Member',
      membershipExpiry: d(-30),
      address: '600 Test Ct, Santa Clara, CA 95050',
      phone: '408-555-0107',
      preferredLanguage: 'English',
      employer: '',
      donations: [],
      volunteerShifts: [],
    },
    {
      id: 'test-spanish',
      email: 'test-spanish@example.org',
      name: 'Sofía Español (test)',
      membershipStatus: 'Active',
      membershipTier: 'Member',
      membershipExpiry: d(300),
      address: '700 Calle Prueba, San José, CA 95116',
      phone: '408-555-0108',
      preferredLanguage: 'Spanish',
      employer: '',
      donations: [{ date: d(-65), amount: '50.00', description: 'Membership' }],
      volunteerShifts: [],
    },
  ];
}

export function isTestDonorId(id: string): boolean {
  return id.startsWith(TEST_ID_PREFIX);
}

export function findTestPersonasByEmail(email: string, now: Date): TestPersona[] {
  const wanted = email.trim().toLowerCase();
  return testPersonas(now).filter((p) => p.email === wanted);
}

export function findTestPersona(id: string, now: Date): TestPersona {
  const persona = testPersonas(now).find((p) => p.id === id);
  if (persona === undefined) throw new Error(`test accounts: no persona "${id}"`);
  return persona;
}
