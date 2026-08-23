import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: {
      'donations:live': 123,
      'recurring-gifts': null,
      'event-registrations': null,
      'people-live': null,
    },
  },
  funraiseSync: {
    columnMap: {
      transaction: { amount: 'numeric_col' },
      recurringGift: { amount: 'numeric_col' },
      registration: { eventName: 'text_col' },
    },
    itemNameField: {
      transaction: 'description',
      recurringGift: 'description',
      registration: 'eventName',
    },
    entityIdField: {
      transaction: 'id',
      recurringGift: 'id',
      registration: 'id',
    },
    rawPayloadRetentionDays: 90,
    donorExternalIdField: 'donor.contactId',
    donorExternalIdColumn: 'funraise__fr_id__c',
    donorEmailColumn: 'email',
    donorNameField: 'donor.name',
    donorLinkColumn: 'connect_col',
    emailFieldPrecedence: ['donor.email'],
    statusField: 'status',
    statusValueMap: { Posted: 'Done' },
    doNotMigrateFields: ['paymentMethod.lastFour'],
  },
};

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

  it('throws when funraiseSync is missing', () => {
    const { funraiseSync, ...missing } = validConfig;
    expect(() => validateConfig(missing)).toThrow(/funraiseSync/);
  });

  it('throws when a required funraiseSync key is missing', () => {
    const { donorEmailColumn, ...rest } = validConfig.funraiseSync;
    const broken = { ...validConfig, funraiseSync: rest };
    expect(() => validateConfig(broken)).toThrow(/donorEmailColumn/);
  });

  it('throws when columnMap is missing an entity key', () => {
    const { transaction, ...columnMap } = validConfig.funraiseSync.columnMap;
    const broken = {
      ...validConfig,
      funraiseSync: { ...validConfig.funraiseSync, columnMap },
    };
    expect(() => validateConfig(broken)).toThrow(/columnMap.transaction/);
  });
});

describe('validateConfig new keys', () => {
  it('throws when entityIdField is missing', () => {
    const { entityIdField, ...funraiseSync } = validConfig.funraiseSync;
    expect(() => validateConfig({ ...validConfig, funraiseSync })).toThrow(/entityIdField/);
  });

  it('throws when rawPayloadRetentionDays is not a positive number', () => {
    const funraiseSync = { ...validConfig.funraiseSync, rawPayloadRetentionDays: 0 };
    expect(() => validateConfig({ ...validConfig, funraiseSync })).toThrow(/rawPayloadRetentionDays/);
  });
});
