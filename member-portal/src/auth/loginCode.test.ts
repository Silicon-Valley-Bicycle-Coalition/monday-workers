import { describe, it, expect } from 'vitest';
import { sha256Hex } from '../crypto/hash';
import { generateToken } from '../crypto/token';
import {
  LOGIN_CODE_MAX_ATTEMPTS,
  generateLoginCode,
  hashLoginCode,
  isRequestId,
  normalizeLoginCode,
} from './loginCode';

describe('generateLoginCode', () => {
  it('always returns six digits', () => {
    for (let i = 0; i < 1000; i++) expect(generateLoginCode()).toMatch(/^[0-9]{6}$/);
  });

  it('keeps leading zeros', () => {
    const codes = Array.from({ length: 10_000 }, () => generateLoginCode());
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });
});

describe('normalizeLoginCode', () => {
  it('strips whitespace', () => {
    expect(normalizeLoginCode(' 012 345 ')).toBe('012345');
  });

  it.each(['12345', '1234567', '12a456'])('rejects %s', (input) => {
    expect(normalizeLoginCode(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normalizeLoginCode(42)).toBeNull();
  });
});

describe('isRequestId', () => {
  it('accepts a generated token', () => {
    expect(isRequestId(generateToken())).toBe(true);
  });

  it('rejects other values', () => {
    expect(isRequestId('abc')).toBe(false);
    expect(isRequestId(undefined)).toBe(false);
  });
});

describe('hashLoginCode', () => {
  it('hashes the request id and code together', async () => {
    expect(await hashLoginCode('r', '123456')).toBe(await sha256Hex('r:123456'));
  });
});

describe('LOGIN_CODE_MAX_ATTEMPTS', () => {
  it('is 5', () => {
    expect(LOGIN_CODE_MAX_ATTEMPTS).toBe(5);
  });
});
