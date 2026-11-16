import { describe, it, expect } from 'vitest';
import { buildMergeFields, buildTags, managedTags } from './mapDonor';
import type { Config, DonorRecord } from '../types';

const CONFIG: Config = {
  monday: { apiUrl: '', donorsBoardId: null, campaignsBoardId: null, historical: null, columns: {} as never },
  mailchimp: {
    apiBaseUrl: '', audienceId: '', interestCategoryIds: ['cat1'], nearbyTagPrefix: 'Near: ',
    mergeFields: {
      memberSince: 'MEMBERSINCE', memberUntil: 'MEMBERUNTIL', membershipTier: 'MTIER',
      membershipStatus: 'MSTATUS', address: 'ADDRESS', totalGiven: 'TOTALGIVE',
    },
    tags: {
      activeMember: 'active-member', lapsedMember: 'lapsed-member',
      lifetimeMember: 'lifetime-member', hasDonated: 'has-donated', doNotSolicit: 'do-not-solicit', recurringDonor: 'recurring-donor',
    },
  },
  lifetimeTierValue: 'Lifetime',
  activeStatusValue: 'Active',
  dnsConfirmedValue: 'Confirmed',
};

function donor(overrides: Partial<DonorRecord> = {}): DonorRecord {
  return {
    id: '1', email: 'a@b.com', membershipStatus: 'Active', membershipTier: 'Standard',
    memberSince: '2026-01-01', memberUntil: '2027-01-01', addr1: '1 Main St', city: 'San Jose',
    state: 'CA', zip: '95110', totalGiven: '0', doNotSolicit: false, dnsReasonStatus: '', nearby: [], hasActiveRecurringGift: false, onHistorical: false, ...overrides,
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

  it('derives the state from the ZIP when the donor has none (no State column configured)', () => {
    expect(buildMergeFields(donor({ state: '', zip: '98101' }), CONFIG).ADDRESS)
      .toEqual({ addr1: '1 Main St', city: 'San Jose', state: 'WA', zip: '98101', country: 'US' });
  });

  it('keeps a State column value over the ZIP, and omits ADDRESS when neither gives a state', () => {
    expect((buildMergeFields(donor({ state: 'NV', zip: '95110' }), CONFIG).ADDRESS as { state: string }).state).toBe('NV');
    expect(buildMergeFields(donor({ state: '', zip: 'EH9 1NR' }), CONFIG)).not.toHaveProperty('ADDRESS');
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

  it('gives a never-member (blank Membership Status) no membership tag, so syncTags clears all three', () => {
    // Blank status means never a member (docs/22): tagging these lapsed-member put ~1,800 people who
    // never joined into renewal sends (found 2026-11-02, cutover Gate C).
    const tags = buildTags(donor({ membershipStatus: '', membershipTier: '' }), CONFIG);
    expect(tags).not.toContain('lapsed-member');
    expect(tags).not.toContain('active-member');
    expect(tags).not.toContain('lifetime-member');
  });

  it('adds has-donated only when totalGiven is a positive number', () => {
    expect(buildTags(donor({ totalGiven: '150' }), CONFIG)).toContain('has-donated');
    expect(buildTags(donor({ totalGiven: '0' }), CONFIG)).not.toContain('has-donated');
    expect(buildTags(donor({ totalGiven: '' }), CONFIG)).not.toContain('has-donated');
  });
});

describe('buildTags — Do Not Solicit', () => {
  it('adds do-not-solicit as soon as the box is checked, whatever the reason status', () => {
    expect(buildTags(donor({ doNotSolicit: true, dnsReasonStatus: 'Missing' }), CONFIG)).toContain('do-not-solicit');
    expect(buildTags(donor({ doNotSolicit: true, dnsReasonStatus: '' }), CONFIG)).toContain('do-not-solicit');
  });

  it('omits do-not-solicit when the box is unchecked, so syncTags deactivates it', () => {
    expect(buildTags(donor({ doNotSolicit: false, dnsReasonStatus: 'Confirmed' }), CONFIG)).not.toContain('do-not-solicit');
  });
});

describe('buildTags: recurring-donor', () => {
  it('tags an active recurring giver, and omits the tag otherwise so syncTags deactivates it', () => {
    expect(buildTags(donor({ hasActiveRecurringGift: true }), CONFIG)).toContain('recurring-donor');
    expect(buildTags(donor({ hasActiveRecurringGift: false }), CONFIG)).not.toContain('recurring-donor');
  });

  it('is a managed tag', () => {
    expect(managedTags(CONFIG)).toContain('recurring-donor');
  });
});

describe('buildTags: Nearby labels', () => {
  it('appends the prefix plus each Nearby label', () => {
    const tags = buildTags(donor({ nearby: ['Stevens Creek bikeway', 'Bay Trail'] }), CONFIG);
    expect(tags).toContain('Near: Stevens Creek bikeway');
    expect(tags).toContain('Near: Bay Trail');
  });

  it('adds no Near: tag when the donor has no labels', () => {
    expect(buildTags(donor(), CONFIG).some((t) => t.startsWith('Near: '))).toBe(false);
  });
});

describe('managedTags', () => {
  it('adds the member\'s current prefixed tags (so a removed label can be deactivated), and no others', () => {
    const managed = managedTags(CONFIG, ['Near: Old', 'VIP']);
    expect(managed).toContain('Near: Old');
    expect(managed).not.toContain('VIP');
  });

  it('enumerates every configured tag this worker owns, and only those', () => {
    expect(managedTags(CONFIG).sort()).toEqual(
      ['active-member', 'do-not-solicit', 'has-donated', 'lapsed-member', 'lifetime-member', 'recurring-donor'],
    );
  });

  it('always contains whatever buildTags produces', () => {
    const managed = managedTags(CONFIG);
    for (const d of [donor(), donor({ membershipTier: 'Lifetime' }), donor({ membershipStatus: 'Lapsed', totalGiven: '150' }), donor({ doNotSolicit: true })]) {
      for (const tag of buildTags(d, CONFIG)) {
        expect(managed).toContain(tag);
      }
    }
  });
});
