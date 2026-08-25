export interface CardTokenStore {
  createToken(donorItemId: string, token: string, createdAtISO: string): Promise<void>;
  findActiveDonorId(token: string): Promise<string | null>;
  getActiveToken(donorItemId: string): Promise<string | null>;
  revokeAllForDonor(donorItemId: string, revokedAtISO: string): Promise<void>;
  // Retention purge: a revoked row is a dead bearer credential with no purpose once superseded —
  // it stops resolving via findActiveDonorId/getActiveToken the moment revoked_at is set (see
  // revokeAllForDonor) and never becomes active again. Rows past the retention window are deleted
  // outright rather than field-scrubbed. Active rows (revoked_at IS NULL) are never touched.
  // Returns the number of rows deleted.
  purgeRevokedBefore(cutoffISO: string): Promise<number>;
}

export class D1CardTokenStore implements CardTokenStore {
  constructor(private db: D1Database) {}

  async createToken(donorItemId: string, token: string, createdAtISO: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO card_tokens (donor_item_id, token, created_at) VALUES (?1, ?2, ?3)`)
      .bind(donorItemId, token, createdAtISO)
      .run();
  }

  async findActiveDonorId(token: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT donor_item_id FROM card_tokens WHERE token = ?1 AND revoked_at IS NULL`)
      .bind(token)
      .first<{ donor_item_id: string }>();
    return row === null ? null : row.donor_item_id;
  }

  async getActiveToken(donorItemId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT token FROM card_tokens WHERE donor_item_id = ?1 AND revoked_at IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .bind(donorItemId)
      .first<{ token: string }>();
    return row === null ? null : row.token;
  }

  async revokeAllForDonor(donorItemId: string, revokedAtISO: string): Promise<void> {
    await this.db
      .prepare(`UPDATE card_tokens SET revoked_at = ?1 WHERE donor_item_id = ?2 AND revoked_at IS NULL`)
      .bind(revokedAtISO, donorItemId)
      .run();
  }

  async purgeRevokedBefore(cutoffISO: string): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM card_tokens WHERE revoked_at IS NOT NULL AND revoked_at < ?1`)
      .bind(cutoffISO)
      .run();
    return result.meta.changes;
  }
}
