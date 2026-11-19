import { describe, it, expect, vi } from 'vitest';
import { requestLogin } from './requestLogin';
import type { MondayClient } from '../monday/client';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/types';

function fakeMonday(matches: { id: string; name: string; preferredLanguage: string }[]): MondayClient {
  return {
    findDonorsByEmail: vi.fn().mockResolvedValue(matches),
    getMemberPortalData: vi.fn(),
    getDiscountOrganizations: vi.fn(),
    getVolunteerShiftsForDonor: vi.fn(),
    getDonorContactInfo: vi.fn(),
    findChangeRequestItem: vi.fn().mockResolvedValue(null),
    findOrganizationsByNames: vi.fn().mockResolvedValue([]),
    getPersonAffiliations: vi.fn().mockResolvedValue([]),
    createAffiliation: vi.fn(),
    updateAffiliation: vi.fn(),
    createChangeRequestItem: vi.fn(),
    getLetterSettings: vi.fn(),
    listDonorIdsWithDonationsInYear: vi.fn(),
    getDonorNames: vi.fn().mockResolvedValue([]),
    getEventRegistrationsForDonor: vi.fn().mockResolvedValue([]),
    getPledgesForDonor: vi.fn().mockResolvedValue([]),
  };
}

function fakeTokenStore(): MagicLinkTokenStore {
  return { createToken: vi.fn().mockResolvedValue(undefined), consumeToken: vi.fn(), takeCodeAttempt: vi.fn(), claimByRequest: vi.fn() };
}

function fakeEmailSender(): EmailSender {
  return {
    sendLoginEmail: vi.fn().mockResolvedValue(undefined),
    sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
  };
}

const baseDeps = {
  portalBaseUrl: 'https://portal.example.org',
  magicLinkTtlMinutes: 15,
  now: () => new Date('2026-08-22T00:00:00.000Z'),
};

describe('requestLogin', () => {
  it('does nothing when no donor matches the email', async () => {
    const monday = fakeMonday([]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('nobody@example.org', 'en', { monday, tokenStore, emailSender, ...baseDeps });

    expect(tokenStore.createToken).not.toHaveBeenCalled();
    expect(emailSender.sendLoginEmail).not.toHaveBeenCalled();
  });

  it('creates a token covering every matched donor and emails a link containing it', async () => {
    const monday = fakeMonday([
      { id: 'donor-1', name: 'Jane', preferredLanguage: '' },
      { id: 'donor-2', name: 'Jane Also', preferredLanguage: '' },
    ]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('shared@example.org', 'en', { monday, tokenStore, emailSender, ...baseDeps });

    expect(tokenStore.createToken).toHaveBeenCalledTimes(1);
    const call = (tokenStore.createToken as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.donorItemIds).toEqual(['donor-1', 'donor-2']);
    expect(call.expiresAt).toBe('2026-08-22T00:15:00.000Z');
    expect(call.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    expect(emailSender.sendLoginEmail).toHaveBeenCalledTimes(1);
    const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(emailCall.to).toBe('shared@example.org');
    // Issue GL#61: the token rides in the fragment, never the query string, so it can't reach request logs.
    expect(emailCall.loginUrl).toMatch(/^https:\/\/portal\.example\.org\/auth\/callback\?lang=en#token=[0-9a-f]{64}$/);
  });

  it("uses the matched donor's stored preferred language for the magic-link URL when set", async () => {
    const monday = fakeMonday([{ id: 'donor-1', name: 'Jane', preferredLanguage: 'Spanish' }]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('shared@example.org', 'en', { monday, tokenStore, emailSender, ...baseDeps });

    const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(emailCall.loginUrl).toContain('lang=es');
    expect(emailCall.locale).toBe('es');
  });

  it('falls back to the localeHint when the donor has no preferred language on file', async () => {
    const monday = fakeMonday([{ id: 'donor-1', name: 'Jane', preferredLanguage: '' }]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('shared@example.org', 'vi', { monday, tokenStore, emailSender, ...baseDeps });

    const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(emailCall.loginUrl).toContain('lang=vi');
    expect(emailCall.locale).toBe('vi');
  });

  it("falls back to en when the donor's stored label does not match any supported locale", async () => {
    const monday = fakeMonday([{ id: 'donor-1', name: 'Jane', preferredLanguage: 'Klingon' }]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('shared@example.org', 'en', { monday, tokenStore, emailSender, ...baseDeps });

    const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(emailCall.loginUrl).toContain('lang=en');
    expect(emailCall.locale).toBe('en');
  });
});
