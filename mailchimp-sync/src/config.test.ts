import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';
import production from '../config/svbc.json';

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
        lifetimeMember: 'lifetime-member', hasDonated: 'has-donated', doNotSolicit: 'do-not-solicit', recurringDonor: 'recurring-donor',
      },
    },
    lifetimeTierValue: 'Lifetime',
    activeStatusValue: 'Active',
    dnsConfirmedValue: 'Confirmed',
    consent: {
      enabled: true,
      maxChangesPerRun: 500,
      boards: [{ name: 'People', boardId: 1, pairs: [{ emailColumn: 'e1', consentColumn: 'k1' }] }] as unknown[],
    } as Record<string, unknown>,
  };
}

describe('validateConfig', () => {
  it('accepts a fully-populated config', () => {
    const config = validateConfig(validRaw());
    expect(config.mailchimp.audienceId).toBe('abc123');
    expect(config.monday.columns.email).toBe('c9');
  });

  it('leaves journey interests off when absent or null, and reads them when set', () => {
    expect(validateConfig(validRaw()).mailchimp.journeyInterests).toBeNull();
    const raw = validRaw() as { mailchimp: Record<string, unknown> };
    raw.mailchimp.journeyInterests = { welcomeDrip: 'w1', renewalReminders: null, renewalOptOutTag: 'renewal-opt-out' };
    expect(validateConfig(raw).mailchimp.journeyInterests).toEqual({ welcomeDrip: 'w1', renewalReminders: null, renewalOptOutTag: 'renewal-opt-out' });
  });

  it('rejects journey interests without an opt-out tag, or with a blank id', () => {
    const raw = validRaw() as { mailchimp: Record<string, unknown> };
    raw.mailchimp.journeyInterests = { welcomeDrip: 'w1', renewalReminders: 'r1' };
    expect(() => validateConfig(raw)).toThrow('mailchimp.journeyInterests.renewalOptOutTag');
    raw.mailchimp.journeyInterests = { welcomeDrip: '', renewalReminders: 'r1', renewalOptOutTag: 't' };
    expect(() => validateConfig(raw)).toThrow('mailchimp.journeyInterests.welcomeDrip');
  });

  it('reads renewalDue, and rejects a missing tag or an out-of-range window', () => {
    const raw = validRaw() as { mailchimp: Record<string, unknown> };
    expect(validateConfig(raw).mailchimp.renewalDue).toBeNull();
    raw.mailchimp.renewalDue = { tag: 'renewal-due', daysBefore: 28 };
    expect(validateConfig(raw).mailchimp.renewalDue).toEqual({ tag: 'renewal-due', daysBefore: 28 });
    raw.mailchimp.renewalDue = { daysBefore: 28 };
    expect(() => validateConfig(raw)).toThrow('mailchimp.renewalDue.tag');
    raw.mailchimp.renewalDue = { tag: 't', daysBefore: 120 };
    expect(() => validateConfig(raw)).toThrow('mailchimp.renewalDue.daysBefore');
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

  it('treats monday.columns.hasActiveRecurringGift as optional, but a present value must be a column id or null', () => {
    const withRecurring = (value: unknown) => {
      const raw = validRaw();
      (raw.monday.columns as Record<string, unknown>).hasActiveRecurringGift = value;
      return raw;
    };
    expect(() => validateConfig(validRaw())).not.toThrow();
    expect(validateConfig(withRecurring(null)).monday.columns.hasActiveRecurringGift).toBeNull();
    expect(validateConfig(withRecurring('boolean_x')).monday.columns.hasActiveRecurringGift).toBe('boolean_x');
    for (const bad of ['', 5]) {
      expect(() => validateConfig(withRecurring(bad))).toThrow('config: "monday.columns.hasActiveRecurringGift" must be a column id or null');
    }
  });

  it('treats lastGiftAmount (column and merge field) as optional, but a present value must be an id or null', () => {
    const withColumn = (value: unknown) => {
      const raw = validRaw();
      (raw.monday.columns as Record<string, unknown>).lastGiftAmount = value;
      return raw;
    };
    const withTag = (value: unknown) => {
      const raw = validRaw();
      (raw.mailchimp.mergeFields as Record<string, unknown>).lastGiftAmount = value;
      return raw;
    };
    expect(validateConfig(withColumn(null)).monday.columns.lastGiftAmount).toBeNull();
    expect(validateConfig(withColumn('numeric_x')).monday.columns.lastGiftAmount).toBe('numeric_x');
    expect(validateConfig(withTag('LASTGIFT')).mailchimp.mergeFields.lastGiftAmount).toBe('LASTGIFT');
    expect(validateConfig(withTag(null)).mailchimp.mergeFields.lastGiftAmount).toBeNull();
    for (const bad of ['', 5]) {
      expect(() => validateConfig(withColumn(bad))).toThrow('config: "monday.columns.lastGiftAmount" must be a column id or null');
      expect(() => validateConfig(withTag(bad))).toThrow('config: "mailchimp.mergeFields.lastGiftAmount" must be a merge tag or null');
    }
  });

  it('accepts a null or string monday.columns.state and rejects anything else', () => {
    const withState = (value: unknown) => {
      const raw = validRaw();
      (raw.monday.columns as Record<string, unknown>).state = value;
      return raw;
    };
    expect(validateConfig(withState(null)).monday.columns.state).toBeNull();
    expect(validateConfig(withState('text_x')).monday.columns.state).toBe('text_x');
    for (const bad of [undefined, '', 5]) {
      expect(() => validateConfig(withState(bad))).toThrow('config: "monday.columns.state" must be a column id or null');
    }
  });

  it('rejects a REPLACE_WITH_COLUMN_ID placeholder for monday.columns.state', () => {
    const raw = validRaw();
    (raw.monday.columns as Record<string, unknown>).state = 'REPLACE_WITH_COLUMN_ID';
    expect(() => validateConfig(raw)).toThrow('config: "monday.columns.state" must be a column id or null');
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

describe('validateConfig: monday.historical', () => {
  const COLUMNS = {
    membershipStatus: 'h1', membershipTier: 'h2', memberSince: 'h3', memberUntil: 'h4', addr1: 'h5', city: 'h6',
    state: null, zip: 'h7', email: 'h8', totalGiven: 'h9', doNotSolicit: 'h10', dnsReasonStatus: 'h11', nearby: null,
  };
  const withHistorical = (historical: unknown, donorsBoardId: number | null = 111) => {
    const raw = validRaw() as unknown as { monday: Record<string, unknown> };
    raw.monday.donorsBoardId = donorsBoardId;
    raw.monday.historical = historical;
    return raw;
  };

  it('reads the board and its columns, which need no mailchimpCampaigns', () => {
    const config = validateConfig(withHistorical({ boardId: 222, columns: COLUMNS }));
    expect(config.monday.historical?.boardId).toBe(222);
    expect(config.monday.historical?.columns.email).toBe('h8');
  });

  it('treats null or an absent key as not watching a second board', () => {
    expect(validateConfig(withHistorical(null)).monday.historical).toBeNull();
    expect(validateConfig(validRaw()).monday.historical).toBeNull();
  });

  it('rejects a board with no id, a missing column, or a placeholder state', () => {
    expect(() => validateConfig(withHistorical({ boardId: null, columns: COLUMNS }))).toThrow('monday.historical.boardId');
    expect(() => validateConfig(withHistorical({ boardId: 222, columns: { ...COLUMNS, email: '' } }))).toThrow('monday.historical.columns.email');
    expect(() => validateConfig(withHistorical({ boardId: 222, columns: { ...COLUMNS, state: 'REPLACE_WITH_COLUMN_ID' } }))).toThrow('monday.historical.columns.state');
  });

  it('needs the People board, since People owns an address both boards hold', () => {
    expect(() => validateConfig(withHistorical({ boardId: 222, columns: COLUMNS }, null))).toThrow('monday.donorsBoardId');
  });
});

describe('validateConfig: consent', () => {
  it('validates the consent block', () => {
    const config = validateConfig(production);
    expect(config.consent.boards.map((b) => b.boardId)).toEqual([18437909781, 18437909784, 18437909787]);
    expect(config.consent.enabled).toBe(true);
    expect(config.consent.maxChangesPerRun).toBe(500);
    expect(config.consent.boards[2]!.pairs).toEqual([{ emailColumn: 'email_mm8ndy69', consentColumn: 'color_mm8nb7dq' }]);
  });

  it('rejects a missing consent block', () => {
    const raw = validRaw() as Record<string, unknown>;
    delete raw.consent;
    expect(() => validateConfig(raw)).toThrow(/consent/);
  });

  it('rejects a board with no pairs', () => {
    const raw = validRaw();
    raw.consent.boards = [{ name: 'People', boardId: 1, pairs: [] }];
    expect(() => validateConfig(raw)).toThrow(/consent/);
  });

  it('rejects a pair with a blank column id', () => {
    const raw = validRaw();
    raw.consent.boards = [{ name: 'People', boardId: 1, pairs: [{ emailColumn: '', consentColumn: 'k1' }] }];
    expect(() => validateConfig(raw)).toThrow(/consent/);
  });

  it('rejects a non-positive maxChangesPerRun', () => {
    const raw = validRaw();
    raw.consent.maxChangesPerRun = 0;
    expect(() => validateConfig(raw)).toThrow(/consent/);
  });

  it('rejects a non-boolean enabled', () => {
    const raw = validRaw();
    raw.consent.enabled = 'yes';
    expect(() => validateConfig(raw)).toThrow(/consent/);
  });

  it('reads journeyLog and profileLinks, both off when absent or null', () => {
    const raw = validRaw() as Record<string, unknown>;
    expect(validateConfig(raw).journeyLog).toBeNull();
    expect(validateConfig(raw).profileLinks).toBeNull();
    raw.journeyLog = { boardId: 1, emailColumns: ['e1', 'e2'], timelineActivityId: 'act', journeyIds: null, lastJourneyEmailColumn: 'd1', maxEntriesPerRun: 200 };
    const profileLinks = { boardId: 1, emailColumn: 'e1', linkColumn: 'l1', maxWritesPerRun: 500 };
    raw.profileLinks = profileLinks;
    expect(validateConfig(raw).journeyLog).toEqual(raw.journeyLog);
    expect(validateConfig(raw).profileLinks).toEqual({ ...profileLinks, preferences: null });
  });

  const PAGE = 'https://org.us9.list-manage.com/profile?u=f5051c378a338d4fba23caa04&id=abc123';

  it('reads profileLinks.preferences', () => {
    const raw = validRaw() as Record<string, unknown>;
    const preferences = { column: 'p1', pageUrl: PAGE };
    raw.profileLinks = { boardId: 1, emailColumn: 'e1', linkColumn: 'l1', maxWritesPerRun: 500, preferences };
    expect(validateConfig(raw).profileLinks?.preferences).toEqual(preferences);
  });

  it("rejects a preferences page that isn't this audience's hosted profile page", () => {
    const bad = [
      { column: '', pageUrl: PAGE },
      { column: 'p1', pageUrl: PAGE.replace('id=abc123', 'id=other') },          // another audience
      { column: 'p1', pageUrl: PAGE.replace('/profile', '/subscribe') },
      { column: 'p1', pageUrl: PAGE.replace('https:', 'http:') },
      { column: 'p1', pageUrl: PAGE.replace('list-manage.com', 'example.com') },
      { column: 'p1', pageUrl: PAGE.replace('u=f5051c378a338d4fba23caa04&', '') },
      { column: 'p1', pageUrl: `${PAGE}&e=0647d7be1b` },                           // one person's page
      { column: 'p1', pageUrl: 'not a url' },
    ];
    for (const preferences of bad) {
      const raw = validRaw() as Record<string, unknown>;
      raw.profileLinks = { boardId: 1, emailColumn: 'e1', linkColumn: 'l1', maxWritesPerRun: 500, preferences };
      expect(() => validateConfig(raw), JSON.stringify(preferences)).toThrow(/profileLinks\.preferences/);
    }
  });

  it('rejects a journeyLog or profileLinks missing what it needs', () => {
    const base = { boardId: 1, emailColumns: ['e1'], timelineActivityId: 'act', journeyIds: null, lastJourneyEmailColumn: null, maxEntriesPerRun: 200 };
    for (const bad of [{ emailColumns: [] }, { timelineActivityId: '' }, { journeyIds: [] }, { maxEntriesPerRun: 0 }, { lastJourneyEmailColumn: '' }]) {
      const raw = validRaw() as Record<string, unknown>;
      raw.journeyLog = { ...base, ...bad };
      expect(() => validateConfig(raw)).toThrow(/journeyLog/);
    }
    const raw = validRaw() as Record<string, unknown>;
    raw.profileLinks = { boardId: 1, emailColumn: 'e1', maxWritesPerRun: 1 };
    expect(() => validateConfig(raw)).toThrow(/profileLinks/);
  });

  it('reads employerAnswers, off when absent or null', () => {
    const raw = validRaw() as Record<string, unknown>;
    expect(validateConfig(raw).employerAnswers).toBeNull();
    raw.employerAnswers = null;
    expect(validateConfig(raw).employerAnswers).toBeNull();
    raw.employerAnswers = { mergeField: 'EMPLOYER', boardId: 1, emailColumns: ['e1', 'e2'], maxAnswersPerRun: 50 };
    expect(validateConfig(raw).employerAnswers).toEqual(raw.employerAnswers);
  });

  it('rejects an employerAnswers missing what it needs', () => {
    const base = { mergeField: 'EMPLOYER', boardId: 1, emailColumns: ['e1'], maxAnswersPerRun: 50 };
    for (const bad of [{ mergeField: 'employer' }, { mergeField: 'EMPLOYERNAME1' }, { mergeField: '' }, { boardId: '1' }, { emailColumns: [] }, { maxAnswersPerRun: 0 }]) {
      const raw = validRaw() as Record<string, unknown>;
      raw.employerAnswers = { ...base, ...bad };
      expect(() => validateConfig(raw)).toThrow(/employerAnswers/);
    }
  });

  const stewardship = () => ({
    boardId: 1,
    columns: {
      email: 'e', label: 'l', membershipStatus: 'ms', membershipTier: 't', memberType: 'mt',
      memberSince: 's', memberUntil: 'u', hasActiveRecurringGift: 'r', doNotSolicit: 'd',
    },
    plan: {
      labels: { welcomeDayAfter: 'W1', welcome3Weeks: 'W2', renewal3Weeks: 'R1', renewal1Week: 'R2', renewalDayOf: 'R3' },
      activeStatusValue: 'Active', lifetimeTierValue: 'Lifetime', newMemberTypeValue: 'New', catchUpDays: 2, renewalMonthsEarly: 0,
    },
    renewalOptOutTag: 'renewal-opt-out', renewalInterest: 'r1', welcomeInterest: null, maxWritesPerRun: 200,
  });

  it('reads stewardship, off when absent or null', () => {
    const raw = validRaw() as Record<string, unknown>;
    expect(validateConfig(raw).stewardship).toBeNull();
    raw.stewardship = stewardship();
    expect(validateConfig(raw).stewardship).toEqual(stewardship());
  });

  it('rejects a stewardship block missing what it needs', () => {
    const s = stewardship();
    for (const bad of [
      { ...s, columns: { ...s.columns, label: '' } },
      { ...s, plan: { ...s.plan, labels: { ...s.plan.labels, renewalDayOf: 'R1' } } },
      { ...s, plan: { ...s.plan, catchUpDays: 7 } },
      { ...s, plan: { ...s.plan, renewalMonthsEarly: undefined } },
      { ...s, plan: { ...s.plan, renewalMonthsEarly: -1 } },
      { ...s, plan: { ...s.plan, renewalMonthsEarly: 1.5 } },
      { ...s, plan: { ...s.plan, renewalMonthsEarly: 12 } },
      { ...s, plan: { ...s.plan, newMemberTypeValue: undefined } },
      { ...s, renewalOptOutTag: '' },
      { ...s, renewalInterest: '' },
      { ...s, maxWritesPerRun: 0 },
    ]) {
      const raw = validRaw() as Record<string, unknown>;
      raw.stewardship = bad;
      expect(() => validateConfig(raw)).toThrow(/stewardship/);
    }
  });
});
