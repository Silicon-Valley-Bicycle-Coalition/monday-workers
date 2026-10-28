import type { LoginAttemptStore } from './db/loginAttempts';

export interface IpRateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

export interface RateLimitConfig {
  emailCooldownSeconds: number;
  emailWindowSeconds: number;
  emailMaxAttempts: number;
  emailDailyMax: number;
}

export interface RateLimitDeps {
  ipLimiter: IpRateLimiter;
  attemptStore: LoginAttemptStore;
  config: RateLimitConfig;
}

export async function checkLoginRateLimit(
  ip: string,
  email: string,
  deps: RateLimitDeps,
  now: Date
): Promise<boolean> {
  // Check the IP limiter first, before touching D1 at all — otherwise a single IP hammering
  // the endpoint with different fabricated emails forces a D1 write on every request, and the
  // IP limiter (the thing meant to stop exactly that) never gets a chance to short-circuit it.
  const ipResult = await deps.ipLimiter.limit(ip);
  if (!ipResult.success) {
    return false;
  }

  // Only a request every per-address limit lets through is recorded (issue #62). Recording denied
  // ones too let anyone rotating IPs keep a donor locked out indefinitely while still sending them
  // a login email every few minutes; now the address gets at most emailDailyMax a day, and each
  // of those carries a working link.
  return deps.attemptStore.tryReserve(email, now, {
    cooldownSeconds: deps.config.emailCooldownSeconds,
    windowSeconds: deps.config.emailWindowSeconds,
    maxInWindow: deps.config.emailMaxAttempts,
    maxPerDay: deps.config.emailDailyMax,
  });
}
