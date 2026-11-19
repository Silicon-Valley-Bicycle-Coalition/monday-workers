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

// Only what the home loader may touch; everything else throws, so a read the home page must
// never make (events, volunteer shifts) fails the test.
function fakeMonday(donors: Record<string, MemberPortalData | Error>, discounts: unknown = [{ name: 'A' }, { name: 'B' }]) {
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
    getVolunteerShiftsForDonor: vi.fn(forbidden),
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
  it('reads each person without donations, plus the discount list once for the shop count', async () => {
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

  it('never loads events or volunteer shifts', async () => {
    const monday = fakeMonday({ j: donor('j') });
    await loadHomeData(['j'], deps(monday), 'en');
    expect(monday.getVolunteerShiftsForDonor).not.toHaveBeenCalled();
    expect(monday.getEventRegistrationsForDonor).not.toHaveBeenCalled();
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

  it('lists the five doors in order', async () => {
    const monday = fakeMonday({ j: donor('j') });
    const data = await loadHomeData(['j'], deps(monday, '2026-08-22T18:00:00Z'), 'en');
    expect(data.doors.map((d) => d.key)).toEqual(['card', 'giving', 'letters', 'activity', 'info']);
    expect(data.doors.map((d) => d.href)).toEqual([
      '/en/portal/card',
      '/en/portal/giving',
      '/en/portal/letters',
      '/en/portal/activity',
      '/en/portal/info',
    ]);
    expect(data.doors[0]!.hint).toBe('2 shops · keep it on your phone');
    expect(data.doors[2]!.hint).toBe('2026 ready in January');
  });

  it('leaves out a door whose features are all gated off', async () => {
    const config = structuredClone(baseConfig);
    config.taxLetter.ein = 'REPLACE_AFTER_SIGNOFF';
    config.eventRegistrations.boardId = null;
    config.monday.volunteersBoardId = null;
    const monday = fakeMonday({ j: donor('j') });
    const data = await loadHomeData(['j'], deps(monday, '2026-08-22T18:00:00Z', config), 'en');
    expect(data.doors.map((d) => d.key)).toEqual(['card', 'giving', 'info']);
  });

  it("says the letters door's letter is ready in the window", async () => {
    const j = donor('j');
    const monday = fakeMonday({ j });
    monday.getMemberPortalData.mockImplementation(async (_id: string, options?: { includeDonations?: boolean }) =>
      options?.includeDonations === false ? j : withGifts(j)
    );
    const data = await loadHomeData(['j'], deps(monday), 'en');
    expect(data.doors.find((d) => d.key === 'letters')!.hint).toBe('Your 2026 letter is ready');
  });
});
