import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv.js';

describe('csvCell', () => {
  it.each([
    ['=HYPERLINK("http://x","click")', `"'=HYPERLINK(""http://x"",""click"")"`],
    ['+1234', "'+1234"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tTab', "'\tTab"],
    ['\rCR', `"'\rCR"`],
  ])('neutralizes a formula-trigger string %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('leaves ordinary text alone, quoting only when needed', () => {
    expect(csvCell('Ada Lovelace')).toBe('Ada Lovelace');
    expect(csvCell('Lovelace, Ada')).toBe('"Lovelace, Ada"');
    expect(csvCell('a "quote"')).toBe('"a ""quote"""');
    expect(csvCell('Jean-Luc')).toBe('Jean-Luc'); // a '-' only matters as the first character
  });

  it('writes numbers as numbers, including negative longitudes', () => {
    expect(csvCell(-121.9027)).toBe('-121.9027');
    expect(csvCell(37.33)).toBe('37.33');
  });

  it('writes null/undefined as an empty cell', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

describe('toCsv', () => {
  it('joins a header and rows with a trailing newline', () => {
    expect(toCsv(['id', 'name', 'lng'], [['1', '=cmd', -121.9]])).toBe("id,name,lng\n1,'=cmd,-121.9\n");
  });
});
