export interface LoginAttemptStore {
  recordAttempt(email: string, attemptedAtISO: string): Promise<void>;
  countRecentAttempts(email: string, sinceISO: string): Promise<number>;
}

export class D1LoginAttemptStore implements LoginAttemptStore {
  constructor(private db: D1Database) {}

  async recordAttempt(email: string, attemptedAtISO: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO login_attempts (email, attempted_at) VALUES (?1, ?2)`)
      .bind(email.toLowerCase(), attemptedAtISO)
      .run();
  }

  async countRecentAttempts(email: string, sinceISO: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) as count FROM login_attempts WHERE email = ?1 AND attempted_at > ?2`)
      .bind(email.toLowerCase(), sinceISO)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }
}
