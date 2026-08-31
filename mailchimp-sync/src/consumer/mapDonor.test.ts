import { describe, it, expect } from 'vitest';
import { buildMergeFields, buildTags, managedTags } from './mapDonor';
import type { Config, DonorRecord } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: null, campaignsBoardId: null, columns: {} as never },
  mailchimp: {
    apiBaseUrl: '', audienceId: '',
    mergeFields: {
      memberSince: 'MEMBERSINCE', memberUntil: 'MEMBERUNTIL', membershipTier: 'MTIER',
      membershipStatus: 'MSTATUS', address: 'ADDRESS', totalGiven: 'TOTALGIVE',
    },
    tags: {
      activeMember: 'active-member', lapsedMember: 'lapsed-member',
      lifetimeMember: 'lifetime-member', hasDonated: 'has-donated',
    },
  },
  lifetimeTierValue: 'Lifetime',
  activeStatusValue: 'Active',
};

function donor(overrides: Partial<DonorRecord> = {}): DonorRecord {
  return {
    id: '1', email: 'a@b.com', membershipStatus: 'Active', membershipTier: 'Standard',
    memberSince: '2026-01-01', memberUntil: '2027-01-01', addr1: '1 Main St', city: 'San Jose',
    state: 'CA', zip: '95110', totalGiven: '0', ...overrides,
  };
}

describe('buildMergeFields', () => {
  it('maps every configured merge field, bundling address into one object', () => {
    expect(buildMergeFields(donor(), CONFIG)).toEqual({
      MEMBERSINCE: '2026-01-01',
      MEMBERUNTIL: '2027-01-01',
      MTIER: 'Standard',
      MSTATUS: 'Active',
      ADDRESS: { addr1: '1 Main St', city: 'San Jose', state: 'CA', zip: '95110', country: 'US' },
      TOTALGIVE: '0',
    });
  });

  it('omits the ADDRESS key entirely when any address component is blank', () => {
    const result = buildMergeFields(donor({ city: '' }), CONFIG);
    expect(result).not.toHaveProperty('ADDRESS');
    expect(result).toEqual({
      MEMBERSINCE: '2026-01-01',
      MEMBERUNTIL: '2027-01-01',
      MTIER: 'Standard',
      MSTATUS: 'Active',
      TOTALGIVE: '0',
    });
  });
});

describe('buildTags', () => {
  it('tags a Lifetime-tier donor as lifetime-member regardless of status', () => {
    expect(buildTags(donor({ membershipTier: 'Lifetime', membershipStatus: 'Lapsed' }), CONFIG))
      .toContain('lifetime-member');
  });

  it('tags an Active, non-Lifetime donor as active-member', () => {
    expect(buildTags(donor({ membershipStatus: 'Active', membershipTier: 'Standard' }), CONFIG))
      .toContain('active-member');
  });

  it('tags a non-Active, non-Lifetime donor as lapsed-member', () => {
    expect(buildTags(donor({ membershipStatus: 'Lapsed', membershipTier: 'Standard' }), CONFIG))
      .toContain('lapsed-member');
  });

  it('adds has-donated only when totalGiven is a positive number', () => {
    expect(buildTags(donor({ totalGiven: '150' }), CONFIG)).toContain('has-donated');
    expect(buildTags(donor({ totalGiven: '0' }), CONFIG)).not.toContain('has-donated');
    expect(buildTags(donor({ totalGiven: '' }), CONFIG)).not.toContain('has-donated');
  });
});

describe('managedTags', () => {
  it('enumerates every configured tag this worker owns, and only those', () => {
    expect(managedTags(CONFIG).sort()).toEqual(
      ['active-member', 'has-donated', 'lapsed-member', 'lifetime-member'],
    );
  });

  it('always contains whatever buildTags produces', () => {
    const managed = managedTags(CONFIG);
    for (const d of [donor(), donor({ membershipTier: 'Lifetime' }), donor({ membershipStatus: 'Lapsed', totalGiven: '150' })]) {
      for (const tag of buildTags(d, CONFIG)) {
        expect(managed).toContain(tag);
      }
    }
  });
});
