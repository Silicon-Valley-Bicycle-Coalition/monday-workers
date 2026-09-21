import { describe, it, expect } from 'vitest';
import { timingSafeEqual } from './timingSafeEqual';

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('test-secret', 'test-secret')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(timingSafeEqual('test-secret', 'test-secreT')).toBe(false);
  });

  it('returns false for strings of different lengths', () => {
    expect(timingSafeEqual('short', 'much-longer-value')).toBe(false);
  });

  it('returns false when one string is a prefix of the other', () => {
    expect(timingSafeEqual('test-secret', 'test-secret-extra')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
