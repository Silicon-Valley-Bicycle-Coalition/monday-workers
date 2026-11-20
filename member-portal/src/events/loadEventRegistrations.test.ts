import { describe, it, expect, vi } from 'vitest';
import { loadEventRegistrations } from './loadEventRegistrations';
import type { MondayClient } from '../monday/client';
import type { EventRegistrationRecord, EventRegistrationsConfig } from '../types';

const eventConfig: EventRegistrationsConfig = {
  boardId: 555,
  columns: { attendeeLink: 'connect_att', eventLink: 'connect_ev', attended: 'check_att' },
  eventDateColumnId: 'ev_date_col',
};

const NOW = new Date('2026-08-25T12:00:00Z');

function record(overrides: Partial<EventRegistrationRecord>): EventRegistrationRecord {
  return { registrationName: 'reg', eventName: 'Event', eventDate: '2026-01-01', attended: false, ...overrides };
}

function fakeMonday(registrationsByDonor: Record<string, EventRegistrationRecord[]>): MondayClient {
  return {
    findDonorsByEmail: vi.fn(),
    getMemberPortalData: vi.fn(),
    getDiscountOrganizations: vi.fn(),
    getDonorContactInfo: vi.fn(),
    getDonorEmails: vi.fn(),
    findChangeRequestItem: vi.fn().mockResolvedValue(null),
    findOrganizationsByNames: vi.fn().mockResolvedValue([]),
    getPersonAffiliations: vi.fn().mockResolvedValue([]),
    createAffiliation: vi.fn(),
    updateAffiliation: vi.fn(),
    setDonorCheckbox: vi.fn().mockResolvedValue(undefined),
    createChangeRequestItem: vi.fn(),
    getVolunteerShiftsForDonor: vi.fn(),
    getPledgesForDonor: vi.fn().mockResolvedValue([]),
    getDonorNames: vi
      .fn()
      .mockImplementation(async (ids: string[]) => ids.map((id) => ({ id, name: `Donor ${id}` }))),
    getEventRegistrationsForDonor: vi
      .fn()
      .mockImplementation(async ({ donorItemId }: { donorItemId: string }) => registrationsByDonor[donorItemId] ?? []),
    getLetterSettings: vi.fn(),
    listYearActivity: vi.fn(),
    findAffiliationsByWorkEmail: vi.fn().mockResolvedValue([]),
    getAffiliation: vi.fn().mockResolvedValue(null),
    getOrganizationAffiliations: vi.fn().mockResolvedValue([]),
    getOrganization: vi.fn().mockResolvedValue(null),
    getOrganizationGifts: vi.fn().mockResolvedValue([]),
    getOrganizationMatches: vi.fn().mockResolvedValue([]),
    getCompletedVolunteerHoursInYear: vi.fn().mockResolvedValue(new Map()),
  };
}

describe('loadEventRegistrations', () => {
  it('splits registrations into upcoming (today or later, soonest first) and past (latest first)', async () => {
    const monday = fakeMonday({
      'donor-1': [
        record({ eventName: 'Past Ride', eventDate: '2026-05-01' }),
        record({ eventName: 'Far Future Gala', eventDate: '2027-01-15' }),
        record({ eventName: 'Today Workshop', eventDate: '2026-08-25' }),
        record({ eventName: 'Older Ride', eventDate: '2025-11-30' }),
      ],
    });

    const listings = await loadEventRegistrations(['donor-1'], monday, eventConfig, NOW);

    expect(listings).toHaveLength(1);
    expect(listings[0]!.donorName).toBe('Donor donor-1');
    expect(listings[0]!.upcoming.map((r) => r.eventName)).toEqual(['Today Workshop', 'Far Future Gala']);
    expect(listings[0]!.past.map((r) => r.eventName)).toEqual(['Past Ride', 'Older Ride']);
  });

  it('puts undated registrations at the end of past, never in upcoming', async () => {
    const monday = fakeMonday({
      'donor-1': [
        record({ eventName: '', registrationName: 'Mystery signup', eventDate: '' }),
        record({ eventName: 'Past Ride', eventDate: '2026-05-01' }),
      ],
    });

    const listings = await loadEventRegistrations(['donor-1'], monday, eventConfig, NOW);

    expect(listings[0]!.upcoming).toEqual([]);
    expect(listings[0]!.past.map((r) => r.registrationName)).toEqual(['reg', 'Mystery signup']);
  });

  it('returns one labeled listing per donor item, preserving input order', async () => {
    const monday = fakeMonday({
      'donor-1': [record({ eventDate: '2026-05-01' })],
      'donor-2': [],
    });

    const listings = await loadEventRegistrations(['donor-1', 'donor-2'], monday, eventConfig, NOW);

    expect(listings.map((l) => [l.donorId, l.donorName])).toEqual([
      ['donor-1', 'Donor donor-1'],
      ['donor-2', 'Donor donor-2'],
    ]);
    expect(listings[1]!.upcoming).toEqual([]);
    expect(listings[1]!.past).toEqual([]);
  });

  it('falls back to the donor item id as the label when no name comes back', async () => {
    const monday = fakeMonday({});
    (monday.getDonorNames as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const listings = await loadEventRegistrations(['donor-1'], monday, eventConfig, NOW);

    expect(listings[0]!.donorName).toBe('donor-1');
  });

  // GL#99: the name lookup and the per-donor reads are independent, so all go out at once.
  it('issues the name lookup and every donor read before any of them answers', async () => {
    const monday = fakeMonday({});
    const release: (() => void)[] = [];
    const gate = <T>(value: T) => new Promise<T>((resolve) => release.push(() => resolve(value)));
    (monday.getDonorNames as ReturnType<typeof vi.fn>).mockImplementation((ids: string[]) =>
      gate(ids.map((id) => ({ id, name: `Donor ${id}` })))
    );
    (monday.getEventRegistrationsForDonor as ReturnType<typeof vi.fn>).mockImplementation(() => gate([]));

    const result = loadEventRegistrations(['donor-1', 'donor-2'], monday, eventConfig, NOW);
    await vi.waitFor(() => expect(release).toHaveLength(3));
    release.forEach((r) => r());

    expect((await result).map((l) => l.donorName)).toEqual(['Donor donor-1', 'Donor donor-2']);
  });
});
