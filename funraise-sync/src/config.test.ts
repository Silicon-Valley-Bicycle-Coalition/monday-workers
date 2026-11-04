import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: {
      'donations:live': 123,
      'recurring-gifts': null,
      'people-live': null,
    },
  },
  funraiseSync: {
    columnMap: { 'transaction.amount': 'numeric_col' },
    itemNameField: 'description',
    entityIdField: 'id',
    entityIdColumn: null,
    thankYouSentColumn: null,
    giftTypeColumn: null,
    giftTypeValue: 'Donation',
    eventGiftTypeValue: 'Event Ticket',
    fiscalYearColumn: null,
    oldestActiveFiscalYear: null,
    recurringGiftLinkColumn: null,
    rawPayloadRetentionDays: 90,
    unresolvedPayloadRetentionDays: 365,
    donorExternalIdField: 'supporter.id',
    donorExternalIdColumn: 'funraise_profile_col',
    donorEmailColumn: 'email',
    donorNameField: 'supporter.name',
    donorFirstNameField: 'supporter.firstName',
    donorLastNameField: 'supporter.lastName',
    donorFirstNameColumn: 'first_col',
    donorLastNameColumn: 'last_col',
    donorLinkColumn: 'connect_col',
    emailFieldPrecedence: ['supporter.email'],
    statusField: 'transaction.status',
    statusValueMap: { Complete: 'Received' },
    doNotMigrateFields: ['transaction.lastFour'],
  },
  subscriptionsPoll: {
    enabled: false,
    columns: {
      funraiseId: 'rg_id',
      donor: 'rg_donor',
      installmentAmount: 'rg_amount',
      annualizedValue: null,
      frequency: 'rg_frequency',
      status: 'rg_status',
      nextPayment: 'rg_next',
      designation: null,
      companyMatch: null,
      matchEmployer: null,
    },
    frequencyMultiplier: { Monthly: 12, Quarterly: 4, Yearly: 1 },
    statusLabelMap: { Active: 'Active', Cancelled: 'Cancelled' },
    funraiseLinkBase: 'https://platform.funraise.io/transaction/',
    maxPagesPerRun: 1,
  },
};

function withFunraiseSync(patch: Record<string, unknown>) {
  return { ...validConfig, funraiseSync: { ...validConfig.funraiseSync, ...patch } };
}

function withPoll(patch: Record<string, unknown>) {
  return { ...validConfig, subscriptionsPoll: { ...validConfig.subscriptionsPoll, ...patch } };
}

describe('validateConfig', () => {
  it('returns the config unchanged when valid', () => {
    expect(validateConfig(validConfig)).toEqual(validConfig);
  });

  it('throws when monday is missing', () => {
    const { monday, ...missing } = validConfig;
    expect(() => validateConfig(missing)).toThrow(/monday/);
  });

  it('throws when monday.apiUrl is missing', () => {
    const { apiUrl, ...mondayRest } = validConfig.monday;
    const broken = { ...validConfig, monday: mondayRest };
    expect(() => validateConfig(broken)).toThrow(/apiUrl/);
  });

  it('throws when a required board key is missing', () => {
    const { 'donations:live': _drop, ...boards } = validConfig.monday.boards;
    const broken = { ...validConfig, monday: { ...validConfig.monday, boards } };
    expect(() => validateConfig(broken)).toThrow(/donations:live/);
  });

  it('throws when a board id is neither a number nor null, naming the key', () => {
    for (const bad of ['18428131768', '', {}]) {
      const boards = { ...validConfig.monday.boards, 'recurring-gifts': bad };
      expect(() => validateConfig({ ...validConfig, monday: { ...validConfig.monday, boards } })).toThrow(/monday.boards.recurring-gifts/);
    }
  });

  it('no longer requires an event-registrations board — Funraise has no registration source', () => {
    const boards = { ...validConfig.monday.boards, 'event-registrations': 999 };
    expect(() => validateConfig({ ...validConfig, monday: { ...validConfig.monday, boards } })).not.toThrow();
  });

  it('throws when funraiseSync is missing', () => {
    const { funraiseSync, ...missing } = validConfig;
    expect(() => validateConfig(missing)).toThrow(/funraiseSync/);
  });

  it('throws when a required funraiseSync key is missing', () => {
    const { donorEmailColumn, ...rest } = validConfig.funraiseSync;
    const broken = { ...validConfig, funraiseSync: rest };
    expect(() => validateConfig(broken)).toThrow(/donorEmailColumn/);
  });

  it('throws when columnMap is missing or not an object of column ids', () => {
    const { columnMap, ...rest } = validConfig.funraiseSync;
    expect(() => validateConfig({ ...validConfig, funraiseSync: rest })).toThrow(/columnMap/);
    expect(() => validateConfig(withFunraiseSync({ columnMap: { amount: 42 } }))).toThrow(/columnMap.amount/);
  });

  it('rejects the pre-2026-09-18 per-entity columnMap shape so a stale fork config fails loudly', () => {
    expect(() =>
      validateConfig(withFunraiseSync({ columnMap: { transaction: { amount: 'numeric_col' } } }))
    ).toThrow(/columnMap.transaction/);
  });
});

