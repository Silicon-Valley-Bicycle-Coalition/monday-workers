import { describe, it, expect, vi } from 'vitest';
import { loadOrgPage, loadOrgStatement, statementExists } from './loadOrgData';
import { FakeMondayClient } from '../monday/fakeClient';
import type { Config } from '../types';

const config = {
  monday: { volunteersBoardId: null, columns: {} },
  changeRequests: { employer: { currentStatusLabel: 'Current' } },
  organizations: { portalAccessColumn: 'c', workEmailColumn: 'w', addressColumns: [], acknowledgmentSignedOff: false, volunteerFloor: 2 },
  taxLetter: {
    excludedGiftTypes: ['Grants'], separateGiftTypes: [], plainStatement: 'PLAIN', benefitStatement: 'B', benefitTiers: [], separateGiftsStatement: 'S',
  },
} as unknown as Config;
const now = () => new Date('2027-01-10T18:00:00Z');
const gifts = [
  { itemId: 'g1', date: '2026-02-01', amount: '$100.00', giftType: 'Donation' },
  { itemId: 'g2', date: '2025-02-01', amount: '$10.00', giftType: 'Donation' },
];

function setup() {
  const monday = new FakeMondayClient();
  monday.organizations.set('o1', { id: 'o1', name: 'Acme', address: '1 Main' });
  monday.orgGifts.set('o1', gifts);
  return monday;
}

describe('loadOrgPage', () => {
  it('returns null when the id is not an active organization', async () => {
    expect(await loadOrgPage('person-1', { monday: setup(), config, now })).toBeNull();
  });

  it('returns the organization, its records and the statement years', async () => {
    const page = (await loadOrgPage('o1', { monday: setup(), config, now }))!;
    expect(page.org.name).toBe('Acme');
    expect(page.years).toEqual([2026, 2025]);
    expect(page.gifts).toHaveLength(2);
  });
});

describe('loadOrgStatement', () => {
  it('builds a statement for a completed year', async () => {
    const s = (await loadOrgStatement('o1', 2026, { monday: setup(), config, now }))!;
    expect(s.totalSupport).toBe('$100.00');
    expect(s.volunteering).toBeNull();
  });

  it('is null for the current year, an empty year, or a non-organization', async () => {
    const deps = { monday: setup(), config, now };
    expect(await loadOrgStatement('o1', 2027, deps)).toBeNull();
    expect(await loadOrgStatement('o1', 2020, deps)).toBeNull();
    expect(await loadOrgStatement('person-1', 2026, deps)).toBeNull();
  });

  it('sweeps volunteers only when volunteer history is on, and survives a failed sweep', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const on = {
      ...config,
      monday: { volunteersBoardId: 5, columns: { volunteerDonorLink: 'a', volunteerHours: 'b', volunteerDate: 'c', volunteerJob: 'd', volunteerStatus: 'e' } },
    } as unknown as Config;
    const monday = setup();
    const sweep = vi.spyOn(monday, 'getCompletedVolunteerHoursInYear');
    await loadOrgStatement('o1', 2026, { monday, config, now });
    expect(sweep).not.toHaveBeenCalled();

    monday.affiliations.set('a1', { id: 'a1', personItemId: 'p1', organizationId: 'o1', statusLabel: 'Current', portalAccess: false, workEmail: '' });
    monday.affiliations.set('a2', { id: 'a2', personItemId: 'p2', organizationId: 'o1', statusLabel: 'Former', portalAccess: true, workEmail: '' });
    monday.volunteerHours.set('p1', 3);
    monday.volunteerHours.set('p2', 5);
    const onDeps = { monday, config: on, now };
    const ok = await loadOrgStatement('o1', 2026, onDeps);
    // Floor is 2 and only p1 is a Current employee.
    expect(ok!.volunteering).toBeNull();
    monday.affiliations.set('a3', { id: 'a3', personItemId: 'p3', organizationId: 'o1', statusLabel: 'Current', portalAccess: false, workEmail: '' });
    monday.volunteerHours.set('p3', 1.5);
    expect((await loadOrgStatement('o1', 2026, onDeps))!.volunteering).toEqual({ people: 2, hours: '4.5' });

    sweep.mockRejectedValue(new Error('down'));
    const failed = await loadOrgStatement('o1', 2026, onDeps);
    expect(failed!.totalSupport).toBe('$100.00');
    expect(failed!.volunteering).toBeNull();
    vi.restoreAllMocks();
  });

  it('propagates a failed gifts read', async () => {
    const monday = setup();
    vi.spyOn(monday, 'getOrganizationGifts').mockRejectedValue(new Error('down'));
    await expect(loadOrgStatement('o1', 2026, { monday, config, now })).rejects.toThrow('down');
  });
});

describe('statementExists', () => {
  it('reads only gifts and matches', async () => {
    const monday = setup();
    monday.orgGifts.set('o1', []);
    monday.orgMatches.set('o1', [{ itemId: 'm', date: '2026-04-01', amount: '$5.00', giftType: '' }]);
    const spies = [
      vi.spyOn(monday, 'getOrganization'),
      vi.spyOn(monday, 'getOrganizationAffiliations'),
      vi.spyOn(monday, 'getCompletedVolunteerHoursInYear'),
    ];
    const deps = { monday, config, now };
    expect(await statementExists('o1', 2026, deps)).toBe(true);
    expect(await statementExists('o1', 2025, deps)).toBe(false);
    expect(await statementExists('o1', 2027, deps)).toBe(false);
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
  });
});
