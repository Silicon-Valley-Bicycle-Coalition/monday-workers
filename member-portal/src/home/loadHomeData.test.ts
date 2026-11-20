import { describe, it, expect, vi } from 'vitest';
import { loadHomeData } from './loadHomeData';
import type { MondayClient } from '../monday/client';
import type { CardTokenStore } from '../db/cardTokens';
import type { Config, MemberPortalData } from '../types';

function donor(id: string, overrides: Partial<MemberPortalData> = {}): MemberPortalData {
  return {
    id,
    name: `${id === 'j' ? 'Jordan' : 'Sam'} Rivera`,
    membershipStatus: 'Active',
    membershipTier: 'Member',
    totalDonated: '$0.00',
    donations: [],
    membershipExpiry: '2027-11-30',
    memberSince: '',
    memberType: '',
    ...overrides,
  };
}

// Only what the header loader may touch; everything else throws, so a read the header must never
// make (events) fails the test.
function fakeMonday(
  donors: Record<string, MemberPortalData | Error>,
  discounts: unknown = [{ name: 'A' }, { name: 'B' }],
  shifts: Record<string, { date: string; hours: string; job: string; status: string }[]> = {}
) {
  const forbidden = () => {
    throw new Error('the home page must not read this');
  };
  return {
    getMemberPortalData: vi.fn(async (id: string) => {
      const d = donors[id];
      if (d === undefined || d instanceof Error) throw d ?? new Error('no such donor');
      return d;
    }),
    getDiscountOrganizations: vi.fn(async () => {
      if (discounts instanceof Error) throw discounts;
      return discounts;
    }),
    getVolunteerShiftsForDonor: vi.fn(async (id: string) => shifts[id] ?? []),
    getEventRegistrationsForDonor: vi.fn(forbidden),
  } as unknown as MondayClient & {
    getMemberPortalData: ReturnType<typeof vi.fn>;
    getDiscountOrganizations: ReturnType<typeof vi.fn>;
    getVolunteerShiftsForDonor: ReturnType<typeof vi.fn>;
    getEventRegistrationsForDonor: ReturnType<typeof vi.fn>;
  };
}

function cardStore(): CardTokenStore {
  const tokens = new Map<string, string>();
  return {
    createToken: async (id, token) => void tokens.set(id, token),
    findActiveDonorId: async () => null,
    getActiveToken: async (id) => tokens.get(id) ?? null,
    revokeAllForDonor: async () => {},
    purgeRevokedBefore: async () => 0,
  };
}

const baseConfig = {
  monday: { volunteersBoardId: 5, columns: { membershipExpiry: 'date_exp' } },
  auth: { portalBaseUrl: 'https://portal.example.org' },
  taxLetter: {
    orgLegalName: 'SVBC',
    ein: '00-0000000',
    officeAddress: 'addr',
    signatureName: 'Alex',
    signatureTitle: 'ED',
    plainStatement: 'plain',
    benefitStatement: 'benefit',
    benefitTiers: [],
    excludedGiftTypes: [],
    separateGiftTypes: [],
    separateGiftsStatement: 'separate',
  },
  eventRegistrations: { boardId: 9, columns: { attendeeLink: 'a', eventLink: 'b', attended: 'c' }, eventDateColumnId: 'd' },
  getInvolved: { links: [] },
  funraise: { manageRecurringUrl: '', renewMembershipUrl: '' },
  home: { newMemberDays: 60, renewalWarningDays: 30, taxLetterUntil: '04-15' },
  donations: { historyVisibleFromISO: null },
  volunteerHistory: { completedStatuses: ['Completed'] },
} as unknown as Config;

function deps(monday: MondayClient, now = '2027-01-10T18:00:00Z', config: Config = baseConfig) {
  return { monday, config, now: () => new Date(now), cardTokenStore: cardStore() };
}