describe('validateConfig new keys', () => {
  it('throws when entityIdField is missing or empty', () => {
    const { entityIdField, ...funraiseSync } = validConfig.funraiseSync;
    expect(() => validateConfig({ ...validConfig, funraiseSync })).toThrow(/entityIdField/);
    expect(() => validateConfig(withFunraiseSync({ entityIdField: '' }))).toThrow(/entityIdField/);
  });

  it('throws when itemNameField is not a non-empty string', () => {
    expect(() => validateConfig(withFunraiseSync({ itemNameField: {} }))).toThrow(/itemNameField/);
  });

  it('throws when rawPayloadRetentionDays is not a positive number', () => {
    expect(() => validateConfig(withFunraiseSync({ rawPayloadRetentionDays: 0 }))).toThrow(/rawPayloadRetentionDays/);
  });

  it('throws when thankYouSentColumn is missing', () => {
    const { thankYouSentColumn, ...funraiseSync } = validConfig.funraiseSync;
    expect(() => validateConfig({ ...validConfig, funraiseSync })).toThrow(/thankYouSentColumn/);
  });

  it('throws when thankYouSentColumn is an empty string', () => {
    expect(() => validateConfig(withFunraiseSync({ thankYouSentColumn: '' }))).toThrow(/thankYouSentColumn/);
  });

  it('accepts a configured thankYouSentColumn', () => {
    expect(() => validateConfig(withFunraiseSync({ thankYouSentColumn: 'thank_you_col' }))).not.toThrow();
  });

  it('throws when emailFieldPrecedence is empty', () => {
    expect(() => validateConfig(withFunraiseSync({ emailFieldPrecedence: [] }))).toThrow(/emailFieldPrecedence/);
  });

  it('throws when statusValueMap has a non-string value', () => {
    expect(() => validateConfig(withFunraiseSync({ statusValueMap: { Complete: 1 } }))).toThrow(/statusValueMap/);
  });

  it('throws when doNotMigrateFields is not an array of strings', () => {
    expect(() => validateConfig(withFunraiseSync({ doNotMigrateFields: 'paymentMethod' }))).toThrow(/doNotMigrateFields/);
  });

  it('throws when a donor field key is an empty string', () => {
    expect(() => validateConfig(withFunraiseSync({ donorLinkColumn: '' }))).toThrow(/donorLinkColumn/);
  });
});

describe('validateConfig — giftTypeColumn / giftTypeValue / eventGiftTypeValue', () => {
  it('throws when giftTypeColumn is missing', () => {
    const { giftTypeColumn, ...funraiseSync } = validConfig.funraiseSync;
    expect(() => validateConfig({ ...validConfig, funraiseSync })).toThrow(/giftTypeColumn/);
  });
  it('throws when giftTypeColumn is an empty string', () => {
    expect(() => validateConfig(withFunraiseSync({ giftTypeColumn: '' }))).toThrow(/giftTypeColumn/);
  });
  it('throws when giftTypeValue is empty while the column is set', () => {
    expect(() => validateConfig(withFunraiseSync({ giftTypeColumn: 'gt_col', giftTypeValue: '' }))).toThrow(/giftTypeValue/);
  });
  it('throws when eventGiftTypeValue is empty while the column is set', () => {
    expect(() => validateConfig(withFunraiseSync({ giftTypeColumn: 'gt_col', eventGiftTypeValue: '' }))).toThrow(
      /eventGiftTypeValue/
    );
  });
  it('accepts a configured column and both values', () => {
    expect(() =>
      validateConfig(withFunraiseSync({ giftTypeColumn: 'gt_col', giftTypeValue: 'Donation', eventGiftTypeValue: 'Event Ticket' }))
    ).not.toThrow();
  });
});

