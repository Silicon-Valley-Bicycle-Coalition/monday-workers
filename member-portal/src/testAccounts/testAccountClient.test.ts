import { describe, it, expect, vi } from 'vitest';
import type { MondayClient } from '../monday/client';
import { FakeMondayClient } from '../monday/fakeClient';
import { isTestSession, withTestAccounts } from './testAccountClient';
import { testPersonas } from './personas';

const NOW = new Date('2026-11-19T12:00:00.000Z');

function spyClient(): MondayClient {
  const real = new FakeMondayClient();
  for (const key of Object.getOwnPropertyNames(FakeMondayClient.prototype)) {
    if (key !== 'constructor') vi.spyOn(real as never, key as never);
  }
  return real;
}

describe('testPersonas', () => {
  const personas = testPersonas(NOW);

  it('covers every membership state on the People board', () => {
    const states = new Set(personas.map((p) => `${p.membershipStatus}/${p.membershipTier}`));
    expect(states).toEqual(new Set(['Active/Member', 'Active/Lifetime', 'Lapsed/Member', '/']));
  });

  it('uses only reserved example.org addresses and test- ids', () => {
    for (const p of personas) {
      expect(p.email).toMatch(/^test-[a-z]+@example\.org$/);
      expect(p.id).toMatch(/^test-/);
    }
  });

  it('dates the renewal-window member inside three weeks and the lapsed one in the past', () => {
    const today = NOW.toISOString().slice(0, 10);
    const renewing = personas.find((p) => p.id === 'test-renewing')!;
    const lapsed = personas.find((p) => p.id === 'test-lapsed')!;
    expect(renewing.membershipExpiry > today).toBe(true);
    expect(renewing.membershipExpiry <= new Date(NOW.getTime() + 21 * 86_400_000).toISOString().slice(0, 10)).toBe(true);
    expect(lapsed.membershipExpiry < today).toBe(true);
  });
});

