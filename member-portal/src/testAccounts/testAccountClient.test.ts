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
      { id: 'test-household-a', name: 'Harper Household (test)', preferredLanguage: 'English' },
      { id: 'test-household-b', name: 'Hayden Household (test)', preferredLanguage: 'English' },
    ]);
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
