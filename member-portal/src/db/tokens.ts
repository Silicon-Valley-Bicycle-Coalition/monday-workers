export interface NewMagicLinkToken {
  tokenHash: string;
  donorItemIds: string[];
  expiresAt: string;
  // Set on rows that carry a 6-digit code: every row one request created shares requestHash.
  requestHash?: string;
  codeHash?: string;
  emailHash?: string;
}

export interface ConsumedToken {
  donorItemIds: string[];
  emailHash: string | null;
}

export interface CodeAttempt {
  codeHash: string;
  emailHash: string;
}

export interface MagicLinkTokenStore {
  createToken(params: NewMagicLinkToken): Promise<void>;
  consumeToken(tokenHash: string, nowISO: string): Promise<ConsumedToken | null>;
  // Atomically counts one try against the row; null = nothing usable (expired, used, no code,
  // unknown, or already at maxAttempts).
  takeCodeAttempt(requestHash: string, nowISO: string, maxAttempts: number): Promise<CodeAttempt | null>;
  // Single-use claim of the row by request hash, for a correct code. null = nothing to claim.
  claimByRequest(requestHash: string, nowISO: string): Promise<ConsumedToken | null>;
}

interface ConsumedRow {
  donor_item_ids: string;
  email_hash: string | null;
}

function toConsumed(row: ConsumedRow): ConsumedToken {
  return { donorItemIds: JSON.parse(row.donor_item_ids) as string[], emailHash: row.email_hash };
}

export class D1MagicLinkTokenStore implements MagicLinkTokenStore {
  constructor(private db: D1Database) {}

  async createToken(params: NewMagicLinkToken): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO magic_link_tokens (token_hash, donor_item_ids, expires_at, request_hash, code_hash, email_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      )
      .bind(
        params.tokenHash,
        JSON.stringify(params.donorItemIds),
        params.expiresAt,
        params.requestHash ?? null,
        params.codeHash ?? null,
        params.emailHash ?? null
      )
      .run();
  }

  async consumeToken(tokenHash: string, nowISO: string): Promise<ConsumedToken | null> {
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
      .prepare(`SELECT donor_item_ids, email_hash FROM magic_link_tokens WHERE token_hash = ?1`)
      .bind(tokenHash)
      .first<ConsumedRow>();

    return row === null ? null : toConsumed(row);
  }

  async takeCodeAttempt(requestHash: string, nowISO: string, maxAttempts: number): Promise<CodeAttempt | null> {
    const row = await this.db
      .prepare(
        `UPDATE magic_link_tokens SET failed_code_attempts = failed_code_attempts + 1
         WHERE request_hash = ?1 AND used_at IS NULL AND expires_at > ?2
           AND failed_code_attempts < ?3 AND code_hash IS NOT NULL
         RETURNING code_hash, email_hash`
      )
      .bind(requestHash, nowISO, maxAttempts)
      .first<{ code_hash: string; email_hash: string }>();

    return row === null ? null : { codeHash: row.code_hash, emailHash: row.email_hash };
  }

  async claimByRequest(requestHash: string, nowISO: string): Promise<ConsumedToken | null> {
    const row = await this.db
      .prepare(
        `UPDATE magic_link_tokens SET used_at = ?2
         WHERE request_hash = ?1 AND used_at IS NULL AND expires_at > ?2
         RETURNING donor_item_ids, email_hash`
      )
      .bind(requestHash, nowISO)
      .first<ConsumedRow>();

    return row === null ? null : toConsumed(row);
  }
}
