import type { AppKey } from './apps';

export interface StoredAppToken {
  app: AppKey;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  authorizedUserId: string;
  status: 'ok' | 'needs_consent';
  version: number;
  // Refresh-failure state (migration 0003): all null while refreshes succeed.
  lastRefreshErrorAt: string | null;
  refreshFailingSince: string | null;
  refreshErrorAlertedAt: string | null;
}

// What save() takes: the token pair and who consented. Version, status and the error state are
// the store's to set.
export type NewAppToken = Omit<StoredAppToken, 'version' | 'status' | 'lastRefreshErrorAt' | 'refreshFailingSince' | 'refreshErrorAlertedAt'>;

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}

// A consent flow older than this is abandoned; its verifier is no longer honoured.
const PENDING_TTL_MS = 10 * 60 * 1000;

interface TokenRow {
  app: AppKey;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
  authorized_user_id: string;
  status: 'ok' | 'needs_consent';
  version: number;
  last_refresh_error_at: string | null;
  refresh_failing_since: string | null;
  refresh_error_alerted_at: string | null;
}

// Clears the refresh-failure state; shared by save() and saveRefreshed().
const CLEAR_REFRESH_ERROR = 'refresh_failing_since = NULL, last_refresh_error_at = NULL, refresh_error_alerted_at = NULL';

// D1-backed token rows, one per app, with a single-refresher lease and compare-and-swap (a port
// of quickbooks-sync's D1TokenStore keyed by `app`). Monday rotates the refresh token on every
// refresh, so two concurrent refreshers must not both write.
export class D1AppTokenStore {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async get(app: AppKey): Promise<StoredAppToken | null> {
    const row = await this.db
      .prepare(
        `SELECT app, access_token, refresh_token, access_token_expires_at, authorized_user_id, status, version,
                last_refresh_error_at, refresh_failing_since, refresh_error_alerted_at
         FROM oauth_tokens WHERE app = ?1`
      )
      .bind(app)
      .first<TokenRow>();
    if (row === null) return null;
    return {
      app: row.app,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      accessTokenExpiresAt: row.access_token_expires_at,
      authorizedUserId: row.authorized_user_id,
      status: row.status,
      version: row.version,
      lastRefreshErrorAt: row.last_refresh_error_at,
      refreshFailingSince: row.refresh_failing_since,
      refreshErrorAlertedAt: row.refresh_error_alerted_at,
    };
  }

