import type { LoginAttemptStore } from './db/loginAttempts';

export interface IpRateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

export interface RateLimitConfig {
  emailWindowSeconds: number;
  emailMaxAttempts: number;
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

  const nowISO = now.toISOString();
  const sinceISO = new Date(now.getTime() - deps.config.emailWindowSeconds * 1000).toISOString();

  // Count attempts prior to this one, then record this one — so "emailMaxAttempts" means
  // "this many attempts already used in the window", and the next one past that is denied.
  const priorCount = await deps.attemptStore.countRecentAttempts(email, sinceISO);
  await deps.attemptStore.recordAttempt(email, nowISO);

  return priorCount < deps.config.emailMaxAttempts;
}
