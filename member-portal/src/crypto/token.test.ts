import { describe, it, expect } from 'vitest';
import { generateToken } from './token';

describe('generateToken', () => {
  it('returns a 64-character lowercase hex string', () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a different value on each call', () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});
