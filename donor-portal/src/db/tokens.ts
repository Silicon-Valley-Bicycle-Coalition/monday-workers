export interface NewMagicLinkToken {
  tokenHash: string;
  donorItemIds: string[];
  expiresAt: string;
}

export interface MagicLinkTokenStore {
  createToken(params: NewMagicLinkToken): Promise<void>;
  consumeToken(tokenHash: string, nowISO: string): Promise<string[] | null>;
}

export class D1MagicLinkTokenStore implements MagicLinkTokenStore {
  constructor(private db: D1Database) {}

  async createToken(params: NewMagicLinkToken): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO magic_link_tokens (token_hash, donor_item_ids, expires_at)
         VALUES (?1, ?2, ?3)`
      )
      .bind(params.tokenHash, JSON.stringify(params.donorItemIds), params.expiresAt)
      .run();
  }

  async consumeToken(tokenHash: string, nowISO: string): Promise<string[] | null> {
    const claim = await this.db
      .prepare(
        `UPDATE magic_link_tokens SET used_at = ?2
         WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2`
      )
      .bind(tokenHash, nowISO)
      .run();

    if (claim.meta.changes === 0) {
      return null;
    }

    const row = await this.db
      .prepare(`SELECT donor_item_ids FROM magic_link_tokens WHERE token_hash = ?1`)
      .bind(tokenHash)
      .first<{ donor_item_ids: string }>();

    return row === null ? null : (JSON.parse(row.donor_item_ids) as string[]);
  }
}
