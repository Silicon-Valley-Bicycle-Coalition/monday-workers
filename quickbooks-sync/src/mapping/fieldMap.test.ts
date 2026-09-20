import { describe, it, expect } from 'vitest';
import { mapQbToMondayColumns, mapMondayToQbCustomerFields } from './fieldMap';
import type { QuickbooksSyncConfig } from '../types';

const config: QuickbooksSyncConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { customers: 1, invoices: 2, products: 3 },
  },
  quickbooks: { apiBaseUrl: 'https://quickbooks.api.intuit.com/v3/company' },
  quickbooksSync: {
    columnMap: {
      customer: { DisplayName: 'text_col', 'PrimaryEmailAddr.Address': 'email_col' },
      invoice: { DocNumber: 'text_col', TotalAmt: 'numeric_col' },
      product: { Name: 'text_col' },
    },
    itemNameField: { customer: 'DisplayName', invoice: 'DocNumber', product: 'Name' },
    linkColumn: { invoice: 'connect_col' },
    customerCreateFieldMap: { text_col: 'DisplayName', email_col: 'PrimaryEmailAddr.Address' },
  },
};

describe('mapQbToMondayColumns', () => {
  it('maps mapped fields to their Monday column ids', () => {
    const result = mapQbToMondayColumns('customer', { DisplayName: 'Acme Co' }, config);
    expect(result).toEqual({ text_col: 'Acme Co' });
  });

  it('drops any field not present in columnMap', () => {
    const result = mapQbToMondayColumns('customer', { DisplayName: 'Acme Co', SyncToken: '3' }, config);
    expect(result).not.toHaveProperty('SyncToken');
    expect(Object.keys(result)).toEqual(['text_col']);
  });

  it('supports dot-path field lookup for nested QuickBooks fields', () => {
    const result = mapQbToMondayColumns(
      'customer',
      { DisplayName: 'Acme Co', PrimaryEmailAddr: { Address: 'a@acme.com' } },
      config
    );
    expect(result).toEqual({ text_col: 'Acme Co', email_col: 'a@acme.com' });
  });

  it('omits a column entirely when the source field is absent', () => {
    const result = mapQbToMondayColumns('invoice', { DocNumber: '1001' }, config);
    expect(result).toEqual({ text_col: '1001' });
  });
});

describe('mapMondayToQbCustomerFields', () => {
  it('maps flat Monday column values to top-level QuickBooks fields', () => {
    const result = mapMondayToQbCustomerFields({ text_col: 'New Co' }, config);
    expect(result).toEqual({ DisplayName: 'New Co' });
  });

  it('builds a nested QuickBooks field from a dot-path target', () => {
    const result = mapMondayToQbCustomerFields({ email_col: 'new@co.com' }, config);
    expect(result).toEqual({ PrimaryEmailAddr: { Address: 'new@co.com' } });
  });

  it('combines flat and nested fields from one payload', () => {
    const result = mapMondayToQbCustomerFields({ text_col: 'New Co', email_col: 'new@co.com' }, config);
    expect(result).toEqual({ DisplayName: 'New Co', PrimaryEmailAddr: { Address: 'new@co.com' } });
  });

  it('drops a mapped column that has no value in the payload', () => {
    const result = mapMondayToQbCustomerFields({ text_col: 'New Co' }, config);
    expect(result).not.toHaveProperty('PrimaryEmailAddr');
  });
});
