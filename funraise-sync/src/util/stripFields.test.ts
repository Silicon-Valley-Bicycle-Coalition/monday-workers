import { describe, it, expect } from 'vitest';
import { stripDenylistedFields } from './stripFields';

describe('stripDenylistedFields', () => {
  it('removes dot-path fields, leaving siblings intact', () => {
    const raw = {
      amount: 100,
      paymentMethod: { lastFour: '4242', expiration: '12/28', brand: 'visa' },
    };
    const stripped = stripDenylistedFields(raw, ['paymentMethod.lastFour', 'paymentMethod.expiration']);
    expect(stripped).toEqual({ amount: 100, paymentMethod: { brand: 'visa' } });
  });

  it('removes top-level fields', () => {
    expect(stripDenylistedFields({ ssn: 'x', amount: 5 }, ['ssn'])).toEqual({ amount: 5 });
  });

  it('ignores paths that do not exist in the payload', () => {
    expect(stripDenylistedFields({ amount: 5 }, ['paymentMethod.lastFour'])).toEqual({ amount: 5 });
  });

  it('does not mutate the input object', () => {
    const raw = { paymentMethod: { lastFour: '4242' } };
    stripDenylistedFields(raw, ['paymentMethod.lastFour']);
    expect(raw.paymentMethod.lastFour).toBe('4242');
  });
});
