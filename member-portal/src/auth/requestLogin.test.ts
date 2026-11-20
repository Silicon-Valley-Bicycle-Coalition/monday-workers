import { describe, it, expect, vi } from 'vitest';
import { requestLogin } from './requestLogin';
import type { MondayClient } from '../monday/client';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/types';
import { sha256Hex } from '../crypto/hash';
import type { Config } from '../types';

const REQUEST_ID = 'req-abc';

function fakeMonday(matches: { id: string; name: string; preferredLanguage: string }[]): MondayClient {
  return {
    findDonorsByEmail: vi.fn().mockResolvedValue(matches),
    getMemberPortalData: vi.fn(),
    getDiscountOrganizations: vi.fn(),
    getVolunteerShiftsForDonor: vi.fn(),
    getDonorContactInfo: vi.fn(),
    getDonorEmails: vi.fn(),
    findChangeRequestItem: vi.fn().mockResolvedValue(null),
    findOrganizationsByNames: vi.fn().mockResolvedValue([]),
    getPersonAffiliations: vi.fn().mockResolvedValue([]),
    createAffiliation: vi.fn(),
    updateAffiliation: vi.fn(),
    setDonorCheckbox: vi.fn().mockResolvedValue(undefined),
    createChangeRequestItem: vi.fn(),
    getLetterSettings: vi.fn(),
    listYearActivity: vi.fn(),
    findAffiliationsByWorkEmail: vi.fn().mockResolvedValue([]),
    getAffiliation: vi.fn().mockResolvedValue(null),
    getOrganizationAffiliations: vi.fn().mockResolvedValue([]),
    getOrganization: vi.fn().mockResolvedValue(null),
    getOrganizationGifts: vi.fn().mockResolvedValue([]),
    getOrganizationMatches: vi.fn().mockResolvedValue([]),
    getCompletedVolunteerHoursInYear: vi.fn().mockResolvedValue(new Map()),
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
    sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined), sendOrgStatementReadyEmail: vi.fn().mockResolvedValue(undefined),
  };
}

// Only the fields the organization gates read; portal 'REPLACE_WITH_COLUMN_ID' keeps the feature off.
function orgConfig(portalAccessColumn: string): Config {
  return {
    monday: { organizationsBoardId: 900 },
    changeRequests: {
      employer: {
        affiliationsBoardId: 555,
        affiliationColumns: { personLink: 'aff_person', organizationLink: 'aff_org', status: 'aff_status', primary: 'aff_primary' },
        currentStatusLabel: 'Current',
        personAffiliationsLink: 'people_aff',
      },
    },
    organizations: {
      portalAccessColumn,
      workEmailColumn: 'work_email_col',
      addressColumns: ['REPLACE_WITH_COLUMN_ID'],
      acknowledgmentSignedOff: false,
      volunteerFloor: 3,
    },
  } as unknown as Config;
}

const baseDeps = {
  config: orgConfig('REPLACE_WITH_COLUMN_ID'),
  portalBaseUrl: 'https://portal.example.org',
  magicLinkTtlMinutes: 15,
  now: () => new Date('2026-08-22T00:00:00.000Z'),
};

