import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';
import rawConfig from '../config/svbc.json';
import rawSandboxConfig from '../config/sandbox.json';

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
  fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
  custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null,
    annualSummaryBoardId: null, annualSummaryColumns: null },
  donationRollups: {
    receivedStatusLabel: 'Received',
    donationBoards: [donationBoard],
    ownerColumnsByBoard: { '2': { ...ownerColumns, membership: membershipColumns }, '3': ownerColumns },
    membership,
  },
};

describe('validateConfig — fiscalYear block (issue #27)', () => {
  it('passes a valid block through', () => {
    expect(validateConfig(base).fiscalYear).toEqual({ startMonth: 7, timeZone: 'America/Los_Angeles' });
  });

  it('both shipped configs start the fiscal year on July 1, Pacific time', () => {
    expect(validateConfig(rawConfig).fiscalYear).toEqual({ startMonth: 7, timeZone: 'America/Los_Angeles' });
    expect(validateConfig(rawSandboxConfig).fiscalYear).toEqual({ startMonth: 7, timeZone: 'America/Los_Angeles' });
  });

  it('is required — there is no built-in default', () => {
    const { fiscalYear: _f, ...rest } = base;
    expect(() => validateConfig(rest)).toThrow(/fiscalYear/);
  });

  it.each([
    [{ startMonth: 0, timeZone: 'America/Los_Angeles' }],
    [{ startMonth: 13, timeZone: 'America/Los_Angeles' }],
    [{ startMonth: 7.5, timeZone: 'America/Los_Angeles' }],
    [{ startMonth: '7', timeZone: 'America/Los_Angeles' }],
    [{ startMonth: 7, timeZone: '' }],
    [{ startMonth: 7, timeZone: 'Pacific/Nowhere' }],
    [{ startMonth: 7 }],
  ])('rejects %j', (fiscalYear) => {
    expect(() => validateConfig({ ...base, fiscalYear })).toThrow(/fiscalYear/);
  });
});

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

  it('the shipped production config/svbc.json validates with its placeholder ids', () => {
    const cfg = validateConfig(rawConfig);
    expect(cfg.donationRollups.donationBoards[0]!.boardId).toBe(0);
    expect(cfg.custodian.annualSummaryBoardId).toBeNull();
  });

  it('the shipped config/sandbox.json validates (the membership block may be on or off — see README "Enabling")', () => {
    expect(() => validateConfig(rawSandboxConfig)).not.toThrow();
  });

  it('the shipped sandbox config validates with the documented membership block switched on', () => {
    const enabled = { ...rawSandboxConfig, donationRollups: { ...rawSandboxConfig.donationRollups, membership: documentedMembershipBlock } };
    expect(validateConfig(enabled).donationRollups.membership?.eligibleGiftTypes).toEqual(['Donation']);
  });
});

// The affiliation cases below index real owner-board keys, so they build on the shipped
// sandbox config (real ids); svbc.json is the production placeholder file.
const rawBase = () => JSON.parse(JSON.stringify(rawSandboxConfig)) as Record<string, any>;

describe('validateConfig — affiliations block', () => {
  it('accepts affiliations: null (feature gated off) even when actingForLink is already wired', () => {
    // The shipped sandbox config's Donations board carries a real Acting for column id
    // regardless of whether the affiliations feature itself is on — validateAffiliations passes
    // actingForLink through unchanged; it isn't forced to null. Force affiliations off here to
    // test that path explicitly, since the shipped config now has it on (see the next test).
    const raw = rawBase();
    raw.affiliations = null;
    const cfg = validateConfig(raw);
    expect(cfg.affiliations).toBeNull();
    expect(cfg.donationRollups.donationBoards[0]!.columns.actingForLink).toBe('board_relation_mm79313');
  });
  it('the shipped sandbox config has the affiliations feature on, wired to the real Affiliations board', () => {
    const cfg = validateConfig(rawBase());
    expect(cfg.affiliations).toEqual({
      boardId: 18431577240,
      columns: {
        personLink: 'board_relation_mm794eac',
        attributedGiving: 'numeric_mm79ym3t',
        attributedGiftCount: 'numeric_mm796s2x',
        lastAttributedGift: 'date_mm79bzkq',
      },
    });
  });
  it('accepts a full affiliations block and an optional organizationalGiving owner column', () => {
    const raw = rawBase();
    raw.affiliations = { boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag',
      attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' } };
    raw.donationRollups.donationBoards[0].columns.actingForLink = 'br_af';
    raw.donationRollups.ownerColumnsByBoard['18431577220'].organizationalGiving = 'n_og';
    const cfg = validateConfig(raw);
    expect(cfg.affiliations).toEqual({ boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag',
      attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' } });
    expect(cfg.donationRollups.donationBoards[0]!.columns.actingForLink).toBe('br_af');
    expect(cfg.donationRollups.ownerColumnsByBoard['18431577220']!.organizationalGiving).toBe('n_og');
    expect(cfg.donationRollups.ownerColumnsByBoard['18431577213']!.organizationalGiving).toBeUndefined();
  });
  it('rejects an affiliations block missing a column, and a block without actingForLink on the donation board', () => {
    const raw = rawBase();
    raw.affiliations = { boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag', attributedGiftCount: 'n_agc' } };
    expect(() => validateConfig(raw)).toThrow(/affiliations\.columns\.lastAttributedGift/);
    raw.affiliations.columns.lastAttributedGift = 'd_lag';
    // The shipped sandbox config already has actingForLink wired; null it out here so this
    // case still exercises the "missing actingForLink" rejection on its own terms.
    raw.donationRollups.donationBoards[0].columns.actingForLink = null;
    expect(() => validateConfig(raw)).toThrow(/actingForLink.*required when affiliations is set/);
  });
});
