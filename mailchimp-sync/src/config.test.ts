import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

function validRaw() {
  return {
    monday: {
      apiUrl: 'https://api.monday.com/v2',
      donorsBoardId: null,
      campaignsBoardId: null,
      columns: {
        membershipStatus: 'c1', membershipTier: 'c2', memberSince: 'c3', memberUntil: 'c4',
        addr1: 'c5', city: 'c6', state: 'c7', zip: 'c8', email: 'c9', totalGiven: 'c10',
        mailchimpCampaigns: 'c11', doNotSolicit: 'c12', dnsReasonStatus: 'c13', nearby: null,
      },
    },
    mailchimp: {
      apiBaseUrl: 'https://us1.api.mailchimp.com/3.0',
      audienceId: 'abc123',
      interestCategoryIds: ['cat1'] as unknown, nearbyTagPrefix: 'Near: ',
      mergeFields: {
        memberSince: 'MEMBERSINCE', memberUntil: 'MEMBERUNTIL', membershipTier: 'MTIER',
        membershipStatus: 'MSTATUS', address: 'ADDRESS', totalGiven: 'TOTALGIVE',
      },
      tags: {
        activeMember: 'active-member', lapsedMember: 'lapsed-member',
        lifetimeMember: 'lifetime-member', hasDonated: 'has-donated', doNotSolicit: 'do-not-solicit',
      },
    },
    lifetimeTierValue: 'Lifetime',
    activeStatusValue: 'Active',
    dnsConfirmedValue: 'Confirmed',
  };
}

describe('validateConfig', () => {
  it('accepts a fully-populated config', () => {
    const config = validateConfig(validRaw());
    expect(config.mailchimp.audienceId).toBe('abc123');
    expect(config.monday.columns.email).toBe('c9');
  });

  it('rejects a non-object', () => {
    expect(() => validateConfig(null)).toThrow('config: expected an object');
  });

  it('rejects a missing monday.columns key', () => {
    const raw = validRaw();
    delete (raw.monday.columns as Record<string, unknown>).email;
    expect(() => validateConfig(raw)).toThrow('config: missing required key "monday.columns.email"');
  });

  it('rejects a missing mailchimp.mergeFields key', () => {
    const raw = validRaw();
    delete (raw.mailchimp.mergeFields as Record<string, unknown>).address;
    expect(() => validateConfig(raw)).toThrow('config: missing required key "mailchimp.mergeFields.address"');
  });

  it('requires a non-empty mailchimp.interestCategoryIds', () => {
    const message = 'config: "mailchimp.interestCategoryIds" must be a non-empty array of category ids';
    for (const bad of [undefined, [], [''], 'cat1']) {
      const raw = validRaw();
      raw.mailchimp.interestCategoryIds = bad;
      expect(() => validateConfig(raw)).toThrow(message);
    }
  });

  it('rejects an empty or missing mailchimp.nearbyTagPrefix', () => {
    for (const bad of [undefined, '', 5]) {
      const raw = validRaw();
      (raw.mailchimp as Record<string, unknown>).nearbyTagPrefix = bad;
      expect(() => validateConfig(raw)).toThrow('config: missing required key "mailchimp.nearbyTagPrefix"');
    }
  });

  it('accepts a null or string monday.columns.nearby and rejects anything else', () => {
    const withNearby = (value: unknown) => {
      const raw = validRaw();
      (raw.monday.columns as Record<string, unknown>).nearby = value;
      return raw;
    };
    expect(validateConfig(withNearby(null)).monday.columns.nearby).toBeNull();
    expect(validateConfig(withNearby('dropdown_x')).monday.columns.nearby).toBe('dropdown_x');
    for (const bad of [undefined, '', 5]) {
      expect(() => validateConfig(withNearby(bad))).toThrow('config: "monday.columns.nearby" must be a column id or null');
    }
  });

  it('rejects a missing mailchimp.tags key', () => {
    const raw = validRaw();
    delete (raw.mailchimp.tags as Record<string, unknown>).hasDonated;
    expect(() => validateConfig(raw)).toThrow('config: missing required key "mailchimp.tags.hasDonated"');
  });

  it('rejects a missing top-level key', () => {
    const raw = validRaw();
    delete (raw as Record<string, unknown>).lifetimeTierValue;
    expect(() => validateConfig(raw)).toThrow('config: missing required key "lifetimeTierValue"');
  });

  it('requires the Do Not Solicit columns, tag, and confirmed value', () => {
    for (const [mutate, message] of [
      [(r: ReturnType<typeof validRaw>) => delete (r.monday.columns as Record<string, unknown>).doNotSolicit, 'monday.columns.doNotSolicit'],
      [(r: ReturnType<typeof validRaw>) => delete (r.monday.columns as Record<string, unknown>).dnsReasonStatus, 'monday.columns.dnsReasonStatus'],
      [(r: ReturnType<typeof validRaw>) => delete (r.mailchimp.tags as Record<string, unknown>).doNotSolicit, 'mailchimp.tags.doNotSolicit'],
      [(r: ReturnType<typeof validRaw>) => delete (r as Record<string, unknown>).dnsConfirmedValue, 'dnsConfirmedValue'],
    ] as const) {
      const raw = validRaw();
      mutate(raw);
      expect(() => validateConfig(raw)).toThrow(`config: missing required key "${message}"`);
    }
    expect(validateConfig(validRaw()).dnsConfirmedValue).toBe('Confirmed');
  });

  it('accepts a real numeric donorsBoardId/campaignsBoardId', () => {
    const raw = validRaw();
    (raw.monday as Record<string, unknown>).donorsBoardId = 111;
    (raw.monday as Record<string, unknown>).campaignsBoardId = 999;
    const config = validateConfig(raw);
    expect(config.monday.donorsBoardId).toBe(111);
    expect(config.monday.campaignsBoardId).toBe(999);
  });

  it('rejects a string donorsBoardId', () => {
    const raw = validRaw();
    (raw.monday as Record<string, unknown>).donorsBoardId = '111';
    expect(() => validateConfig(raw)).toThrow('config: "monday.donorsBoardId" must be a number or null');
  });

  it('rejects a string campaignsBoardId', () => {
    const raw = validRaw();
    (raw.monday as Record<string, unknown>).campaignsBoardId = '999';
    expect(() => validateConfig(raw)).toThrow('config: "monday.campaignsBoardId" must be a number or null');
  });
});
