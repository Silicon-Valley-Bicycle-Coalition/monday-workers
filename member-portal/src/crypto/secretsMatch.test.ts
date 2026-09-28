import { describe, it, expect } from 'vitest';
import { secretsMatch } from './secretsMatch';

describe('secretsMatch', () => {
  it('matches only an identical secret', async () => {
    expect(await secretsMatch('abc', 'abc')).toBe(true);
    expect(await secretsMatch('abc', 'abd')).toBe(false);
    expect(await secretsMatch('abc', 'abcd')).toBe(false);
    expect(await secretsMatch('abcd', 'abc')).toBe(false);
    expect(await secretsMatch('ABC', 'abc')).toBe(false);
  });

  it('never matches a missing or empty value on either side (fail closed)', async () => {
    expect(await secretsMatch('', '')).toBe(false);
    expect(await secretsMatch('', 'abc')).toBe(false);
    expect(await secretsMatch('abc', '')).toBe(false);
    expect(await secretsMatch(undefined, 'abc')).toBe(false);
    expect(await secretsMatch('abc', undefined)).toBe(false);
    expect(await secretsMatch(undefined, undefined)).toBe(false);
  });
});
