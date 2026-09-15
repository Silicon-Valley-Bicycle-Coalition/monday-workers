import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';
import rawConfig from '../config/svbc.json';

const ownerColumns = {
  giftLedgerJson: 'glj', lifetimeGiving: 'lg', giftCount: 'gc', firstGift: 'fg',
  thisYearAmount: 'tya', thisYearCount: 'tyc', lastYearAmount: 'lya', lastYearCount: 'lyc',
  largestGift: 'lag', smallestGift: 'smg', averageGift: 'avg', lastGiftDate: 'lgd', lastGiftAmount: 'lga',
};
const membershipColumns = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil' };
const membership = {
  fromISO: '2026-10-01', eligibleGiftTypes: ['Donation'], termMonths: 12, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', renewal: 'Renewal', reacquire: 'Reacquire', lifetime: 'Lifetime' },
};
const donationBoard = {
  boardId: 1,
  columns: { donorLink: 'dl', amount: 'am', date: 'dt', status: 'st', fiscalYear: null,
    giftType: 'gt', termStart: 'ts', termEnd: 'te', membershipType: 'mty' },
};
const base = {
  monday: { apiUrl: 'https://api.monday.com/v2', accountUrl: 'https://acme.monday.com' },
  custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null,
    annualSummaryBoardId: null, annualSummaryColumns: null },
  donationRollups: {
    receivedStatusLabel: 'Received',
    donationBoards: [donationBoard],
    ownerColumnsByBoard: { '2': { ...ownerColumns, membership: membershipColumns }, '3': ownerColumns },
    membership,
  },
};

// The block the README tells the operator to paste in AFTER migration 0005 is applied.
const documentedMembershipBlock = {
  fromISO: '2026-10-01', eligibleGiftTypes: ['Donation'], termMonths: 12, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', renewal: 'Renewal', reacquire: 'Reacquire', lifetime: 'Lifetime' },
};

describe('validateConfig — membership block', () => {
  it('accepts a full membership config and passes it through', () => {
    const cfg = validateConfig(base);
    expect(cfg.donationRollups.membership).toEqual(membership);
    expect(cfg.donationRollups.ownerColumnsByBoard['2']!.membership).toEqual(membershipColumns);
    expect(cfg.donationRollups.ownerColumnsByBoard['3']!.membership).toBeUndefined();
    expect(cfg.donationRollups.donationBoards[0]!.columns.termStart).toBe('ts');
  });

  it('treats a missing or null membership block as off', () => {
    const { membership: _m, ...rest } = base.donationRollups;
    expect(validateConfig({ ...base, donationRollups: rest }).donationRollups.membership).toBeNull();
    expect(validateConfig({ ...base, donationRollups: { ...rest, membership: null } }).donationRollups.membership).toBeNull();
  });

  it('with membership off, term columns and owner membership columns are still optional', () => {
    const board = { boardId: 1, columns: { donorLink: 'dl', amount: 'am', date: 'dt', status: 'st', fiscalYear: null } };
    const cfg = validateConfig({ ...base, donationRollups: { ...base.donationRollups, membership: null, donationBoards: [board] } });
    expect(cfg.donationRollups.donationBoards[0]!.columns.termStart).toBeNull();
  });

  it.each([
    ['fromISO', 'not-a-date', /fromISO/],
    ['eligibleGiftTypes', [], /eligibleGiftTypes/],
    ['termMonths', 0, /termMonths/],
    ['lifetimeThresholdCents', -1, /lifetimeThresholdCents/],
    ['statusLabels', { active: 'Active' }, /statusLabels\.lapsed/],
    ['tierLabels', { member: '', lifetime: 'Lifetime' }, /tierLabels\.member/],
    ['typeLabels', { new: 'New', renewal: 'Renewal', reacquire: 'Reacquire' }, /typeLabels\.lifetime/],
  ])('rejects a bad membership.%s', (key, value, pattern) => {
    const bad = { ...base, donationRollups: { ...base.donationRollups, membership: { ...membership, [key]: value } } };
    expect(() => validateConfig(bad)).toThrow(pattern);
  });

  it.each(['giftType', 'termStart', 'termEnd', 'membershipType'])(
    'requires donation board column %s when membership is on', (key) => {
      const { [key]: _drop, ...columns } = donationBoard.columns as Record<string, unknown>;
      const bad = { ...base, donationRollups: { ...base.donationRollups, donationBoards: [{ boardId: 1, columns }] } };
      expect(() => validateConfig(bad)).toThrow(new RegExp(`columns\\.${key}`));
    });

  it('requires at least one owner board with membership columns when membership is on', () => {
    const bad = { ...base, donationRollups: { ...base.donationRollups, ownerColumnsByBoard: { '3': ownerColumns } } };
    expect(() => validateConfig(bad)).toThrow(/at least one ownerColumnsByBoard entry must have "membership"/);
  });

  it('rejects a partial owner membership block', () => {
    const bad = { ...base, donationRollups: { ...base.donationRollups,
      ownerColumnsByBoard: { '2': { ...ownerColumns, membership: { status: 'ms', tier: 'mt', since: 'msince' } } } } };
    expect(() => validateConfig(bad)).toThrow(/membership\.until/);
  });

  it('the shipped config/svbc.json validates (the membership block may be on or off — see README "Enabling")', () => {
    expect(() => validateConfig(rawConfig)).not.toThrow();
  });

  it('the shipped config validates with the documented membership block switched on', () => {
    const enabled = { ...rawConfig, donationRollups: { ...rawConfig.donationRollups, membership: documentedMembershipBlock } };
    expect(validateConfig(enabled).donationRollups.membership?.eligibleGiftTypes).toEqual(['Donation']);
  });
});

const rawBase = () => JSON.parse(JSON.stringify(rawConfig)) as Record<string, any>;

describe('validateConfig — affiliations block', () => {
  it('accepts affiliations: null (feature gated off) and leaves actingForLink null', () => {
    const cfg = validateConfig(rawBase());
    expect(cfg.affiliations).toBeNull();
    expect(cfg.donationRollups.donationBoards[0]!.columns.actingForLink).toBeNull();
  });
  it('accepts a full affiliations block and an optional organizationalGiving owner column', () => {
    const raw = rawBase();
    raw.affiliations = { boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag',
      attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' } };
    raw.donationRollups.donationBoards[0].columns.actingForLink = 'br_af';
    raw.donationRollups.ownerColumnsByBoard['18428131737'].organizationalGiving = 'n_og';
    const cfg = validateConfig(raw);
    expect(cfg.affiliations).toEqual({ boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag',
      attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' } });
    expect(cfg.donationRollups.donationBoards[0]!.columns.actingForLink).toBe('br_af');
    expect(cfg.donationRollups.ownerColumnsByBoard['18428131737']!.organizationalGiving).toBe('n_og');
    expect(cfg.donationRollups.ownerColumnsByBoard['18428131727']!.organizationalGiving).toBeUndefined();
  });
  it('rejects an affiliations block missing a column, and a block without actingForLink on the donation board', () => {
    const raw = rawBase();
    raw.affiliations = { boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag', attributedGiftCount: 'n_agc' } };
    expect(() => validateConfig(raw)).toThrow(/affiliations\.columns\.lastAttributedGift/);
    raw.affiliations.columns.lastAttributedGift = 'd_lag';
    expect(() => validateConfig(raw)).toThrow(/actingForLink.*required when affiliations is set/);
});
