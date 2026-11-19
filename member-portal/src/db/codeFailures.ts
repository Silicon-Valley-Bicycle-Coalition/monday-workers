// Wrong sign-in code guesses per address. Kept apart from magic_link_tokens, whose rows are purged
// once expired (15 minutes in) — that would reset a 24-hour count.
export interface CodeFailureStore {
  recordFailure(emailHash: string, atISO: string): Promise<void>;
  countSince(emailHash: string, sinceISO: string): Promise<number>;
}

export class D1CodeFailureStore implements CodeFailureStore {
  constructor(private db: D1Database) {}

  async recordFailure(emailHash: string, atISO: string): Promise<void> {
    await this.db.prepare('INSERT INTO code_failures (email_hash, failed_at) VALUES (?1, ?2)').bind(emailHash, atISO).run();
  }

  async countSince(emailHash: string, sinceISO: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM code_failures WHERE email_hash = ?1 AND failed_at >= ?2')
      .bind(emailHash, sinceISO)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}
