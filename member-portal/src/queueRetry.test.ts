import { describe, it, expect } from 'vitest';
import { retryDelaySeconds } from './queueRetry';
import { retryDelaySeconds as shared } from './flags';

// Both consumers use the write switch's shared backoff (src/flags.ts), re-exported here.
describe('retryDelaySeconds', () => {
  it('is the shared write-switch backoff', () => {
    expect(retryDelaySeconds).toBe(shared);
  });

  it('doubles from one minute and caps at an hour', () => {
    expect([1, 2, 3, 4, 7, 8, 100].map((n) => retryDelaySeconds(n))).toEqual([60, 120, 240, 480, 3600, 3600, 3600]);
  });

  // A hand-built or replayed message without a sane attempts count still gets a real delay.
  it.each([0, -1, Number.NaN, undefined as unknown as number])('treats attempts = %s as the first attempt', (attempts) => {
    expect(retryDelaySeconds(attempts)).toBe(60);
  });
});
