import { TokenCipher } from './tokenCipher';

export interface QbTokens {
  realmId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}

// A stored token row plus its compare-and-swap version (migration 0003).
export interface StoredQbTokens extends QbTokens {
  version: number;
}

export interface TokenStore {
  getTokens(): Promise<StoredQbTokens | null>;
  // Seeds or replaces the token pair outright (bumps the version, clears any lease). For the
  // initial handshake and manual re-seeds; the refresh path uses the lease + CAS methods below.
  saveTokens(tokens: QbTokens): Promise<void>;
  // Takes the single-refresher lease, only if the row is still at `version` and no unexpired
  // lease is held. True when this caller now holds it.
  acquireRefreshLease(version: number, leaseToken: string, now: Date, ttlMs: number): Promise<boolean>;
  // Compare-and-swap: writes the refreshed pair only if the row is still at `expectedVersion` and
  // `leaseToken` still holds the lease; bumps the version and clears the lease. True on success.
  saveRefreshedTokens(tokens: QbTokens, expectedVersion: number, leaseToken: string): Promise<boolean>;
  // Drops the lease if `leaseToken` holds it (a failed refresh), so the next caller needn't wait
  // for it to expire.
  releaseRefreshLease(leaseToken: string): Promise<void>;
}

interface D1TokenRecord {
  realm_id: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
  version: number;
}

export class D1TokenStore implements TokenStore {
  private cipher: Promise<TokenCipher> | null = null;

  constructor(
    private db: D1Database,
    private encryptionKey: string | undefined
  ) {}

  private loadCipher(): Promise<TokenCipher> {
    this.cipher ??= TokenCipher.load(this.encryptionKey);
    return this.cipher;
  }

  // Needs no key, so the webhook route can check the connected company without ever holding a
  // decrypted token.
  async getRealmId(): Promise<string | null> {
    const record = await this.db.prepare('SELECT realm_id FROM qb_oauth_tokens WHERE id = 1').first<{ realm_id: string }>();
    return record?.realm_id ?? null;
  }

  // Loads the key before anything else, even for a row that is still plaintext. Every refresh starts
  // here, and it must fail now rather than at the save: by then Intuit may have rotated the refresh
  // token, and a pair that can't be saved is lost.
  async getTokens(): Promise<StoredQbTokens | null> {
    const cipher = await this.loadCipher();
    const record = await this.db
      .prepare(
        'SELECT realm_id, access_token, refresh_token, access_token_expires_at, version FROM qb_oauth_tokens WHERE id = 1'
      )
      .first<D1TokenRecord>();
    if (record === null) return null;
    return {
      realmId: record.realm_id,
      accessToken: await cipher.decrypt(record.access_token, 'access_token'),
      refreshToken: await cipher.decrypt(record.refresh_token, 'refresh_token'),
      accessTokenExpiresAt: record.access_token_expires_at,
      version: record.version,
    };
  }

  async saveTokens(tokens: QbTokens): Promise<void> {
    const cipher = await this.loadCipher();
    const accessToken = await cipher.encrypt(tokens.accessToken, 'access_token');
    const refreshToken = await cipher.encrypt(tokens.refreshToken, 'refresh_token');
    await this.db
      .prepare(
        `INSERT INTO qb_oauth_tokens (id, realm_id, access_token, refresh_token, access_token_expires_at, updated_at, version)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, 1)
         ON CONFLICT (id) DO UPDATE SET
           realm_id = excluded.realm_id,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           access_token_expires_at = excluded.access_token_expires_at,
           updated_at = excluded.updated_at,
           version = qb_oauth_tokens.version + 1,
           refresh_lease_token = NULL,
           refresh_lease_until = NULL`
      )
      .bind(tokens.realmId, accessToken, refreshToken, tokens.accessTokenExpiresAt, new Date().toISOString())
      .run();
  }

  async acquireRefreshLease(version: number, leaseToken: string, now: Date, ttlMs: number): Promise<boolean> {
    // One statement, so D1 serializes it: exactly one caller's UPDATE matches.
    const result = await this.db
      .prepare(
        `UPDATE qb_oauth_tokens SET refresh_lease_token = ?1, refresh_lease_until = ?2
         WHERE id = 1 AND version = ?3 AND (refresh_lease_until IS NULL OR refresh_lease_until <= ?4)`
      )
      .bind(leaseToken, new Date(now.getTime() + ttlMs).toISOString(), version, now.toISOString())
      .run();
    return result.meta.changes === 1;
  }

  async saveRefreshedTokens(tokens: QbTokens, expectedVersion: number, leaseToken: string): Promise<boolean> {
    const cipher = await this.loadCipher();
    const accessToken = await cipher.encrypt(tokens.accessToken, 'access_token');
    const refreshToken = await cipher.encrypt(tokens.refreshToken, 'refresh_token');
    const result = await this.db
      .prepare(
        `UPDATE qb_oauth_tokens SET
           access_token = ?1,
           refresh_token = ?2,
           access_token_expires_at = ?3,
           updated_at = ?4,
           version = version + 1,
           refresh_lease_token = NULL,
           refresh_lease_until = NULL
         WHERE id = 1 AND version = ?5 AND refresh_lease_token = ?6`
      )
      .bind(accessToken, refreshToken, tokens.accessTokenExpiresAt, new Date().toISOString(), expectedVersion, leaseToken)
      .run();
    return result.meta.changes === 1;
  }

  async releaseRefreshLease(leaseToken: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE qb_oauth_tokens SET refresh_lease_token = NULL, refresh_lease_until = NULL
         WHERE id = 1 AND refresh_lease_token = ?1`
      )
      .bind(leaseToken)
      .run();
  }
}
