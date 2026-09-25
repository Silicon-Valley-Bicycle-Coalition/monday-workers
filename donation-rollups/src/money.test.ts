import { describe, it, expect } from 'vitest';
import { parseAmountCents, formatCents } from './money';

describe('parseAmountCents', () => {
  it.each([
    ['50', 5000],
    ['714.93', 71493],
    ['0.1', 10],
    ['0', 0],
    ['1,234.5', 123450],
    ['$1,234.56', 123456],
    ['  25  ', 2500],
    ['.5', 50],
    ['5.', 500],
    ['+12.00', 1200],
    ['-12.34', -1234],
    ['(12.34)', -1234],
    ['-$5', -500],
    ['$-5', -500],
    // Rounded from the decimal string, not a float: 1.005 * 100 is 100.49999999999999.
    ['1.005', 101],
    ['1.004', 100],
    ['-1.005', -101],
    ['1e3', 100000],
  ])('parses %j as %d cents', (text, cents) => {
    expect(parseAmountCents(text)).toBe(cents);
  });

  it.each([[''], ['   '], [null], [undefined], ['abc'], ['1.2.3'], ['1,2a'], ['-'], ['$'], ['()'], ['Infinity'], ['NaN']])(
    'returns null for blank or malformed %j',
    (text) => {
      expect(parseAmountCents(text)).toBeNull();
    },
  );

  // Ambiguous shapes are rejected, not guessed at: "1.234,56" is a European-format 1234.56 that
  // stripping commas would misread as 1.23456; "(-5)" is a double negative.
  it.each([['1.234,56'], ['1.2,3'], ['0.5,'], ['(-5)'], ['(+5)'], ['($-5)'], ['(- 5)']])(
    'returns null for ambiguous %j',
    (text) => {
      expect(parseAmountCents(text)).toBeNull();
    },
  );

  it('still accepts thousands separators before the decimal point', () => {
    expect(parseAmountCents('1,234,567.89')).toBe(123456789);
    expect(parseAmountCents('(1,234.50)')).toBe(-123450);
  });

  it('returns null for amounts past safe-integer cents', () => {
    expect(parseAmountCents('999999999999999999999')).toBeNull();
  });
});

describe('formatCents', () => {
  it.each([
    [71493, '714.93'],
    [0, '0.00'],
    [5, '0.05'],
    [100, '1.00'],
    [-1234, '-12.34'],
    [-5, '-0.05'],
    [123456789, '1234567.89'],
  ])('formats %d as %j', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });

  it('never emits float noise for sums that drift in floating point', () => {
    // 0.1 + 0.2 style drift: summing these as dollars gives 714.9300000000001.
    const cents = [12345, 23456, 35692].reduce((a, b) => a + b, 0);
    expect(formatCents(cents)).toBe('714.93');
  });
});