describe('withTestAccounts', () => {
  it('answers test ids from the personas without calling the real client', async () => {
    const real = spyClient();
    const client = withTestAccounts(real, () => NOW);

    expect(await client.findDonorsByEmail('TEST-HOUSEHOLD@example.org')).toEqual([
      { id: 'test-household-a', name: 'Harper Household (test)', preferredLanguage: 'English', matchedPersonal: false },
      { id: 'test-household-b', name: 'Hayden Household (test)', preferredLanguage: 'English', matchedPersonal: false },
    ]);
    expect((await client.findDonorsByEmail('test-active@example.org'))[0]!.matchedPersonal).toBe(true);
    const data = await client.getMemberPortalData('test-active');
    expect(data.name).toBe('Alex Active (test)');
    expect(data.totalDonated).toBe('560.00');
    expect((await client.getMemberPortalData('test-active', { includeDonations: false })).donations).toEqual([]);
    expect((await client.getDonorContactInfo('test-lifetime')).email).toBe('test-lifetime@example.org');
    expect(await client.getVolunteerShiftsForDonor('test-lapsed')).toEqual([]);
    expect(await client.getPledgesForDonor('test-active')).toEqual([]);
    expect((await client.getMemberPortalData('test-spanish')).memberType).toBe('New');
    expect(await client.getDonorEmails('test-active')).toEqual({ personal: 'test-active@example.org', household: '', personalConsent: '', householdConsent: '' });
    expect((await client.getDonorEmails('test-household-b')).household).toBe('test-household@example.org');

    expect(real.findDonorsByEmail).not.toHaveBeenCalled();
    expect(real.getMemberPortalData).not.toHaveBeenCalled();
    expect(real.getDonorContactInfo).not.toHaveBeenCalled();
    expect(real.getDonorEmails).not.toHaveBeenCalled();
  });

  it('answers the test organization, its Affiliation and its giving', async () => {
    const real = spyClient();
    const client = withTestAccounts(real, () => NOW, 'Current');
    const employer = { affiliationsBoardId: 1, affiliationColumns: { personLink: 'p', organizationLink: 'o', status: 's', primary: 'x' }, currentStatusLabel: 'Current', personAffiliationsLink: 'pa' };
    const aff = { id: 'test-aff-orgrep', personItemId: 'test-orgrep', organizationId: 'test-org', statusLabel: 'Current', portalAccess: true, workEmail: 'test-orgrep-work@example.org' };

    expect(await client.getPersonAffiliations({ donorItemId: 'test-orgrep', employer })).toEqual([
      { id: 'test-aff-orgrep', organizationId: 'test-org', organizationName: 'Example Bikes Inc. (test)', statusLabel: 'Current', primary: true, portalAccess: true },
    ]);
    expect(await client.findAffiliationsByWorkEmail('Test-Orgrep-Work@example.org')).toEqual([aff]);
    expect(await client.getAffiliation('test-aff-orgrep')).toEqual(aff);
    expect(await client.getOrganizationAffiliations('test-org')).toEqual([aff]);
    expect((await client.getOrganization('test-org'))!.name).toBe('Example Bikes Inc. (test)');
    expect((await client.getOrganizationGifts('test-org')).map((g) => g.giftType)).toEqual(['Donation', 'Sponsorship', 'Donation']);
    expect((await client.getOrganizationGifts('test-org'))[0]!.date).toBe('2025-03-15');
    expect(await client.getOrganizationMatches('test-org')).toHaveLength(1);
    expect(await client.getDonorNames(['test-org'])).toEqual([{ id: 'test-org', name: 'Example Bikes Inc. (test)' }]);
    await expect(withTestAccounts(real, () => NOW, 'Aktuell').getAffiliation('test-aff-orgrep')).resolves.toMatchObject({ statusLabel: 'Aktuell' });

    for (const key of ['getPersonAffiliations', 'findAffiliationsByWorkEmail', 'getAffiliation', 'getOrganizationAffiliations', 'getOrganization', 'getOrganizationGifts', 'getOrganizationMatches'] as const) {
      expect(real[key]).not.toHaveBeenCalled();
    }
  });

  it('gives other test ids and addresses no affiliations or organizations', async () => {
    const real = spyClient();
    const client = withTestAccounts(real, () => NOW);
    const employer = { affiliationsBoardId: 1, affiliationColumns: { personLink: 'p', organizationLink: 'o', status: 's', primary: 'x' }, currentStatusLabel: 'Current', personAffiliationsLink: 'pa' };

    expect(await client.getPersonAffiliations({ donorItemId: 'test-active', employer })).toEqual([]);
    expect(await client.findAffiliationsByWorkEmail('test-active@example.org')).toEqual([]);
    expect(await client.getAffiliation('test-active')).toBeNull();
    expect(await client.getOrganizationAffiliations('test-active')).toEqual([]);
    expect(await client.getOrganization('test-active')).toBeNull();
    expect(await client.getOrganizationGifts('test-active')).toEqual([]);
    expect(await client.getOrganizationMatches('test-active')).toEqual([]);

    for (const key of ['getPersonAffiliations', 'findAffiliationsByWorkEmail', 'getAffiliation', 'getOrganizationAffiliations', 'getOrganization', 'getOrganizationGifts', 'getOrganizationMatches'] as const) {
      expect(real[key]).not.toHaveBeenCalled();
    }
  });

  it('passes every other id and address to the real client', async () => {
    const real = spyClient();
    const client = withTestAccounts(real, () => NOW);

    expect((await client.findDonorsByEmail('jordan@example.com'))[0]!.id).toBe('1001');
    expect((await client.getMemberPortalData('1001')).name).toBe('Jordan Alvarez');
    expect(await client.getDiscountOrganizations()).toHaveLength(3);
    expect(real.getMemberPortalData).toHaveBeenCalledWith('1001', {});
  });

  it('merges test and real names in the order asked', async () => {
    const client = withTestAccounts(spyClient(), () => NOW);
    expect(await client.getDonorNames(['1004', 'test-donor'])).toEqual([
      { id: '1004', name: 'Casey Nguyen' },
      { id: 'test-donor', name: 'Dana Donor (test)' },
    ]);
  });
});

describe('isTestSession', () => {
  it('is true only when every id is a test id', () => {
    expect(isTestSession(['test-household-a', 'test-household-b'])).toBe(true);
    expect(isTestSession(['test-active', '1001'])).toBe(false);
    expect(isTestSession([])).toBe(false);
  });
});
