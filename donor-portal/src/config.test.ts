import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    donorsBoardId: null,
    donationsBoardId: null,
    organizationsBoardId: null,
    columns: {
      donorEmail: 'email_col',
      membershipStatus: 'status_col',
      membershipTier: 'tier_col',
      dollarDonated: 'donated_col',
      donationDonorLink: 'link_col',
      donationAmount: 'amount_col',
      donationDate: 'date_col',
      donationDescription: 'desc_col',
      discountOffered: 'offer_col',
      discountActive: 'active_col',
    },
  },
  resend: { fromAddress: 'login@example.org', fromName: 'Test Portal' },
  auth: { magicLinkTtlMinutes: 15, sessionTtlHours: 24, portalBaseUrl: 'https://example.org' },
  rateLimit: { emailWindowSeconds: 900, emailMaxAttempts: 5 },
};

describe('validateConfig', () => {
  it('returns the config unchanged when valid', () => {
    expect(validateConfig(validConfig)).toEqual(validConfig);
  });

  it('throws when a top-level key is missing', () => {
    const { resend, ...missing } = validConfig;
    expect(() => validateConfig(missing)).toThrow(/resend/);
  });

  it('throws when monday.columns is missing a column', () => {
    const { donorEmail, ...missingEmail } = validConfig.monday.columns;
    const broken = { ...validConfig, monday: { ...validConfig.monday, columns: missingEmail } };
    expect(() => validateConfig(broken)).toThrow(/donorEmail/);
  });

  it('throws when resend is missing a key', () => {
    const { fromName, ...rest } = validConfig.resend;
    const broken = { ...validConfig, resend: rest };
    expect(() => validateConfig(broken)).toThrow(/fromName/);
  });

  it('throws when auth is missing a key', () => {
    const { portalBaseUrl, ...rest } = validConfig.auth;
    const broken = { ...validConfig, auth: rest };
    expect(() => validateConfig(broken)).toThrow(/portalBaseUrl/);
  });

  it('throws when rateLimit is missing a key', () => {
    const { emailMaxAttempts, ...rest } = validConfig.rateLimit;
    const broken = { ...validConfig, rateLimit: rest };
    expect(() => validateConfig(broken)).toThrow(/emailMaxAttempts/);
  });

  it('throws when monday is null', () => {
    expect(() => validateConfig({ ...validConfig, monday: null })).toThrow(/monday/);
  });
});
