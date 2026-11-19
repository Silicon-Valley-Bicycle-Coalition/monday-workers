// Which addresses a person has proved they control by entering a code sent there.
export interface VerifiedEmailStore {
  recordVerified(emailHash: string, personItemIds: string[], atISO: string): Promise<void>;
  // Every verified (address, person) pair for these people, as `${emailHash}:${personItemId}`.
  verifiedFor(personItemIds: string[]): Promise<Set<string>>;
}

export class D1VerifiedEmailStore implements VerifiedEmailStore {
  constructor(private db: D1Database) {}

  async recordVerified(emailHash: string, personItemIds: string[], atISO: string): Promise<void> {
    if (personItemIds.length === 0) return;
    await this.db.batch(
      personItemIds.map((personItemId) =>
        this.db
          .prepare(
            `INSERT INTO verified_emails (email_hash, person_item_id, first_verified_at, last_verified_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(email_hash, person_item_id) DO UPDATE SET last_verified_at = excluded.last_verified_at`
          )
          .bind(emailHash, personItemId, atISO)
      )
    );
  }

  async verifiedFor(personItemIds: string[]): Promise<Set<string>> {
    if (personItemIds.length === 0) return new Set();
    const placeholders = personItemIds.map((_, i) => `?${i + 1}`).join(', ');
    const { results } = await this.db
      .prepare(`SELECT email_hash, person_item_id FROM verified_emails WHERE person_item_id IN (${placeholders})`)
      .bind(...personItemIds)
      .all<{ email_hash: string; person_item_id: string }>();
    return new Set(results.map((row) => `${row.email_hash}:${row.person_item_id}`));
  }
}
