import { APPS, type AppKey } from './apps';
import type { Env } from './env';
import { refresh, RefreshRejectedError, type FetchFn } from './mondayOAuth';
import type { D1AppTokenStore, StoredAppToken } from './tokenStore';

// Refresh once fewer than this many ms remain, so no consumer is handed a token about to expire.
export const REFRESH_MARGIN_MS = 10 * 60_000;
// Long enough to cover one token-endpoint call (10 s timeout) plus the D1 write.
export const LEASE_TTL_MS = 30_000;
// A caller that loses the lease re-reads this many times, this far apart, waiting for the
// winner's new version to land.
const LEASE_WAIT_ATTEMPTS = 10;
const LEASE_WAIT_MS = 300;

export interface TokenBrokerDeps {
  store: D1AppTokenStore;
  env: Env;
  fetchFn: FetchFn;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  alert: (text: string) => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Hands out a valid Monday access token per app, refreshing under a single-refresher lease.
// Monday rotates the refresh token on every refresh, so exactly one caller may refresh a given
// version; everyone else waits for that caller's write and uses its result.
//
// No error message, alert or log line here includes a token: they name the app and the failure.
export class TokenBroker {
  private deps: TokenBrokerDeps;

  constructor(deps: TokenBrokerDeps) {
    this.deps = deps;
  }

  // `rejected` is a token a consumer just got a 401 with. If it is still the stored one, refresh
  // now even though it isn't near expiry; if the store already moved past it, hand out the newer
  // one without calling Monday.
  async token(app: AppKey, rejected?: string): Promise<string> {
    const row = await this.readUsable(app);
    if (rejected !== undefined && rejected !== row.accessToken) return row.accessToken;
    const forced = rejected !== undefined;
    if (!forced && this.isFresh(row)) return row.accessToken;

    const leaseToken = crypto.randomUUID();
    if (await this.deps.store.acquireRefreshLease(app, row.version, leaseToken, this.deps.now(), LEASE_TTL_MS)) {
      return this.refreshUnderLease(row, leaseToken);
    }

    // Lost the lease (or the version moved before we tried): wait for the winner's write.
    for (let attempt = 0; attempt < LEASE_WAIT_ATTEMPTS; attempt++) {
      await this.deps.sleep(LEASE_WAIT_MS);
      // Throws "needs consent" if the winner hit invalid_grant.
      const next = await this.readUsable(app);
      if (next.version !== row.version) return next.accessToken;
    }
    throw new Error(`monday-auth: a refresh of the ${app} app is still in progress; retry later`);
  }

  // For the cron: refresh every app inside the margin so consumers rarely wait on a refresh.
  // Apps are independent — one failing doesn't stop the others — and an app that is missing or
  // needs consent is skipped (its state is already alerted / visible on the status page).
  async refreshAllIfDue(): Promise<void> {
    for (const app of Object.keys(APPS) as AppKey[]) {
      try {
        const row = await this.deps.store.get(app);
        if (row === null || row.status !== 'ok' || this.isFresh(row)) continue;
        await this.token(app);
      } catch (err) {
        console.error(`monday-auth: scheduled refresh of the ${app} app failed: ${errorMessage(err)}`);
      }
    }
  }

  private async readUsable(app: AppKey): Promise<StoredAppToken> {
    const row = await this.deps.store.get(app);
    if (row === null) {
      throw new Error(`monday-auth: the ${app} app is not authorized yet; run its consent flow`);
    }
    if (row.status === 'needs_consent') {
      throw new Error(`monday-auth: the ${app} app needs consent; its refresh token was rejected, re-run its consent flow`);
    }
    return row;
  }

  private isFresh(row: StoredAppToken): boolean {
    // An unparseable expiry gives NaN, which is never fresh: refresh rather than trust it.
    return Date.parse(row.accessTokenExpiresAt) - this.deps.now().getTime() > REFRESH_MARGIN_MS;
  }

  private credentials(app: AppKey): { clientId: string; clientSecret: string } {
    const vars = this.deps.env as unknown as Record<string, string | undefined>;
    const clientId = vars[APPS[app].clientIdVar];
    const clientSecret = vars[APPS[app].clientSecretVar];
    if (!clientId || !clientSecret) {
      throw new Error(`monday-auth: ${APPS[app].clientIdVar} / ${APPS[app].clientSecretVar} are not configured`);
    }
    return { clientId, clientSecret };
  }

  private async refreshUnderLease(row: StoredAppToken, leaseToken: string): Promise<string> {
    const { app } = row;
    const { store } = this.deps;
    let fresh;
    try {
      fresh = await refresh({ ...this.credentials(app), refreshToken: row.refreshToken }, this.deps.fetchFn, this.deps.now);
    } catch (err) {
      if (err instanceof RefreshRejectedError) {
        // Mark before releasing, so a waiting caller re-reads needs_consent instead of taking the
        // freed lease and spending another call on the dead refresh token.
        let changed = false;
        try {
          changed = await store.markNeedsConsent(app);
        } finally {
          await store.releaseRefreshLease(app, leaseToken).catch(() => {});
        }
        if (changed) {
          await this.deps
            .alert(
              `[${this.deps.env.ENVIRONMENT}] the ${app} app needs consent: Monday rejected its refresh token ` +
                `(invalid_grant). Consumers using it fail until its consent flow is re-run.`
            )
            .catch(() => {});
        }
        throw new Error(`monday-auth: the ${app} app needs consent; its refresh token was rejected, re-run its consent flow`);
      }
      // Network / 5xx / config: retryable. Free the lease so the next caller can try at once.
      await store.releaseRefreshLease(app, leaseToken).catch(() => {});
      throw new Error(`monday-auth: refresh of the ${app} app failed (retryable): ${errorMessage(err)}`);
    }

    // Lockout risk no lease removes: Monday has already retired the old refresh token. If this
    // write throws, the new pair exists nowhere else and the app needs a new consent.
    const saved = await store.saveRefreshed(
      app,
      { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, accessTokenExpiresAt: fresh.expiresAt },
      row.version,
      leaseToken
    );
    if (!saved) {
      // Our lease expired mid-refresh and another writer saved first. Keep theirs; this caller
      // can still use its own fresh access token.
      console.error(
        `monday-auth: compare-and-swap lost for the ${app} app at version ${row.version} (lease expired mid-refresh); kept the newer stored token`
      );
    }
    return fresh.accessToken;
  }
}
