import type { AuthRetentionStore } from '../db/authRetention';

export interface PurgeExpiredAuthDeps {
  store: AuthRetentionStore;
  // config.rateLimit.attemptRetentionHours — validated to exceed the rate-limit window.
  attemptRetentionHours: number;
  now: () => Date;
}

// Rows deleted per table, or null when that table's purge failed (already logged).
export interface PurgeExpiredAuthResult {
  loginAttempts: number | null;
  sessions: number | null;
  magicLinkTokens: number | null;
  loginCodeChecks: number | null;
}

// Daily retention purge for the auth tables (issue GL#31): login_attempts kept a row per submitted
// email forever, and expired sessions/magic-link tokens were never deleted. login_code_checks
// shares login_attempts' retention. Each table is purged
// independently — scheduled() runs this ahead of the letter cron, so a D1 error on one table must
// not skip the rest.
export async function purgeExpiredAuthRows(deps: PurgeExpiredAuthDeps): Promise<PurgeExpiredAuthResult> {
  const now = deps.now();
  const nowISO = now.toISOString();
  const attemptCutoffISO = new Date(now.getTime() - deps.attemptRetentionHours * 3_600_000).toISOString();

  return {
    loginAttempts: await attempt('login_attempts', () => deps.store.purgeLoginAttemptsBefore(attemptCutoffISO)),
    sessions: await attempt('sessions', () => deps.store.purgeSessionsExpiredBefore(nowISO)),
    magicLinkTokens: await attempt('magic_link_tokens', () => deps.store.purgeMagicLinkTokensExpiredBefore(nowISO)),
    loginCodeChecks: await attempt('login_code_checks', () => deps.store.purgeLoginCodeChecksBefore(attemptCutoffISO)),
  };
}

async function attempt(table: string, purge: () => Promise<number>): Promise<number | null> {
  try {
    return await purge();
  } catch (err) {
    console.error(`member-portal scheduled: ${table} purge failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
