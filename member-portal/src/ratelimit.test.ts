import { describe, it, expect, vi } from 'vitest';
import { checkLoginRateLimit } from './ratelimit';
import type { IpRateLimiter } from './ratelimit';
import type { LoginAttemptStore } from './db/loginAttempts';

function fakeAttemptStore(recentCount: number): LoginAttemptStore {
  return {
    recordAttempt: vi.fn().mockResolvedValue(undefined),
    countRecentAttempts: vi.fn().mockResolvedValue(recentCount),
  };
}

function fakeIpLimiter(success: boolean): IpRateLimiter {
  return { limit: vi.fn().mockResolvedValue({ success }) };
}

const config = { emailWindowSeconds: 900, emailMaxAttempts: 5 };
const now = new Date('2026-08-22T00:30:00.000Z');

describe('checkLoginRateLimit', () => {
  it('allows the request when both the IP and email are under their limits', async () => {
    const attemptStore = fakeAttemptStore(2);
    const ipLimiter = fakeIpLimiter(true);

    const allowed = await checkLoginRateLimit('1.2.3.4', 'donor@example.org', { ipLimiter, attemptStore, config }, now);

    expect(allowed).toBe(true);
    expect(attemptStore.recordAttempt).toHaveBeenCalledWith('donor@example.org', now.toISOString());
  });

  it('denies the request when the IP limiter reports failure', async () => {
    const attemptStore = fakeAttemptStore(0);
    const ipLimiter = fakeIpLimiter(false);

    const allowed = await checkLoginRateLimit('1.2.3.4', 'donor@example.org', { ipLimiter, attemptStore, config }, now);

    expect(allowed).toBe(false);
  });

  it('denies the request once the email has reached its attempt ceiling', async () => {
    const attemptStore = fakeAttemptStore(5);
    const ipLimiter = fakeIpLimiter(true);

    const allowed = await checkLoginRateLimit('1.2.3.4', 'donor@example.org', { ipLimiter, attemptStore, config }, now);

    expect(allowed).toBe(false);
  });

  it('still records the attempt when denied by the email ceiling (IP limiter passed)', async () => {
    const attemptStore = fakeAttemptStore(5);
    const ipLimiter = fakeIpLimiter(true);

    await checkLoginRateLimit('1.2.3.4', 'donor@example.org', { ipLimiter, attemptStore, config }, now);

    expect(attemptStore.recordAttempt).toHaveBeenCalledTimes(1);
  });

  it('does not touch D1 at all when the IP limiter denies the request', async () => {
    const attemptStore = fakeAttemptStore(0);
    const ipLimiter = fakeIpLimiter(false);

    const allowed = await checkLoginRateLimit('1.2.3.4', 'donor@example.org', { ipLimiter, attemptStore, config }, now);

    expect(allowed).toBe(false);
    expect(attemptStore.countRecentAttempts).not.toHaveBeenCalled();
    expect(attemptStore.recordAttempt).not.toHaveBeenCalled();
  });
});
