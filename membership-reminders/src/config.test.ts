import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    donorsBoardId: null,
    columns: {
      membershipStatus: 'status',
      membershipTier: 'tier',
      memberUntil: 'until',
      remindersSent: 'sent',
      email: 'email',
    },
  },
  stages: [{ tag: '6w', offsetDays: 42 }],
  renewalUrl: 'https://example.org/renew',
  timeZone: 'America/Los_Angeles',
  lifetimeTierValue: 'Lifetime',
  activeStatusValue: 'Active',
};

describe('validateConfig', () => {
  it('returns the config unchanged when valid', () => {
    expect(validateConfig(validConfig)).toEqual(validConfig);
  });

  it('throws when a top-level key is missing', () => {
    const { renewalUrl, ...missing } = validConfig;
    expect(() => validateConfig(missing)).toThrow(/renewalUrl/);
  });

  it('throws when monday.columns is missing a column', () => {
    const { email, ...missingEmail } = validConfig.monday.columns;
    const broken = { ...validConfig, monday: { ...validConfig.monday, columns: missingEmail } };
    expect(() => validateConfig(broken)).toThrow(/email/);
  });

  it('throws when stages is empty', () => {
    expect(() => validateConfig({ ...validConfig, stages: [] })).toThrow(/stages/);
  });

  it('throws when monday is null', () => {
    expect(() => validateConfig({ ...validConfig, monday: null })).toThrow(/monday/);
  });

  it('throws when monday is not an object', () => {
    expect(() => validateConfig({ ...validConfig, monday: 'invalid' })).toThrow(/monday/);
  });
});
