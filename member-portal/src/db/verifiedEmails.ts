// Which addresses a person has proved they control by entering a code sent there.
export interface VerifiedEmailStore {
  recordVerified(emailHash: string, personItemIds: string[], atISO: string): Promise<void>;
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
}
