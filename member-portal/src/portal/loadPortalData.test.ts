import { describe, it, expect, vi } from 'vitest';
import { buildVolunteerHistory, loadPortalData } from './loadPortalData';
import type { MondayClient } from '../monday/client';
import type { MemberPortalData, VolunteerShift } from '../types';

function donor(id: string, name: string): MemberPortalData {
  return { id, name, membershipStatus: 'Active', membershipTier: 'Member', totalDonated: '100', donations: [], membershipExpiry: '' };
}

function fakeMonday(shiftsByDonor: Record<string, VolunteerShift[]> = {}): MondayClient {
  return {
    findDonorsByEmail: vi.fn(),
    getMemberPortalData: vi
      .fn()
      .mockImplementation((id: string) => Promise.resolve(donor(id, id === 'donor-1' ? 'Jane' : 'Jane Also'))),
    getDiscountOrganizations: vi.fn().mockResolvedValue([{ name: 'Local Bikes', discountOffered: '10% off' }]),
    getVolunteerShiftsForDonor: vi.fn().mockImplementation((id: string) => Promise.resolve(shiftsByDonor[id] ?? [])),
    getDonorContactInfo: vi.fn(),
    findChangeRequestItem: vi.fn().mockResolvedValue(null),
    findOrganizationsByNames: vi.fn().mockResolvedValue([]),
    getPersonAffiliations: vi.fn().mockResolvedValue([]),
    createAffiliation: vi.fn(),
    updateAffiliation: vi.fn(),
    createChangeRequestItem: vi.fn(),
    getDonorNames: vi.fn().mockResolvedValue([]),
    getEventRegistrationsForDonor: vi.fn().mockResolvedValue([]),
    getPledgesForDonor: vi.fn().mockResolvedValue([]),
    getLetterSettings: vi.fn(),
    listDonorIdsWithDonationsInYear: vi.fn(),
  };
}

