import { describe, it, expect } from 'vitest';
import { formatColumnValue } from './columnValues.js';

describe('formatColumnValue', () => {
  it('wraps link values in {url, text}, adding a scheme when missing', () => {
    expect(formatColumnValue('link', 'www.svbc.org')).toEqual({ url: 'https://www.svbc.org', text: 'www.svbc.org' });
    expect(formatColumnValue('link', 'https://svbc.org')).toEqual({ url: 'https://svbc.org', text: 'https://svbc.org' });
  });

  it('wraps phone values in {phone, countryShortName}, stripping punctuation and extensions', () => {
    expect(formatColumnValue('phone', '(408) 555-0100 ext.22')).toEqual({ phone: '4085550100', countryShortName: 'US' });
    expect(formatColumnValue('phone', '+1 408-555-0100')).toEqual({ phone: '14085550100', countryShortName: 'US' });
    expect(formatColumnValue('phone', '408.555.0100 x5')).toEqual({ phone: '4085550100', countryShortName: 'US' });
  });

  it('returns null for a phone with no digits, so the column is skipped', () => {
    expect(formatColumnValue('phone', 'none')).toBeNull();
  });

  it('wraps email values in {email, text}', () => {
    expect(formatColumnValue('email', 'ada@svbc.org')).toEqual({ email: 'ada@svbc.org', text: 'ada@svbc.org' });
  });

  it('sends an empty email as no value, never { email: \'\' }', () => {
    expect(formatColumnValue('email', '')).toBeNull();
    expect(formatColumnValue('email', '  ')).toBeNull();
  });

  it('passes through text, numbers, status, and date values unchanged', () => {
    expect(formatColumnValue('text', 'hello')).toBe('hello');
    expect(formatColumnValue('numbers', '1500')).toBe('1500');
    expect(formatColumnValue('status', 'Active')).toBe('Active');
    expect(formatColumnValue('date', { date: '2017-06-08' })).toEqual({ date: '2017-06-08' });
    expect(formatColumnValue('checkbox', { checked: true })).toEqual({ checked: true });
  });
});

describe('formatColumnValue passthrough of pre-formatted objects', () => {
  it('passes through email values transform already wrapped in {email, text}', () => {
    const v = { email: 'ada@svbc.org', text: 'ada@svbc.org' };
    expect(formatColumnValue('email', v)).toBe(v);
  });

  it('passes through pre-wrapped link and phone objects unchanged', () => {
    const link = { url: 'https://svbc.org', text: 'svbc.org' };
    const phone = { phone: '4085550100', countryShortName: 'US' };
    expect(formatColumnValue('link', link)).toBe(link);
    expect(formatColumnValue('phone', phone)).toBe(phone);
  });
});

describe('formatColumnValue phone extension edge cases', () => {
  it('strips a spelled-out "extension" with hyphenated digits', () => {
    expect(formatColumnValue('phone', '(408) 555-0101 extension 555-0102'))
      .toEqual({ phone: '4085550101', countryShortName: 'US' });
  });
});

describe('formatColumnValue multi-number phone fields', () => {
  it('keeps only the first number when the field holds two', () => {
    expect(formatColumnValue('phone', '(650) 555-0103 or (650)555-0104'))
      .toEqual({ phone: '6505550103', countryShortName: 'US' });
  });

  it('keeps the leading 1 when the first number has a country prefix', () => {
    expect(formatColumnValue('phone', '1-650-555-0103 / 650-555-0104'))
      .toEqual({ phone: '16505550103', countryShortName: 'US' });
  });
});
