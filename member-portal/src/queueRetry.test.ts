import { describe, it, expect } from 'vitest';
import { MAX_RETRY_DELAY_SECONDS, retryDelaySeconds } from './queueRetry';

describe('retryDelaySeconds', () => {
  it('doubles from two minutes on the first attempt', () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([120, 240, 480, 960]);
  });

  // Cloudflare Queues rejects delaySeconds above 43200 (12h).
  it('caps at the Queues maximum of 43200 seconds', () => {
    expect(MAX_RETRY_DELAY_SECONDS).toBe(43_200);
    expect(retryDelaySeconds(10)).toBe(43_200);
    expect(retryDelaySeconds(1_000)).toBe(43_200);
  });

  // A hand-built or replayed message without a sane attempts count still gets a real delay.
  it.each([0, -1, Number.NaN, undefined as unknown as number])('treats attempts = %s as the first attempt', (attempts) => {
    expect(retryDelaySeconds(attempts)).toBe(120);
  });
});