describe('loadPortalData', () => {
  it('fetches each donor id independently and one shared discount list', async () => {
    const monday = fakeMonday();

    const result = await loadPortalData(['donor-1', 'donor-2'], monday);

    expect(result.donors).toEqual([donor('donor-1', 'Jane'), donor('donor-2', 'Jane Also')]);
    expect(result.discounts).toEqual([{ name: 'Local Bikes', discountOffered: '10% off' }]);
    expect(monday.getDiscountOrganizations).toHaveBeenCalledTimes(1);
  });

  // Issue #31: a household login spans several donor items — one bad record (deleted item,
  // Monday error on that id) must cost only that donor's section, not the whole dashboard.
  it('drops a donor whose record fails to load, keeps the rest, and counts the gap', async () => {
    const monday = fakeMonday();
    (monday.getMemberPortalData as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'donor-2' ? Promise.reject(new Error('monday: item not found')) : Promise.resolve(donor(id, 'Jane'))
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await loadPortalData(['donor-1', 'donor-2'], monday);

    expect(result.donors).toEqual([donor('donor-1', 'Jane')]);
    expect(result.unavailableDonorCount).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('donor-2'));
    errorSpy.mockRestore();
  });

  it('still fails when no donor record loads at all (nothing to show)', async () => {
    const monday = fakeMonday();
    (monday.getMemberPortalData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(loadPortalData(['donor-1', 'donor-2'], monday)).rejects.toThrow('monday: HTTP 500');
    vi.restoreAllMocks();
  });

  it('degrades discounts to null (section omitted) when the Organizations read fails', async () => {
    const monday = fakeMonday();
    (monday.getDiscountOrganizations as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 429'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await loadPortalData(['donor-1'], monday);

    expect(result.discounts).toBeNull();
    expect(result.donors).toHaveLength(1);
    expect(result.unavailableDonorCount).toBe(0);
    vi.restoreAllMocks();
  });

  it('marks donation history enabled and asks Monday for donations by default', async () => {
    const monday = fakeMonday();

    const result = await loadPortalData(['donor-1'], monday);

    expect(result.donationHistoryEnabled).toBe(true);
    expect(monday.getMemberPortalData).toHaveBeenCalledWith('donor-1', { includeDonations: true });
  });

  it('skips the donations read and marks the view hidden when donation history is gated off', async () => {
    const monday = fakeMonday();

    const result = await loadPortalData(['donor-1', 'donor-2'], monday, undefined, false);

    expect(result.donationHistoryEnabled).toBe(false);
    expect(monday.getMemberPortalData).toHaveBeenCalledWith('donor-1', { includeDonations: false });
    expect(monday.getMemberPortalData).toHaveBeenCalledWith('donor-2', { includeDonations: false });
    // The rest of the dashboard still loads.
    expect(result.donors.map((d) => d.name)).toEqual(['Jane', 'Jane Also']);
    expect(result.discounts).toHaveLength(1);
  });

  it('leaves volunteerHistory null (and never queries Monday for shifts) when the feature is off', async () => {
    const monday = fakeMonday();

    const result = await loadPortalData(['donor-1'], monday, { enabled: false, completedStatuses: ['Completed'] });

    expect(result.volunteerHistory).toBeNull();
    expect(monday.getVolunteerShiftsForDonor).not.toHaveBeenCalled();
  });

  it('defaults volunteerHistory to null when no options are passed at all', async () => {
    const result = await loadPortalData(['donor-1'], fakeMonday());
    expect(result.volunteerHistory).toBeNull();
  });

  it('degrades to volunteerHistory null (rest of the page intact) when the Volunteers read fails', async () => {
    const monday = fakeMonday();
    (monday.getVolunteerShiftsForDonor as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 403'));

    const result = await loadPortalData(['donor-1'], monday, { enabled: true, completedStatuses: ['Completed'] });

    expect(result.volunteerHistory).toBeNull();
    expect(result.donors).toHaveLength(1);
    expect(result.discounts).toEqual([{ name: 'Local Bikes', discountOffered: '10% off' }]);
  });

  it('builds a per-donor volunteer history when enabled', async () => {
    const monday = fakeMonday({
      'donor-1': [
        { date: '2026-01-10', hours: '2', job: 'Tabling', status: 'Completed' },
        { date: '2026-03-05', hours: '3.5', job: 'Bike Valet', status: 'Completed' },
        { date: '2026-02-01', hours: '4', job: 'Ride Marshal', status: 'No-Show' },
      ],
    });

    const result = await loadPortalData(['donor-1', 'donor-2'], monday, {
      enabled: true,
      completedStatuses: ['Completed'],
    });

    expect(result.volunteerHistory).toEqual({
      'donor-1': {
        shifts: [
          { date: '2026-03-05', hours: '3.5', job: 'Bike Valet', status: 'Completed' },
          { date: '2026-01-10', hours: '2', job: 'Tabling', status: 'Completed' },
        ],
        totalHours: 5.5,
      },
      'donor-2': { shifts: [], totalHours: 0 },
    });
  });
});

describe('buildVolunteerHistory', () => {
  const shifts: VolunteerShift[] = [
    { date: '2026-01-10', hours: '2.1', job: 'Tabling', status: 'Completed' },
    { date: '', hours: '1', job: 'Office help', status: 'Completed' },
    { date: '2026-03-05', hours: '0.2', job: 'Bike Valet', status: 'Completed' },
    { date: '2026-02-01', hours: '4', job: 'Ride Marshal', status: 'No-Show' },
  ];

  it('keeps only shifts whose status is in completedStatuses', () => {
    const history = buildVolunteerHistory(shifts, ['Completed']);
    expect(history.shifts.map((s) => s.job)).not.toContain('Ride Marshal');
  });

  it('includes every status when completedStatuses is empty', () => {
    const history = buildVolunteerHistory(shifts, []);
    expect(history.shifts).toHaveLength(4);
    expect(history.totalHours).toBe(7.3);
  });

  it('sorts most recent first, undated shifts last, and rounds the hours sum', () => {
    const history = buildVolunteerHistory(shifts, ['Completed']);
    expect(history.shifts.map((s) => s.date)).toEqual(['2026-03-05', '2026-01-10', '']);
    // 2.1 + 1 + 0.2 would be 3.3000000000000003 without rounding.
    expect(history.totalHours).toBe(3.3);
  });

  it('treats unparseable hours as zero', () => {
    const history = buildVolunteerHistory([{ date: '2026-01-01', hours: '', job: 'x', status: 'Completed' }], ['Completed']);
    expect(history.totalHours).toBe(0);
  });
});
