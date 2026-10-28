import { sha256Hex } from '../crypto/hash';

export interface LoginSendLimits {
  // No second send to one address within this many seconds of the last.
  cooldownSeconds: number;
  windowSeconds: number;
  maxInWindow: number;
  // Rolling 24 hours.
  maxPerDay: number;
}

export interface LoginAttemptStore {
  // Claims one login-email slot for `email` at `now` if every limit still has room, and reports
  // whether it did. A denied call writes nothing, so it can't extend a lockout (issue #62).
  tryReserve(email: string, now: Date, limits: LoginSendLimits): Promise<boolean>;
}

const DAY_MS = 86_400_000;

// Rows are keyed by a SHA-256 of the lowercased address, not the address itself (issue #62).
// Unkeyed, so it only keeps addresses out of plain sight in D1 dumps and query results: anyone
// holding the table and a candidate address can still test for it. Rows live
// rateLimit.attemptRetentionHours.
export function emailHash(email: string): Promise<string> {
  return sha256Hex(`login-attempt:${email.toLowerCase()}`);
}

export class D1LoginAttemptStore implements LoginAttemptStore {
  constructor(private db: D1Database) {}

  async tryReserve(email: string, now: Date, limits: LoginSendLimits): Promise<boolean> {
    const nowMs = now.getTime();
    const since = (ms: number) => new Date(nowMs - ms).toISOString();
    // One statement, so the check and the insert are atomic in D1: requests racing in from many
    // IPs can't all read "room left" before any of them records (check-then-insert could).
    const result = await this.db
      .prepare(
        `INSERT INTO login_attempts (email_hash, attempted_at)
         SELECT ?1, ?2
         WHERE NOT EXISTS (SELECT 1 FROM login_attempts WHERE email_hash = ?1 AND attempted_at > ?3)
           AND (SELECT COUNT(*) FROM login_attempts WHERE email_hash = ?1 AND attempted_at > ?4) < ?5
           AND (SELECT COUNT(*) FROM login_attempts WHERE email_hash = ?1 AND attempted_at > ?6) < ?7`
      )
      .bind(
        await emailHash(email),
        now.toISOString(),
        since(limits.cooldownSeconds * 1000),
        since(limits.windowSeconds * 1000),
        limits.maxInWindow,
        since(DAY_MS),
        limits.maxPerDay
      )
      .run();
    return result.meta.changes === 1;
  }
}
