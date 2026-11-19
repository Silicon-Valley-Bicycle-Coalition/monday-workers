// Wrong sign-in code guesses per address. Kept apart from magic_link_tokens, whose rows are purged
// once expired (15 minutes in) — that would reset a 24-hour count.
export interface CodeFailureStore {
  // Takes a slot in the address's failure budget, atomically: inserts a row only while fewer than
  // `max` rows exist at or after sinceISO. Returns the row id, or null when the budget is spent.
  // Callers reserve before comparing a code, so parallel guesses can't all pass a count first.
  reserveFailure(emailHash: string, atISO: string, sinceISO: string, max: number): Promise<number | null>;
  // Gives a reserved slot back (the guess turned out right).
  releaseFailure(id: number): Promise<void>;
}

export class D1CodeFailureStore implements CodeFailureStore {
  constructor(private db: D1Database) {}

  async reserveFailure(emailHash: string, atISO: string, sinceISO: string, max: number): Promise<number | null> {
    const row = await this.db
      .prepare(
        `INSERT INTO code_failures (email_hash, failed_at)
         SELECT ?1, ?2
         WHERE (SELECT COUNT(*) FROM code_failures WHERE email_hash = ?1 AND failed_at >= ?3) < ?4
         RETURNING id`
      )
      .bind(emailHash, atISO, sinceISO, max)
      .first<{ id: number }>();
    return row?.id ?? null;
  }

  async releaseFailure(id: number): Promise<void> {
    await this.db.prepare('DELETE FROM code_failures WHERE id = ?1').bind(id).run();
  }
}
