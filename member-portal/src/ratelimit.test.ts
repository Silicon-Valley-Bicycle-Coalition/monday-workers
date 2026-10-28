import { describe, it, expect, vi } from 'vitest';
import { checkLoginRateLimit } from './ratelimit';
import type { IpRateLimiter } from './ratelimit';
import type { LoginAttemptStore } from './db/loginAttempts';

function fakeAttemptStore(reserves: boolean): LoginAttemptStore {
  return { tryReserve: vi.fn().mockResolvedValue(reserves) };
}

function fakeIpLimiter(success: boolean): IpRateLimiter {
  return { limit: vi.fn().mockResolvedValue({ success }) };
}

const config = { emailCooldownSeconds: 60, emailWindowSeconds: 900, emailMaxAttempts: 5, emailDailyMax: 10 };
const now = new Date('2026-08-22T00:30:00.000Z');

describe('checkLoginRateLimit', () => {
  it('allows the request when the IP passes and the address has room, passing every limit through', async () => {
    const attemptStore = fakeAttemptStore(true);

    const allowed = await checkLoginRateLimit('1.2.3.4', 'donor@example.org', { ipLimiter: fakeIpLimiter(true), attemptStore, config }, now);

    expect(allowed).toBe(true);
    expect(attemptStore.tryReserve).toHaveBeenCalledWith('donor@example.org', now, {
      cooldownSeconds: 60,
      windowSeconds: 900,
      maxInWindow: 5,
      maxPerDay: 10,
    });
  });

  it('denies the request when the address has no room left', async () => {
    const allowed = await checkLoginRateLimit(
      '1.2.3.4',
      'donor@example.org',
      { ipLimiter: fakeIpLimiter(true), attemptStore: fakeAttemptStore(false), config },
      now
    );

    expect(allowed).toBe(false);
  });

  it('does not touch D1 at all when the IP limiter denies the request', async () => {
    const attemptStore = fakeAttemptStore(true);

    const allowed = await checkLoginRateLimit('1.2.3.4', 'donor@example.org', { ipLimiter: fakeIpLimiter(false), attemptStore, config }, now);

    expect(allowed).toBe(false);
    expect(attemptStore.tryReserve).not.toHaveBeenCalled();
  });
});
