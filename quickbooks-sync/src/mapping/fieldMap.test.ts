import { describe, it, expect } from 'vitest';
import { mapQbToMondayColumns, mapMondayToQbCustomerFields, mondayCellScalar } from './fieldMap';
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
    customerQbIdColumn: null,
    currency: 'USD',
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

  // #33: Monday webhooks deliver column values in their raw per-type shapes, which were sent to
  // QuickBooks as-is (DisplayName: { value: 'New Co' }) and 400'd. They're normalized now.
  describe('normalizes raw Monday webhook column values', () => {
    const raw = (value: unknown) => mapMondayToQbCustomerFields({ text_col: value }, config).DisplayName;

    it('text: { value }', () => expect(raw({ value: 'New Co' })).toBe('New Co'));
    it('email: { email, text }', () => expect(mapMondayToQbCustomerFields({ email_col: { email: 'a@b.test', text: 'A' } }, config)).toEqual({ PrimaryEmailAddr: { Address: 'a@b.test' } }));
    it('phone: { phone, countryShortName }', () => expect(raw({ phone: '+14085551212', countryShortName: 'US' })).toBe('+14085551212'));
    it('long text: { text }', () => expect(raw({ text: 'Notes' })).toBe('Notes'));
    it('date: { date, time }', () => expect(raw({ date: '2026-09-25', time: null })).toBe('2026-09-25'));
    it('status/dropdown: { label: { text } }', () => expect(raw({ label: { index: 1, text: 'Active' } })).toBe('Active'));
    it('numbers: { value: number }', () => expect(raw({ value: 12 })).toBe(12));
    it('plain strings pass through, trimmed', () => expect(raw('  New Co ')).toBe('New Co'));

    it('drops empty, null and unrecognized values instead of sending them', () => {
      for (const value of [null, '', '   ', { value: '' }, { value: null }, { unexpected: true }, []]) {
        expect(mapMondayToQbCustomerFields({ text_col: value }, config), JSON.stringify(value)).toEqual({});
      }
    });
  });

  describe('mondayCellScalar (an item read back from the API)', () => {
    it('prefers the parsed raw value', () => {
      expect(mondayCellScalar({ text: 'AP', value: '{"email":"ap@x.test","text":"AP"}' })).toBe('ap@x.test');
      expect(mondayCellScalar({ text: '60', value: '"60"' })).toBe('60');
    });
    it('falls back to the display text when the value has no readable part (status)', () => {
      expect(mondayCellScalar({ text: 'Active', value: '{"index":1}' })).toBe('Active');
    });
    it('is undefined for an empty or missing cell', () => {
      expect(mondayCellScalar({ text: '', value: null })).toBeUndefined();
      expect(mondayCellScalar(undefined)).toBeUndefined();
    });
  });

  it('maps the item name (column "name") when the config maps it to DisplayName', () => {
    const withName = { ...config, quickbooksSync: { ...config.quickbooksSync, customerCreateFieldMap: { name: 'DisplayName' } } };
    expect(mapMondayToQbCustomerFields({ name: 'Staff Typed Co' }, withName)).toEqual({ DisplayName: 'Staff Typed Co' });
  });
});
