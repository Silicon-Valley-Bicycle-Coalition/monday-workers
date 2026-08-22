import { describe, it, expect } from 'vitest';
import { normalizeAddress } from './normalize.js';

describe('normalizeAddress', () => {
  it('uppercases, trims, and joins with pipes', () => {
    expect(normalizeAddress({ street: ' 123 Main St ', city: 'San Jose', state: 'ca', zip: '95112' }))
      .toBe('123 MAIN ST|SAN JOSE|CA|95112');
  });
  it('collapses internal whitespace', () => {
    expect(normalizeAddress({ street: '123  Main\tSt', city: 'San  Jose', state: 'CA', zip: '95112' }))
      .toBe('123 MAIN ST|SAN JOSE|CA|95112');
  });
  it('returns null without street or city', () => {
    expect(normalizeAddress({ street: null, city: 'San Jose' })).toBeNull();
    expect(normalizeAddress({ street: '1 Elm', city: '' })).toBeNull();
  });
});
