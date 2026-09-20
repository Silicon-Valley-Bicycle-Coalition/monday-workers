import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';
import rawConfig from '../config/svbc.json';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { customers: null, invoices: null, products: null },
  },
  quickbooks: {
    apiBaseUrl: 'https://quickbooks.api.intuit.com/v3/company',
  },
  quickbooksSync: {
    columnMap: {
      customer: { DisplayName: 'text_col' },
      invoice: { DocNumber: 'text_col' },
      product: { Name: 'text_col' },
    },
    itemNameField: { customer: 'DisplayName', invoice: 'DocNumber', product: 'Name' },
    linkColumn: { invoice: 'connect_col' },
    customerCreateFieldMap: { text_col: 'DisplayName' },
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

  it('throws when a required board key is missing', () => {
    const { customers: _drop, ...boards } = validConfig.monday.boards;
    const broken = { ...validConfig, monday: { ...validConfig.monday, boards } };
    expect(() => validateConfig(broken)).toThrow(/customers/);
  });

  it('throws when quickbooksSync is missing', () => {
    const { quickbooksSync, ...missing } = validConfig;
    expect(() => validateConfig(missing)).toThrow(/quickbooksSync/);
  });

  it('throws when a required quickbooksSync key is missing', () => {
    const { linkColumn, ...rest } = validConfig.quickbooksSync;
    const broken = { ...validConfig, quickbooksSync: rest };
    expect(() => validateConfig(broken)).toThrow(/linkColumn/);
  });

  it('throws when columnMap is missing an entity key', () => {
    const { customer, ...columnMap } = validConfig.quickbooksSync.columnMap;
    const broken = {
      ...validConfig,
      quickbooksSync: { ...validConfig.quickbooksSync, columnMap },
    };
    expect(() => validateConfig(broken)).toThrow(/columnMap.customer/);
  });

  it('accepts numeric board ids alongside nulls', () => {
    const filledIn = {
      ...validConfig,
      monday: { ...validConfig.monday, boards: { customers: 123, invoices: 456, products: null } },
    };
    expect(validateConfig(filledIn)).toEqual(filledIn);
  });

  it('throws when a board id is a string instead of a number', () => {
    // A quoted board id would compare unequal to the numeric boardId on every incoming Monday
    // webhook, silently ignoring every event — so this has to fail loudly at startup.
    const broken = {
      ...validConfig,
      monday: { ...validConfig.monday, boards: { ...validConfig.monday.boards, customers: '12345' } },
    };
    expect(() => validateConfig(broken)).toThrow(/monday.boards.customers.*number or null/);
  });

  it('throws when a board id is neither a number nor null', () => {
    const broken = {
      ...validConfig,
      monday: { ...validConfig.monday, boards: { ...validConfig.monday.boards, invoices: true } },
    };
    expect(() => validateConfig(broken)).toThrow(/monday.boards.invoices/);
  });

  it('throws when apiUrl is missing or not a string', () => {
    const { apiUrl, ...monday } = validConfig.monday;
    expect(() => validateConfig({ ...validConfig, monday })).toThrow(/monday.apiUrl.*string/);
    expect(() => validateConfig({ ...validConfig, monday: { ...validConfig.monday, apiUrl: 42 } })).toThrow(
      /monday.apiUrl.*string/
    );
  });

  it('throws when itemNameField is missing an entity key', () => {
    const { invoice, ...itemNameField } = validConfig.quickbooksSync.itemNameField;
    const broken = {
      ...validConfig,
      quickbooksSync: { ...validConfig.quickbooksSync, itemNameField },
    };
    expect(() => validateConfig(broken)).toThrow(/itemNameField.invoice/);
  });

  it('requires quickbooks.apiBaseUrl to be an https URL', () => {
    const base = JSON.parse(JSON.stringify(rawConfig)) as Record<string, any>;
    expect(validateConfig(base).quickbooks.apiBaseUrl).toBe('https://quickbooks.api.intuit.com/v3/company');
    base.quickbooks.apiBaseUrl = 'http://quickbooks.api.intuit.com/v3/company';
    expect(() => validateConfig(base)).toThrow('quickbooks.apiBaseUrl');
    delete base.quickbooks;
    expect(() => validateConfig(base)).toThrow('quickbooks');
  });
});
