import { describe, it, expect } from 'vitest';
import { secretsMatch } from './secret';

describe('secretsMatch', () => {
  it('matches only the identical secret', async () => {
    expect(await secretsMatch('shh', 'shh')).toBe(true);
    expect(await secretsMatch('shh!', 'shh')).toBe(false);
    expect(await secretsMatch('sh', 'shh')).toBe(false);
    expect(await secretsMatch('SHH', 'shh')).toBe(false);
  });

  it('fails closed when nothing is configured, or nothing was presented', async () => {
    expect(await secretsMatch(undefined, 'shh')).toBe(false);
    expect(await secretsMatch('', 'shh')).toBe(false);
    expect(await secretsMatch('anything', undefined)).toBe(false);
    expect(await secretsMatch('', '')).toBe(false);
    expect(await secretsMatch(undefined, undefined)).toBe(false);
  });
});