  // Seeds or replaces the pair outright (consent flow, manual re-seed): bumps the version, sets
  // status 'ok' and clears any lease and refresh-failure state.
  async save(token: NewAppToken): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO oauth_tokens (app, access_token, refresh_token, access_token_expires_at, authorized_user_id, status, version, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'ok', 1, ?6)
         ON CONFLICT (app) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           access_token_expires_at = excluded.access_token_expires_at,
           authorized_user_id = excluded.authorized_user_id,
           status = 'ok',
           updated_at = excluded.updated_at,
           version = oauth_tokens.version + 1,
           refresh_lease_token = NULL,
           refresh_lease_until = NULL,
           ${CLEAR_REFRESH_ERROR}`
      )
      .bind(
        token.app,
        token.accessToken,
        token.refreshToken,
        token.accessTokenExpiresAt,
        token.authorizedUserId,
        new Date().toISOString()
      )
      .run();
  }

  // Takes the refresher lease only if the row is still at `version` and no unexpired lease is
  // held. One statement, so D1 serializes it: exactly one caller's UPDATE matches.
  async acquireRefreshLease(app: AppKey, version: number, leaseToken: string, now: Date, ttlMs: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE oauth_tokens SET refresh_lease_token = ?1, refresh_lease_until = ?2
         WHERE app = ?3 AND version = ?4 AND (refresh_lease_until IS NULL OR refresh_lease_until <= ?5)`
      )
      .bind(leaseToken, new Date(now.getTime() + ttlMs).toISOString(), app, version, now.toISOString())
      .run();
    return result.meta.changes === 1;
  }

  // Compare-and-swap: writes only if the row is still at `expectedVersion` and `leaseToken`
  // still holds the lease; bumps the version and clears the lease and refresh-failure state.
  async saveRefreshed(app: AppKey, tokens: RefreshedTokens, expectedVersion: number, leaseToken: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE oauth_tokens SET
           access_token = ?1,
           refresh_token = ?2,
           access_token_expires_at = ?3,
           updated_at = ?4,
           version = version + 1,
           refresh_lease_token = NULL,
           refresh_lease_until = NULL,
           ${CLEAR_REFRESH_ERROR}
         WHERE app = ?5 AND version = ?6 AND refresh_lease_token = ?7`
      )
      .bind(tokens.accessToken, tokens.refreshToken, tokens.accessTokenExpiresAt, new Date().toISOString(), app, expectedVersion, leaseToken)
      .run();
    return result.meta.changes === 1;
  }

  async releaseRefreshLease(app: AppKey, leaseToken: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE oauth_tokens SET refresh_lease_token = NULL, refresh_lease_until = NULL
         WHERE app = ?1 AND refresh_lease_token = ?2`
      )
      .bind(app, leaseToken)
      .run();
  }

  // True only when this call changed the status from 'ok' to 'needs_consent', so the caller
  // alerts once per state change rather than once per failed request. Gated on the version the
  // caller refreshed from, so an invalid_grant for an old pair can't mark a freshly re-consented row.
  async markNeedsConsent(app: AppKey, expectedVersion: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE oauth_tokens SET status = 'needs_consent', updated_at = ?2 WHERE app = ?1 AND status = 'ok' AND version = ?3`
      )
      .bind(app, new Date().toISOString(), expectedVersion)
      .run();
    return result.meta.changes === 1;
  }

  // A refresh of the pair at `version` failed (anything but invalid_grant). Starts the failing
  // run if none is open and moves the last-error time. Version-gated, so a failure for a pair
  // that was replaced meanwhile records nothing.
  async recordRefreshError(app: AppKey, version: number, now: Date): Promise<void> {
    await this.db
      .prepare(
        `UPDATE oauth_tokens SET refresh_failing_since = COALESCE(refresh_failing_since, ?1), last_refresh_error_at = ?1
         WHERE app = ?2 AND version = ?3`
      )
      .bind(now.toISOString(), app, version)
      .run();
  }

  // True only for the call that marks the current failing run as alerted, so a caller alerts once
  // per run (the run ends with saveRefreshed or save). False when the row isn't failing, has
  // moved past `version`, or was already alerted.
  async markRefreshErrorAlerted(app: AppKey, version: number, now: Date): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE oauth_tokens SET refresh_error_alerted_at = ?1
         WHERE app = ?2 AND version = ?3 AND refresh_failing_since IS NOT NULL AND refresh_error_alerted_at IS NULL`
      )
      .bind(now.toISOString(), app, version)
      .run();
    return result.meta.changes === 1;
  }

  async putPending(state: string, app: AppKey, codeVerifier: string, redirectUri: string, now: Date): Promise<void> {
    await this.db
      .prepare('INSERT INTO oauth_pending (state, app, code_verifier, redirect_uri, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(state, app, codeVerifier, redirectUri, now.toISOString())
      .run();
  }

  // Single use: the row is deleted on read, even when it has expired (then returns null).
  async takePending(state: string, now: Date): Promise<{ app: AppKey; codeVerifier: string; redirectUri: string } | null> {
    const row = await this.db
      .prepare('DELETE FROM oauth_pending WHERE state = ?1 RETURNING app, code_verifier, redirect_uri, created_at')
      .bind(state)
      .first<{ app: AppKey; code_verifier: string; redirect_uri: string; created_at: string }>();
    if (row === null) return null;
    if (now.getTime() - new Date(row.created_at).getTime() > PENDING_TTL_MS) return null;
    return { app: row.app, codeVerifier: row.code_verifier, redirectUri: row.redirect_uri };
  }

  // Cron housekeeping: drops consent flows nobody finished. Same cutoff takePending honours
  // (older than the TTL is dead). Returns how many rows were removed.
  async purgeExpiredPending(now: Date): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM oauth_pending WHERE created_at < ?1')
      .bind(new Date(now.getTime() - PENDING_TTL_MS).toISOString())
      .run();
    return result.meta.changes;
  }
}
