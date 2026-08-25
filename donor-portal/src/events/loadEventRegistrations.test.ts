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
    getDonorPortalData: vi.fn(),
    getDiscountOrganizations: vi.fn(),
    getDonorContactInfo: vi.fn(),
    createChangeRequestItem: vi.fn(),
    getVolunteerShiftsForDonor: vi.fn(),
    getPledgesForDonor: vi.fn().mockResolvedValue([]),
    getDonorNames: vi
      .fn()
      .mockImplementation(async (ids: string[]) => ids.map((id) => ({ id, name: `Donor ${id}` }))),
    getEventRegistrationsForDonor: vi
      .fn()
      .mockImplementation(async ({ donorItemId }: { donorItemId: string }) => registrationsByDonor[donorItemId] ?? []),
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
});