// A full-donor read (the letter's) returns last year's gifts.
function withGifts(d: MemberPortalData): MemberPortalData {
  return {
    ...d,
    donations: [
      { date: '2026-02-01', amount: '$100.00', description: 'gift' },
      { date: '2026-06-01', amount: '$100.00', description: 'gift' },
      { date: '2026-09-01', amount: '$50.00', description: 'gift' },
    ],
  };
}

describe('loadHomeData', () => {
  it('reads each person without donations while the history gate is closed, plus the discount list once', async () => {
    const monday = fakeMonday({ j: donor('j'), s: donor('s') });
    const data = await loadHomeData(['j', 's'], deps(monday, '2026-08-22T18:00:00Z'), 'en');

    expect(monday.getMemberPortalData).toHaveBeenCalledWith('j', { includeDonations: false });
    expect(monday.getMemberPortalData).toHaveBeenCalledWith('s', { includeDonations: false });
    expect(monday.getMemberPortalData).toHaveBeenCalledTimes(2); // outside the letter window
    expect(monday.getDiscountOrganizations).toHaveBeenCalledTimes(1);
    expect(data.discountCount).toBe(2);
    expect(data.people.map((e) => e.person.firstName)).toEqual(['Jordan', 'Sam']);
    expect(data.people.every((e) => e.card !== null)).toBe(true);
    expect(data.unavailableCount).toBe(0);
  });

  it('reads volunteer shifts for the totals, never events', async () => {
    const monday = fakeMonday({ j: donor('j') });
    const data = await loadHomeData(['j'], deps(monday), 'en');
    expect(monday.getVolunteerShiftsForDonor).toHaveBeenCalledWith('j');
    expect(monday.getEventRegistrationsForDonor).not.toHaveBeenCalled();
    expect(data.portal.volunteerHistory).toEqual({ j: { shifts: [], totalHours: 0 } });
  });

  it("gives each person's card their completed volunteer hours and, behind the history gate, their total given", async () => {
    const config = structuredClone(baseConfig);
    config.donations.historyVisibleFromISO = '2020-01-01';
    const monday = fakeMonday({ j: donor('j', { totalDonated: '$1,250.00' }), s: donor('s', { totalDonated: '' }) }, undefined, {
      j: [
        { date: '2026-03-01', hours: '2.5', job: 'Valet', status: 'Completed' },
        { date: '2026-04-01', hours: '4', job: 'Valet', status: 'No-show' },
      ],
    });
    const data = await loadHomeData(['j', 's'], deps(monday, '2026-08-22T18:00:00Z', config), 'en');
    expect(monday.getMemberPortalData).toHaveBeenCalledWith('j', { includeDonations: true });
    expect(data.people[0]!.stats).toMatchObject({ totalDonated: '$1,250.00', volunteerHours: 2.5 });
    // A total that doesn't parse is left off the card rather than shown as $0.00.
    expect(data.people[1]!.stats).toMatchObject({ totalDonated: null, volunteerHours: 0 });
    expect(data.portal.donationHistoryEnabled).toBe(true);
  });

  it('shows no total given while the history gate is closed, and no hours with volunteer history off', async () => {
    const config = structuredClone(baseConfig);
    config.monday.volunteersBoardId = null;
    const monday = fakeMonday({ j: donor('j', { totalDonated: '$1,250.00' }) });
    const data = await loadHomeData(['j'], deps(monday, '2026-08-22T18:00:00Z', config), 'en');
    expect(data.people[0]!.stats).toMatchObject({ totalDonated: null, volunteerHours: null });
    expect(monday.getVolunteerShiftsForDonor).not.toHaveBeenCalled();
  });

  it('keeps the totals off, not the page, when the volunteer read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const monday = fakeMonday({ j: donor('j') });
    monday.getVolunteerShiftsForDonor.mockRejectedValue(new Error('monday: HTTP 500'));
    const data = await loadHomeData(['j'], deps(monday), 'en');
    expect(data.people[0]!.stats.volunteerHours).toBeNull();
    vi.restoreAllMocks();
  });

  it("loads last year's letter in the window, when letters are enabled", async () => {
    const j = donor('j');
    const monday = fakeMonday({ j });
    // The unfiltered read is the letter's; it carries the gifts.
    monday.getMemberPortalData.mockImplementation(async (_id: string, options?: { includeDonations?: boolean }) =>
      options?.includeDonations === false ? j : withGifts(j)
    );
    const data = await loadHomeData(['j'], deps(monday), 'en');

    expect(data.people[0]!.person.letter).toEqual({ year: 2026, giftCount: 3, totalFormatted: '$250.00' });
    expect(data.people[0]!.state.kind).toBe('taxLetter');
    expect(data.page).toEqual({ kind: 'taxLetter', personIds: ['j'] });
  });

  it('skips the letter read after taxLetterUntil', async () => {
    const monday = fakeMonday({ j: donor('j') });
    const data = await loadHomeData(['j'], deps(monday, '2027-04-16T18:00:00Z'), 'en');
    expect(monday.getMemberPortalData).toHaveBeenCalledTimes(1);
    expect(data.people[0]!.person.letter).toBeNull();
  });

  it('skips the letter read while letters are signed off', async () => {
    const config = structuredClone(baseConfig);
    config.taxLetter.ein = 'REPLACE_AFTER_SIGNOFF';
    const monday = fakeMonday({ j: donor('j') });
    await loadHomeData(['j'], deps(monday, '2027-01-10T18:00:00Z', config), 'en');
    expect(monday.getMemberPortalData).toHaveBeenCalledTimes(1);
  });

  it('drops a person whose read failed and counts them', async () => {
    const monday = fakeMonday({ j: donor('j'), s: new Error('monday: HTTP 500') });
    const data = await loadHomeData(['j', 's'], deps(monday, '2026-08-22T18:00:00Z'), 'en');
    expect(data.people.map((e) => e.person.id)).toEqual(['j']);
    expect(data.unavailableCount).toBe(1);
  });

  it('throws when nobody loaded, so the route shows its error page', async () => {
    const monday = fakeMonday({ j: new Error('monday: HTTP 500') });
    await expect(loadHomeData(['j'], deps(monday), 'en')).rejects.toThrow('HTTP 500');
  });

  it('a failed letter read leaves that person with no letter', async () => {
    const j = donor('j');
    const monday = fakeMonday({ j });
    monday.getMemberPortalData.mockImplementation(async (_id: string, options?: { includeDonations?: boolean }) => {
      if (options?.includeDonations === false) return j;
      throw new Error('monday: HTTP 429');
    });
    const data = await loadHomeData(['j'], deps(monday), 'en');
    expect(data.people[0]!.person.letter).toBeNull();
    expect(data.unavailableCount).toBe(0);
  });

  it('discountCount is null when the discount read fails', async () => {
    const monday = fakeMonday({ j: donor('j') }, new Error('monday: HTTP 500'));
    const data = await loadHomeData(['j'], deps(monday), 'en');
    expect(data.discountCount).toBeNull();
  });

  it('gives a never-member no card', async () => {
    const monday = fakeMonday({ j: donor('j', { membershipStatus: '', membershipTier: '', membershipExpiry: '' }) });
    const data = await loadHomeData(['j'], deps(monday), 'en');
    expect(data.people[0]!.state).toEqual({ kind: 'renew', reason: 'never', date: null });
    expect(data.people[0]!.card).toBeNull();
  });

  it('gives no card to someone with a Tier but a blank Membership Status', async () => {
    const monday = fakeMonday({ j: donor('j', { membershipStatus: ' ', membershipTier: 'Member' }), s: donor('s') });
    const data = await loadHomeData(['j', 's'], deps(monday), 'en');
    expect(data.people[0]!.card).toBeNull();
    expect(data.people[1]!.card).not.toBeNull();
  });

  it('marks an Active membership past its Member Until as ended and lapsed', async () => {
    const monday = fakeMonday({ j: donor('j', { membershipExpiry: '2026-10-31' }), s: donor('s') });
    const data = await loadHomeData(['j', 's'], deps(monday, '2026-12-01T18:00:00Z'), 'en');
    expect(data.people[0]!.state).toEqual({ kind: 'renew', reason: 'lapsed', date: '2026-10-31' });
    expect(data.people[0]!.ended).toBe(true);
    expect(data.people[1]!.ended).toBe(false);
  });

  it('lists the five tabs in order', async () => {
    const monday = fakeMonday({ j: donor('j') });
    const data = await loadHomeData(['j'], deps(monday, '2026-08-22T18:00:00Z'), 'en');
    expect(data.tabs).toEqual([
      { key: 'benefits', href: '/en/portal' },
      { key: 'giving', href: '/en/portal/giving' },
      { key: 'events', href: '/en/portal/events' },
      { key: 'volunteering', href: '/en/portal/volunteering' },
      { key: 'profile', href: '/en/portal/info' },
    ]);
  });

  it('leaves out Events and Volunteering when their features and links are off', async () => {
    const config = structuredClone(baseConfig);
    config.eventRegistrations.boardId = null;
    config.monday.volunteersBoardId = null;
    const monday = fakeMonday({ j: donor('j') });
    const data = await loadHomeData(['j'], deps(monday, '2026-08-22T18:00:00Z', config), 'en');
    expect(data.tabs.map((d) => d.key)).toEqual(['benefits', 'giving', 'profile']);
  });

  it('keeps Events for a meeting link and Volunteering for a volunteer link, features off', async () => {
    const config = structuredClone(baseConfig);
    config.eventRegistrations.boardId = null;
    config.monday.volunteersBoardId = null;
    const monday = fakeMonday({ j: donor('j') });
    config.getInvolved.links = [{ category: 'civic', url: 'https://x.example', label: 'BPAC' }];
    let data = await loadHomeData(['j'], deps(monday, '2026-08-22T18:00:00Z', config), 'en');
    expect(data.tabs.map((d) => d.key)).toEqual(['benefits', 'giving', 'events', 'profile']);
    config.getInvolved.links = [{ category: 'volunteer', url: 'https://x.example' }];
    data = await loadHomeData(['j'], deps(monday, '2026-08-22T18:00:00Z', config), 'en');
    expect(data.tabs.map((d) => d.key)).toEqual(['benefits', 'giving', 'volunteering', 'profile']);
  });
});

