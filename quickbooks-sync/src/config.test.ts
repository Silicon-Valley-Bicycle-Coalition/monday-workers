import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const validConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { customers: null, invoices: null, products: null },
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

  it('throws when itemNameField is missing an entity key', () => {
    const { invoice, ...itemNameField } = validConfig.quickbooksSync.itemNameField;
    const broken = {
      ...validConfig,
      quickbooksSync: { ...validConfig.quickbooksSync, itemNameField },
    };
    expect(() => validateConfig(broken)).toThrow(/itemNameField.invoice/);
  });
});
