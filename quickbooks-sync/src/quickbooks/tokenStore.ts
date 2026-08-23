export interface QbTokens {
  realmId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}

export interface TokenStore {
  getTokens(): Promise<QbTokens | null>;
  saveTokens(tokens: QbTokens): Promise<void>;
}

interface D1TokenRecord {
  realm_id: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
}

export class D1TokenStore implements TokenStore {
  constructor(private db: D1Database) {}

  async getTokens(): Promise<QbTokens | null> {
    const record = await this.db
      .prepare(
        'SELECT realm_id, access_token, refresh_token, access_token_expires_at FROM qb_oauth_tokens WHERE id = 1'
      )
      .first<D1TokenRecord>();
    if (record === null) return null;
    return {
      realmId: record.realm_id,
      accessToken: record.access_token,
      refreshToken: record.refresh_token,
      accessTokenExpiresAt: record.access_token_expires_at,
    };
  }

  async saveTokens(tokens: QbTokens): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO qb_oauth_tokens (id, realm_id, access_token, refresh_token, access_token_expires_at, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET
           realm_id = excluded.realm_id,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           access_token_expires_at = excluded.access_token_expires_at,
           updated_at = excluded.updated_at`
      )
      .bind(tokens.realmId, tokens.accessToken, tokens.refreshToken, tokens.accessTokenExpiresAt, new Date().toISOString())
      .run();
  }
}