describe('loadHomeData organizations', () => {
  const orgConfig = {
    ...baseConfig,
    monday: { ...baseConfig.monday, organizationsBoardId: 77 },
    changeRequests: { employer: {} },
    organizations: { portalAccessColumn: 'check_portal' },
    // Off: the registrations read also looks names up, which these tests count.
    eventRegistrations: { ...baseConfig.eventRegistrations, boardId: null },
  } as unknown as Config;
  const grants = [
    { orgItemId: 'o1', affiliationItemId: 'a1', via: 'person' as const, personItemId: 'j' },
    { orgItemId: 'o2', affiliationItemId: 'a2', via: 'workEmail' as const, personItemId: null },
  ];
  const withNames = (monday: MondayClient, impl: () => Promise<{ id: string; name: string }[]>) =>
    Object.assign(monday, { getDonorNames: vi.fn(impl) }) as MondayClient & { getDonorNames: ReturnType<typeof vi.fn> };

  it('reads the names in one call and keeps grant order', async () => {
    const monday = withNames(fakeMonday({ j: donor('j') }), async () => [
      { id: 'o2', name: 'Bike Shop' },
      { id: 'o1', name: 'Acme' },
    ]);
    const data = await loadHomeData(['j'], deps(monday, '2027-01-10T18:00:00Z', orgConfig), 'en', grants);
    expect(monday.getDonorNames).toHaveBeenCalledTimes(1);
    expect(monday.getDonorNames).toHaveBeenCalledWith(['o1', 'o2']);
    expect(data.orgs).toEqual([
      { orgItemId: 'o1', name: 'Acme', statementReadyYear: null },
      { orgItemId: 'o2', name: 'Bike Shop', statementReadyYear: null },
    ]);
  });

  it("marks last year's statement ready in the window, per organization", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const monday = withNames(fakeMonday({ j: donor('j') }), async () => [
      { id: 'o1', name: 'Acme' },
      { id: 'o2', name: 'Bike Shop' },
    ]);
    Object.assign(monday, {
      getOrganizationGifts: vi.fn(async (id: string) => {
        if (id === 'o2') throw new Error('monday down');
        return [{ itemId: 'g', date: '2026-05-01', amount: '$5.00', giftType: 'Donation', description: 'x' }];
      }),
      getOrganizationMatches: vi.fn(async () => []),
    });
    const extra = { getOrganizationAffiliations: vi.fn(), getCompletedVolunteerHoursInYear: vi.fn() };
    Object.assign(monday, extra);
    const full = { ...orgConfig, organizations: { ...orgConfig.organizations, volunteerFloor: 3, acknowledgmentSignedOff: false } } as unknown as Config;
    const inWindow = await loadHomeData(['j'], deps(monday, '2027-01-10T18:00:00Z', full), 'en', grants);
    expect(inWindow.orgs.map((o) => o.statementReadyYear)).toEqual([2026, null]);
    expect(extra.getOrganizationAffiliations).not.toHaveBeenCalled();
    expect(extra.getCompletedVolunteerHoursInYear).not.toHaveBeenCalled();
    const after = await loadHomeData(['j'], deps(monday, '2027-06-10T18:00:00Z', full), 'en', grants);
    expect(after.orgs.map((o) => o.statementReadyYear)).toEqual([null, null]);
    vi.restoreAllMocks();
  });

  it('reports the year when last year has only a match', async () => {
    const monday = withNames(fakeMonday({ j: donor('j') }), async () => [{ id: 'o1', name: 'Acme' }]);
    Object.assign(monday, {
      getOrganizationGifts: vi.fn(async () => []),
      getOrganizationMatches: vi.fn(async () => [{ itemId: 'm', date: '2026-05-01', amount: '$5.00', giftType: '', description: 'x' }]),
    });
    const data = await loadHomeData(['j'], deps(monday, '2027-01-10T18:00:00Z', orgConfig), 'en', grants.slice(0, 1));
    expect(data.orgs[0]!.statementReadyYear).toBe(2026);
  });

  it('leaves names null when the read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const monday = withNames(fakeMonday({ j: donor('j') }), async () => {
      throw new Error('monday down');
    });
    const data = await loadHomeData(['j'], deps(monday, '2027-01-10T18:00:00Z', orgConfig), 'en', grants);
    expect(data.orgs.map((o) => o.name)).toEqual([null, null]);
    expect(data.people).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('reads no names with the gate off or no grants', async () => {
    const monday = withNames(fakeMonday({ j: donor('j') }), async () => []);
    const gateOff = { ...orgConfig, organizations: { portalAccessColumn: 'REPLACE_WITH_COLUMN_ID' } } as unknown as Config;
    expect((await loadHomeData(['j'], deps(monday, '2027-01-10T18:00:00Z', gateOff), 'en', grants)).orgs).toEqual([]);
    expect((await loadHomeData(['j'], deps(monday, '2027-01-10T18:00:00Z', orgConfig), 'en')).orgs).toEqual([]);
    expect(monday.getDonorNames).not.toHaveBeenCalled();
  });

  it('loads a session with no people: no person reads, no tabs', async () => {
    const monday = withNames(fakeMonday({}), async () => [{ id: 'o1', name: 'Acme' }]);
    const data = await loadHomeData([], deps(monday, '2027-01-10T18:00:00Z', orgConfig), 'en', grants.slice(0, 1));
    expect(monday.getMemberPortalData).not.toHaveBeenCalled();
    expect(data.people).toEqual([]);
    expect(data.tabs).toEqual([]);
    expect(data.orgs).toHaveLength(1);
  });
});
