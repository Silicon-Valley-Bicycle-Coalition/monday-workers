import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';
import rawConfig from '../config/svbc.json';
import rawSandboxConfig from '../config/sandbox.json';

const ownerColumns = {
  giftLedgerJson: 'glj', lifetimeGiving: 'lg', giftCount: 'gc', firstGift: 'fg',
  thisYearAmount: 'tya', thisYearCount: 'tyc', lastYearAmount: 'lya', lastYearCount: 'lyc',
  largestGift: 'lag', smallestGift: 'smg', averageGift: 'avg', lastGiftDate: 'lgd', lastGiftAmount: 'lga',
};
const membershipColumns = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil',
  currentTermStart: 'mcts', memberType: 'mtype', lapseCount: 'mlc', lastLapsed: 'mll' };
const membership = {
  fromISO: '2026-10-16', eligibleGiftTypes: ['Donation'], minAmountCents: 100, termMonths: 13, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal', lifetime: 'Lifetime' },
};
const volunteerBoard = {
  boardId: 7, columns: { attendee: 'att', event: 'ev', attendance: 'atd', role: 'role', hours: null },
  eventBoard: { boardId: 8, columns: { start: 'start' } },
  volunteerRoleLabels: ['Volunteer'], countedAttendanceLabels: ['Attended'],
};
const historicalVolunteerBoard = {
  boardId: 9, columns: { volunteer: 'vol', date: 'dt', hours: 'hrs', status: 'st' }, countedStatusLabels: ['Completed'],
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
    volunteerBoards: [volunteerBoard], historicalVolunteerBoards: [historicalVolunteerBoard],
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
  fromISO: '2026-10-16', eligibleGiftTypes: ['Donation'], minAmountCents: 100, termMonths: 13, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal', lifetime: 'Lifetime' },
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
    ['typeLabels', { new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal' }, /typeLabels\.lifetime/],
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
      ownerColumnsByBoard: { '2': { ...ownerColumns, membership: { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil' } } } } };
    expect(() => validateConfig(bad)).toThrow(/membership\.currentTermStart/);
  });

  it('the shipped production config/svbc.json validates with the cutover board ids', () => {
    const cfg = validateConfig(rawConfig);
    expect(cfg.donationRollups.donationBoards[0]!.boardId).toBe(18437909794);
    expect(cfg.custodian.workspaceId).toBe(18201685);
    expect(cfg.custodian.annualSummaryBoardId).toBe(18438022323);
  });

  it('the shipped config/sandbox.json validates (the membership block may be on or off — see README "Enabling")', () => {
    expect(() => validateConfig(rawSandboxConfig)).not.toThrow();
  });

  it('the shipped sandbox config validates with the documented membership block switched on', () => {
    // The shipped sandbox config has membership off until Task 14 provisions the new People
    // columns, so switching it on also needs an owner membership block and the volunteer arrays.
    const raw = rawSandboxConfig.donationRollups.ownerColumnsByBoard as Record<string, any>;
    const enabled = { ...rawSandboxConfig, donationRollups: { ...rawSandboxConfig.donationRollups,
      ownerColumnsByBoard: { ...raw, '18437342592': { ...raw['18437342592'], membership: membershipColumns } },
      membership: documentedMembershipBlock, volunteerBoards: [], historicalVolunteerBoards: [] } };
    expect(validateConfig(enabled).donationRollups.membership?.eligibleGiftTypes).toEqual(['Donation']);
  });
});

describe('validateConfig — membership activity rule (spec 2026-10-09)', () => {
  it('passes minAmountCents and the renamed type labels through', () => {
    const m = validateConfig(base).donationRollups.membership!;
    expect(m.minAmountCents).toBe(100);
    expect(m.typeLabels).toEqual({ new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal', lifetime: 'Lifetime' });
  });
  it.each([
    ['minAmountCents', -1, /minAmountCents/],
    ['minAmountCents', 1.5, /minAmountCents/],
    ['typeLabels', { new: 'New', renewal: 'Renewal', reacquire: 'Reacquire', lifetime: 'Lifetime' }, /typeLabels\.continuing/],
  ])('rejects a bad membership.%s', (key, value, pattern) => {
    const bad = { ...base, donationRollups: { ...base.donationRollups, membership: { ...membership, [key]: value } } };
    expect(() => validateConfig(bad)).toThrow(pattern);
  });
  it('requires all eight owner membership columns', () => {
    const { lastLapsed: _l, ...seven } = membershipColumns;
    const bad = { ...base, donationRollups: { ...base.donationRollups, ownerColumnsByBoard: { '2': { ...ownerColumns, membership: seven } } } };
    expect(() => validateConfig(bad)).toThrow(/membership\.lastLapsed/);
  });
  it('passes volunteer boards through, hours may be null, arrays may be empty', () => {
    const cfg = validateConfig(base).donationRollups;
    expect(cfg.volunteerBoards).toEqual([volunteerBoard]);
    expect(cfg.historicalVolunteerBoards).toEqual([historicalVolunteerBoard]);
    const empty = validateConfig({ ...base, donationRollups: { ...base.donationRollups, volunteerBoards: [], historicalVolunteerBoards: [] } });
    expect(empty.donationRollups.volunteerBoards).toEqual([]);
  });
  it('requires both volunteer arrays when membership is on, and defaults them to [] when it is off', () => {
    const { volunteerBoards: _v, ...rest } = base.donationRollups;
    expect(() => validateConfig({ ...base, donationRollups: rest })).toThrow(/volunteerBoards/);
    const off = validateConfig({ ...base, donationRollups: { ...rest, membership: null, historicalVolunteerBoards: undefined } });
    expect(off.donationRollups.volunteerBoards).toEqual([]);
    expect(off.donationRollups.historicalVolunteerBoards).toEqual([]);
  });
  it.each([
    ['columns.attendee', { ...volunteerBoard, columns: { ...volunteerBoard.columns, attendee: '' } }, /volunteerBoards\[0\]\.columns\.attendee/],
    ['eventBoard.columns.start', { ...volunteerBoard, eventBoard: { boardId: 8, columns: { start: '' } } }, /eventBoard\.columns\.start/],
    ['volunteerRoleLabels', { ...volunteerBoard, volunteerRoleLabels: [] }, /volunteerRoleLabels/],
    ['hours as a number', { ...volunteerBoard, columns: { ...volunteerBoard.columns, hours: 3 } }, /columns\.hours/],
  ])('rejects a bad volunteerBoards %s', (_label, board, pattern) => {
    const bad = { ...base, donationRollups: { ...base.donationRollups, volunteerBoards: [board] } };
    expect(() => validateConfig(bad)).toThrow(pattern);
  });
  it('rejects a historical volunteer board missing its status column', () => {
    const { status: _s, ...columns } = historicalVolunteerBoard.columns;
    const bad = { ...base, donationRollups: { ...base.donationRollups, historicalVolunteerBoards: [{ ...historicalVolunteerBoard, columns }] } };
    expect(() => validateConfig(bad)).toThrow(/historicalVolunteerBoards\[0\]\.columns\.status/);
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
    expect(cfg.donationRollups.donationBoards[0]!.columns.actingForLink).toBe('board_relation_mm8h44js');
  });
  it('the shipped sandbox config has the affiliations feature on, wired to the real Affiliations board', () => {
    const cfg = validateConfig(rawBase());
    expect(cfg.affiliations).toEqual({
      boardId: 18437342615,
      columns: {
        personLink: 'board_relation_mm8hvr9x',
        attributedGiving: 'numeric_mm8htx9k',
        attributedGiftCount: 'numeric_mm8hn5vv',
        lastAttributedGift: 'date_mm8hy6jg',
      },
    });
  });
  it('accepts a full affiliations block and an optional organizationalGiving owner column', () => {
    const raw = rawBase();
    raw.affiliations = { boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag',
      attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' } };
    raw.donationRollups.donationBoards[0].columns.actingForLink = 'br_af';
    raw.donationRollups.ownerColumnsByBoard['18437342592'].organizationalGiving = 'n_og';
    const cfg = validateConfig(raw);
    expect(cfg.affiliations).toEqual({ boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag',
      attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' } });
    expect(cfg.donationRollups.donationBoards[0]!.columns.actingForLink).toBe('br_af');
    expect(cfg.donationRollups.ownerColumnsByBoard['18437342592']!.organizationalGiving).toBe('n_og');
    expect(cfg.donationRollups.ownerColumnsByBoard['18437342579']!.organizationalGiving).toBeUndefined();
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

describe('classification and donor level config', () => {
  const classification = { fundingStream: 'fs', giftSize: 'gs', fiscalQuarter: 'fq', giftFiscalYear: 'gfy' };
  const donorLevelCfg = {
    leadershipLifetimeCents: 500000, majorLifetimeCents: 50000, majorLargestCents: 20000,
    labels: { leadership: 'Leadership', major: 'Major', donor: 'Donor' },
  };
  const withBoard = (columns: Record<string, unknown>) =>
    ({ ...base, donationRollups: { ...base.donationRollups, donationBoards: [{ ...donationBoard, columns: { ...donationBoard.columns, ...columns } }] } });

  it('defaults classification to null and donorLevel to null when omitted', () => {
    const cfg = validateConfig(base);
    expect(cfg.donationRollups.donationBoards[0]!.columns.classification).toBeNull();
    expect(cfg.donationRollups.donorLevel).toBeNull();
  });

  it('accepts a full classification block', () => {
    const cfg = validateConfig(withBoard({ classification }));
    expect(cfg.donationRollups.donationBoards[0]!.columns.classification).toEqual(classification);
  });

  it('rejects a classification block missing a column', () => {
    const { giftSize: _omit, ...partial } = classification;
    expect(() => validateConfig(withBoard({ classification: partial })))
      .toThrow(/classification\.giftSize must be a Monday column id string/);
  });

  it('accepts donorLevel thresholds and an owner donorLevel column', () => {
    const raw = { ...base, donationRollups: { ...base.donationRollups, donorLevel: donorLevelCfg,
      ownerColumnsByBoard: { ...base.donationRollups.ownerColumnsByBoard,
        '2': { ...base.donationRollups.ownerColumnsByBoard['2'], donorLevel: 'dlv' } } } };
    const cfg = validateConfig(raw);
    expect(cfg.donationRollups.donorLevel).toEqual(donorLevelCfg);
    expect(cfg.donationRollups.ownerColumnsByBoard['2']!.donorLevel).toBe('dlv');
  });

  it('rejects non-integer or negative thresholds', () => {
    const raw = { ...base, donationRollups: { ...base.donationRollups, donorLevel: { ...donorLevelCfg, majorLargestCents: 199.5 } } };
    expect(() => validateConfig(raw)).toThrow(/donorLevel\.majorLargestCents must be a non-negative integer/);
  });

  it('rejects leadership below major', () => {
    const raw = { ...base, donationRollups: { ...base.donationRollups, donorLevel: { ...donorLevelCfg, leadershipLifetimeCents: 100 } } };
    expect(() => validateConfig(raw)).toThrow(/leadershipLifetimeCents must be >= majorLifetimeCents/);
  });
});

describe('validateConfig — recurringGifts block (monday-migration docs/35 §3.1)', () => {
  const recurringGifts = { boardId: 50, columns: { donorLink: 'rdl', status: 'rst' }, activeStatusLabel: 'Active' };
  const withFlag = { '2': { ...ownerColumns, membership: membershipColumns, hasActiveRecurringGift: 'rg' }, '3': ownerColumns };

  it('defaults to null (duty off) when omitted', () => {
    expect(validateConfig(base).donationRollups.recurringGifts).toBeNull();
  });

  it('accepts the board, its two columns and the Active label, plus the People flag column', () => {
    const cfg = validateConfig({ ...base, donationRollups: { ...base.donationRollups, recurringGifts, ownerColumnsByBoard: withFlag } });
    expect(cfg.donationRollups.recurringGifts).toEqual(recurringGifts);
    expect(cfg.donationRollups.ownerColumnsByBoard['2']!.hasActiveRecurringGift).toBe('rg');
  });

  it('rejects a recurringGifts block with no owner board carrying the flag column', () => {
    expect(() => validateConfig({ ...base, donationRollups: { ...base.donationRollups, recurringGifts } }))
      .toThrow(/hasActiveRecurringGift/);
  });

  it('rejects a missing column id or label', () => {
    for (const bad of [{ ...recurringGifts, columns: { donorLink: 'rdl' } }, { ...recurringGifts, activeStatusLabel: '' }]) {
      expect(() => validateConfig({ ...base, donationRollups: { ...base.donationRollups, recurringGifts: bad,
        ownerColumnsByBoard: withFlag } })).toThrow(/recurringGifts/);
    }
  });
});

describe('validateConfig — rollCall block', () => {
  const rollCall = {
    boardId: 60, firstFiscalYear: 2026, excludedGiftTypes: ['Contracts', 'In-kind'], writesPerRun: 100,
    columns: { fiscalYear: 'fy', tier: 'tr', type: 'ty', listed: 'li', total: 'to', gifts: 'gi',
      people: 'pe', organization: 'or', reviewNote: 'rn', rowKey: 'rk' },
    donations: { boardId: 70, columns: { amount: 'am', status: 'st', fiscalYear: 'dfy', giftType: 'gt',
      donorLink: 'dl', matchedBy: 'mb', anonymous: 'an' } },
    people: { '2': { householdId: 'hid', householdGreeting: 'hg', householdEmail: 'he', doNotSolicit: 'dns', dontList: 'dl2' } },
    organizations: { boardId: 80, columns: { recognitionName: 'rec', dontList: 'dl3' } },
  };
  const withRollCall = (rc: unknown) => ({ ...base, donationRollups: { ...base.donationRollups, rollCall: rc } });

  it('defaults to null (duty off) when omitted or null', () => {
    expect(validateConfig(base).donationRollups.rollCall).toBeNull();
    expect(validateConfig(withRollCall(null)).donationRollups.rollCall).toBeNull();
  });

  it('accepts a full block', () => {
    expect(validateConfig(withRollCall(rollCall)).donationRollups.rollCall).toEqual(rollCall);
  });

  it('defaults excludedGiftTypes to ["Contracts"] and writesPerRun to 500', () => {
    const { excludedGiftTypes: _e, writesPerRun: _w, ...bare } = rollCall;
    const cfg = validateConfig(withRollCall(bare)).donationRollups.rollCall!;
    expect(cfg.excludedGiftTypes).toEqual(['Contracts']);
    expect(cfg.writesPerRun).toBe(500);
  });

  it('names the path of a missing column id', () => {
    const { rowKey: _r, ...columns } = rollCall.columns;
    expect(() => validateConfig(withRollCall({ ...rollCall, columns })))
      .toThrow(/donationRollups\.rollCall\.columns\.rowKey/);
    expect(() => validateConfig(withRollCall({ ...rollCall, people: { '2': { householdId: 'x' } } })))
      .toThrow(/donationRollups\.rollCall\.people\["2"\]\.householdGreeting/);
  });

  it('rejects a non-integer firstFiscalYear', () => {
    for (const bad of [2026.5, '2026', undefined]) {
      expect(() => validateConfig(withRollCall({ ...rollCall, firstFiscalYear: bad }))).toThrow(/firstFiscalYear/);
    }
  });
});
