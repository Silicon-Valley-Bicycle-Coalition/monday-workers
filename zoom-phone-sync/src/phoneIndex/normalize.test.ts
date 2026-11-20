import { describe, expect, it } from 'vitest';
import { normalizePeoplePhone } from './normalize';

describe('normalizePeoplePhone', () => {
  it.each([
    ['(408) 555-0100', '+14085550100'],
    ['408-555-0100', '+14085550100'],
    ['408.555.0100', '+14085550100'],
    ['4085550100', '+14085550100'],
    ['1 408 555 0100', '+14085550100'],
    ['+1 408 555 0100', '+14085550100'],
    ['+14085550100', '+14085550100'],
    ['+44 20 7946 0958', '+442079460958'],
    ['  (408) 555-0100  ', '+14085550100'],
  ])('reads %j as %s', (input, expected) => {
    expect(normalizePeoplePhone(input, 'US')).toBe(expected);
  });

  it.each([
    '(408) 555-0100 x123',
    '(408) 555-0100 ext 123',
    '(408) 555-0100 ext. 123',
    '(408) 555-0100 extension 123',
    '408-555-0100x123',
    '408-555-0100 #123',
    '408-555-0100,,123',
  ])('drops the extension in %j', (input) => {
    expect(normalizePeoplePhone(input, 'US')).toBe('+14085550100');
  });

  it.each([null, undefined, '', '   ', '555-0100', 'n/a', 'call office', '0123456789', '(408) 555-01'])(
    'gives null for %j',
    (input) => {
      expect(normalizePeoplePhone(input, 'US')).toBeNull();
    },
  );

  it('reads a bare number as North American only in the US region', () => {
    expect(normalizePeoplePhone('4085550100', 'GB')).toBeNull();
    expect(normalizePeoplePhone('+14085550100', 'GB')).toBe('+14085550100');
  });
});
