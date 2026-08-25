export interface CardTokenStore {
  createToken(donorItemId: string, token: string, createdAtISO: string): Promise<void>;
  findActiveDonorId(token: string): Promise<string | null>;
  getActiveToken(donorItemId: string): Promise<string | null>;
  revokeAllForDonor(donorItemId: string, revokedAtISO: string): Promise<void>;
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
         ORDER BY created_at DESC LIMIT 1`
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
}
