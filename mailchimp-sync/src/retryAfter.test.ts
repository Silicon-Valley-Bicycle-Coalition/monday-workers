import { describe, it, expect } from 'vitest';
import { parseRetryAfter } from './retryAfter';

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');

  it('reads delay-seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
  });

  it('reads an HTTP-date relative to now, rounding up and never negative', () => {
    expect(parseRetryAfter('Fri, 25 Sep 2026 12:01:30 GMT', now)).toBe(90);
    expect(parseRetryAfter('Fri, 25 Sep 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('returns undefined when absent or unparseable', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
  });
});