describe('requestLogin', () => {
  it('does nothing when no donor matches the email', async () => {
    const monday = fakeMonday([]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('nobody@example.org', 'en', REQUEST_ID, { monday, tokenStore, emailSender, ...baseDeps });

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

    await requestLogin('shared@example.org', 'en', REQUEST_ID, { monday, tokenStore, emailSender, ...baseDeps });

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
    // The domain-bound AutoFill line names the portal's own host.
    expect(emailCall.domain).toBe('portal.example.org');
  });

  it("uses the matched donor's stored preferred language for the magic-link URL when set", async () => {
    const monday = fakeMonday([{ id: 'donor-1', name: 'Jane', preferredLanguage: 'Spanish' }]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('shared@example.org', 'en', REQUEST_ID, { monday, tokenStore, emailSender, ...baseDeps });

    const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(emailCall.loginUrl).toContain('lang=es');
    expect(emailCall.locale).toBe('es');
  });

  it('falls back to the localeHint when the donor has no preferred language on file', async () => {
    const monday = fakeMonday([{ id: 'donor-1', name: 'Jane', preferredLanguage: '' }]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('shared@example.org', 'vi', REQUEST_ID, { monday, tokenStore, emailSender, ...baseDeps });

    const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(emailCall.loginUrl).toContain('lang=vi');
    expect(emailCall.locale).toBe('vi');
  });

  it("falls back to en when the donor's stored label does not match any supported locale", async () => {
    const monday = fakeMonday([{ id: 'donor-1', name: 'Jane', preferredLanguage: 'Klingon' }]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('shared@example.org', 'en', REQUEST_ID, { monday, tokenStore, emailSender, ...baseDeps });

    const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(emailCall.loginUrl).toContain('lang=en');
    expect(emailCall.locale).toBe('en');
  });

  it('stores request, code and email hashes on the one row and emails the same code', async () => {
    const monday = fakeMonday([{ id: 'donor-1', name: 'Jane', preferredLanguage: '' }]);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();

    await requestLogin('shared@example.org', 'en', REQUEST_ID, { monday, tokenStore, emailSender, ...baseDeps });

    expect(tokenStore.createToken).toHaveBeenCalledTimes(1);
    const row = (tokenStore.createToken as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(emailCall.code).toMatch(/^\d{6}$/);
    expect(emailCall.ttlMinutes).toBe(15);
    expect(row.requestHash).toBe(await sha256Hex(REQUEST_ID));
    expect(row.codeHash).toBe(await sha256Hex(`${REQUEST_ID}:${emailCall.code}`));
    expect(row.emailHash).toBe(await sha256Hex('shared@example.org'));
  });

  describe('organization grants', () => {
    const workAff = { id: 'w1', personItemId: 'p9', organizationId: 'o1', statusLabel: 'Current', portalAccess: true, workEmail: 'rep@acme.org' };

    it('signs in a work-only address with no people and one grant', async () => {
      const monday = fakeMonday([]);
      monday.findAffiliationsByWorkEmail = vi.fn().mockResolvedValue([workAff]);
      const tokenStore = fakeTokenStore();
      const emailSender = fakeEmailSender();

      await requestLogin('rep@acme.org', 'es', REQUEST_ID, { monday, tokenStore, emailSender, ...baseDeps, config: orgConfig('portal_col') });

      const row = (tokenStore.createToken as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(row.donorItemIds).toEqual([]);
      expect(row.orgGrants).toEqual([{ orgItemId: 'o1', affiliationItemId: 'w1', via: 'workEmail', personItemId: 'p9' }]);
      const emailCall = (emailSender.sendLoginEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(emailCall.to).toBe('rep@acme.org');
      expect(emailCall.locale).toBe('es');
    });

    it('sends nothing to an address matching no person and no Work Email', async () => {
      const monday = fakeMonday([]);
      const tokenStore = fakeTokenStore();
      const emailSender = fakeEmailSender();

      await requestLogin('nobody@example.org', 'en', REQUEST_ID, { monday, tokenStore, emailSender, ...baseDeps, config: orgConfig('portal_col') });

      expect(monday.findAffiliationsByWorkEmail).toHaveBeenCalled();
      expect(tokenStore.createToken).not.toHaveBeenCalled();
      expect(emailSender.sendLoginEmail).not.toHaveBeenCalled();
    });

    it("still signs a person in for their own records when grant resolution throws", async () => {
      const monday = fakeMonday([{ id: 'donor-1', name: 'Jane', preferredLanguage: '' }]);
      const tokenStore = fakeTokenStore();
      const emailSender = fakeEmailSender();
      const config = orgConfig('portal_col');
      Object.defineProperty(config, 'organizations', { get: () => { throw new Error('config broke for jane@example.org'); } });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      await requestLogin('jane@example.org', 'en', REQUEST_ID, { monday, tokenStore, emailSender, ...baseDeps, config });

      const row = (tokenStore.createToken as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(row.donorItemIds).toEqual(['donor-1']);
      expect(row.orgGrants).toEqual([]);
      expect(emailSender.sendLoginEmail).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls.flat().join(' ')).not.toContain('jane@example.org');
      errors.mockRestore();
    });
  });
});