describe('validateConfig nullable column ids', () => {
  for (const key of ['fiscalYearColumn', 'recurringGiftLinkColumn', 'entityIdColumn'] as const) {
    it(`requires ${key} to be present as a column id or null`, () => {
      const { [key]: _drop, ...funraiseSync } = validConfig.funraiseSync;
      expect(() => validateConfig({ ...validConfig, funraiseSync })).toThrow(new RegExp(key));
      expect(() => validateConfig(withFunraiseSync({ [key]: '' }))).toThrow(new RegExp(key));
      expect(() => validateConfig(withFunraiseSync({ [key]: 2027 }))).toThrow(new RegExp(key));
      expect(() => validateConfig(withFunraiseSync({ [key]: null }))).not.toThrow();
      expect(() => validateConfig(withFunraiseSync({ [key]: 'some_col' }))).not.toThrow();
    });
  }
});

describe('validateConfig oldestActiveFiscalYear', () => {
  it('requires the key to be present', () => {
    const { oldestActiveFiscalYear: _drop, ...funraiseSync } = validConfig.funraiseSync;
    expect(() => validateConfig({ ...validConfig, funraiseSync })).toThrow(/oldestActiveFiscalYear/);
  });

  it.each([0, -1, 2026.5, '2026', NaN])('rejects %s', (value) => {
    expect(() => validateConfig(withFunraiseSync({ oldestActiveFiscalYear: value }))).toThrow(/oldestActiveFiscalYear/);
  });

  it.each([null, 2026])('accepts %s', (value) => {
    expect(() => validateConfig(withFunraiseSync({ oldestActiveFiscalYear: value }))).not.toThrow();
  });
});

describe('validateConfig subscriptionsPoll', () => {
  it('throws when the block is missing', () => {
    const { subscriptionsPoll, ...rest } = validConfig;
    expect(() => validateConfig(rest)).toThrow(/subscriptionsPoll/);
  });

  it('throws when enabled is not a boolean', () => {
    expect(() => validateConfig(withPoll({ enabled: 'yes' }))).toThrow(/subscriptionsPoll.enabled/);
  });

  it('requires every column key, each a column id or null', () => {
    const { funraiseId, ...columns } = validConfig.subscriptionsPoll.columns;
    expect(() => validateConfig(withPoll({ columns }))).toThrow(/subscriptionsPoll.columns.funraiseId/);
    expect(() => validateConfig(withPoll({ columns: { ...validConfig.subscriptionsPoll.columns, status: '' } }))).toThrow(
      /subscriptionsPoll.columns.status/
    );
  });

  it('requires positive frequency multipliers and string status labels', () => {
    expect(() => validateConfig(withPoll({ frequencyMultiplier: { Monthly: 0 } }))).toThrow(/frequencyMultiplier/);
    expect(() => validateConfig(withPoll({ statusLabelMap: { Active: 1 } }))).toThrow(/statusLabelMap/);
  });

  it('requires a non-empty funraiseLinkBase', () => {
    expect(() => validateConfig(withPoll({ funraiseLinkBase: '' }))).toThrow(/funraiseLinkBase/);
  });

  // Workers Free allows 50 external subrequests per invocation; one page of ten rows costs up
  // to ~45, so the run must be bounded in config, not just by the code's safety cap.
  it('requires maxPagesPerRun to be a positive integer', () => {
    const { maxPagesPerRun, ...poll } = validConfig.subscriptionsPoll;
    expect(() => validateConfig({ ...validConfig, subscriptionsPoll: poll })).toThrow(/maxPagesPerRun/);
    for (const bad of [0, -1, 1.5, '1']) {
      expect(() => validateConfig(withPoll({ maxPagesPerRun: bad }))).toThrow(/maxPagesPerRun/);
    }
    expect(() => validateConfig(withPoll({ maxPagesPerRun: 1 }))).not.toThrow();
  });
});
