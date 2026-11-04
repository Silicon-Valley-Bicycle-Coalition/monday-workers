import { APPS, type AppKey } from './apps';
import type { Env } from './env';
import { ClientRejectedError, refresh, RefreshRejectedError, type FetchFn } from './mondayOAuth';
import type { D1AppTokenStore, StoredAppToken } from './tokenStore';

// On-demand: refresh once fewer than this many ms remain, so no consumer is handed a token
// about to expire.
export const REFRESH_MARGIN_MS = 10 * 60_000;
// Cron: start refreshing this long before expiry. Monday's access tokens last about 24 h, so this
// costs one extra rotation every few days, and buys hours of retries (every 30 minutes) before a
// failing refresh lets the stored token expire. It is also well over the 30-minute cron plus the
// 10-minute margin, so consumers rarely wait on a refresh.
export const CRON_REFRESH_WINDOW_MS = 8 * 60 * 60_000;
// Cron: once refreshes have kept failing (anything but invalid_grant) and less than this is left
// on the stored token, alert once for that run of failures. The stored token is still handed out
// meanwhile, so this is the time a human has before every consumer of the app fails.
export const REFRESH_FAILING_ALERT_MS = 6 * 60 * 60_000;
// Long enough to cover one token-endpoint call (10 s timeout) plus the D1 write.
export const LEASE_TTL_MS = 30_000;
// A caller that loses the lease polls this many times, this far apart: it returns as soon as the
// winner's new version lands, or takes the lease itself once the winner has released it.
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

// A refresh failed for a reason other than invalid_grant (network, 5xx, malformed response, or a
// rejected client, which also alerts).
class TransientRefreshError extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Hands out a valid Monday access token per app, refreshing under a single-refresher lease.
// Monday rotates the refresh token on every refresh, so exactly one caller may refresh a given
// version; everyone else waits for that caller's write and uses its result.
//
// No error message, alert or log line here includes a token or client secret: they name the app
// and the failure.
export class TokenBroker {
  private deps: TokenBrokerDeps;

  constructor(deps: TokenBrokerDeps) {
    this.deps = deps;
  }

  // `rejected` is a token a consumer just got a 401 with. If it is still the stored one, refresh
  // now even though it isn't near expiry; if the store already moved past it, hand out the newer
  // one without calling Monday.
  async token(app: AppKey, rejected?: string): Promise<string> {
    return this.obtain(app, rejected, REFRESH_MARGIN_MS);
  }

  // For the cron: refresh every app within CRON_REFRESH_WINDOW_MS of expiry. Apps are
  // independent — one failing doesn't stop the others — and an app that is missing or needs
  // consent is skipped (its state was already alerted on). Rejects at the end, naming every app
  // whose refresh failed, so the cron invocation shows as failed rather than passing silently;
  // that includes a failure obtain() papered over by handing out the still-valid stored token.
  async refreshAllIfDue(): Promise<void> {
    const failed: AppKey[] = [];
    for (const app of Object.keys(APPS) as AppKey[]) {
      try {
        const row = await this.deps.store.get(app);
        if (row === null || row.status !== 'ok' || this.remainingMs(row) > CRON_REFRESH_WINDOW_MS) continue;
        try {
          await this.obtain(app, undefined, CRON_REFRESH_WINDOW_MS);
        } catch (err) {
          console.error(`monday-auth: scheduled refresh of the ${app} app failed: ${errorMessage(err)}`);
        }
        if (await this.alertIfFailingNearExpiry(app)) failed.push(app);
      } catch (err) {
        console.error(`monday-auth: scheduled refresh of the ${app} app failed: ${errorMessage(err)}`);
        failed.push(app);
      }
    }
    if (failed.length > 0) throw new Error(`monday-auth: scheduled refresh failed for: ${failed.join(', ')}`);
  }

  // After the cron's refresh attempt: true if the app is in a run of failed refreshes. Alerts
  // once per run, when under REFRESH_FAILING_ALERT_MS is left on the stored token.
  private async alertIfFailingNearExpiry(app: AppKey): Promise<boolean> {
    const row = await this.deps.store.get(app);
    if (row === null || row.status !== 'ok' || row.refreshFailingSince === null) return false;
    // `!(x >= limit)` also catches an unparseable expiry (NaN).
    if (!(this.remainingMs(row) >= REFRESH_FAILING_ALERT_MS) && (await this.deps.store.markRefreshErrorAlerted(app, row.version, this.deps.now()))) {
      await this.deps
        .alert(
          `[${this.deps.env.ENVIRONMENT}] the ${app} app's token refresh keeps failing (since ${row.refreshFailingSince}, ` +
            `last at ${row.lastRefreshErrorAt}). Its stored token expires at ${row.accessTokenExpiresAt}; after that every ` +
            `consumer of the app fails. Check the broker's logs for the cause (Monday outage, network) and /health.`
        )
        .catch(() => {});
    }
    return true;
  }

  private async obtain(app: AppKey, rejected: string | undefined, marginMs: number): Promise<string> {
    const row = await this.readUsable(app);
    if (rejected !== undefined && rejected !== row.accessToken) return row.accessToken;
    const forced = rejected !== undefined;
    if (!forced && this.remainingMs(row) > marginMs) return row.accessToken;

    // Config errors are not retryable and must not take the lease or call Monday.
    const credentials = this.credentials(app);

    for (let attempt = 0; attempt <= LEASE_WAIT_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await this.deps.sleep(LEASE_WAIT_MS);
        // Throws "needs consent" if the refresher hit invalid_grant.
        const next = await this.readUsable(app);
        if (next.version !== row.version) return next.accessToken;
      }
      // Fails while another caller holds an unexpired lease; succeeds once it is released or
      // lapses (a refresher that failed transiently, or died), so this caller takes over.
      const leaseToken = crypto.randomUUID();
      if (await this.deps.store.acquireRefreshLease(app, row.version, leaseToken, this.deps.now(), LEASE_TTL_MS)) {
        try {
          return await this.refreshUnderLease(row, leaseToken, credentials);
        } catch (err) {
          if (!(err instanceof TransientRefreshError)) throw err;
          return this.fallBackOrThrow(row, forced, err.message);
        }
      }
    }
    return this.fallBackOrThrow(
      row,
      forced,
      `monday-auth: another caller has held the refresh lease for the ${app} app throughout the wait ` +
        '(a refresh still running, or a refresher that died before releasing it); retry later'
    );
  }

  // A transient refresh failure must not fail a consumer while the stored token still works:
  // unless the consumer just had it rejected (forced) or it has expired, log and hand it out.
  private fallBackOrThrow(row: StoredAppToken, forced: boolean, message: string): string {
    if (!forced && this.remainingMs(row) > 0) {
      console.error(`${message} (handing out the stored ${row.app} token, valid until ${row.accessTokenExpiresAt})`);
      return row.accessToken;
    }
    throw new Error(message);
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

  // NaN for an unparseable expiry, which compares false everywhere: never fresh, never valid.
  private remainingMs(row: StoredAppToken): number {
    return Date.parse(row.accessTokenExpiresAt) - this.deps.now().getTime();
  }

  private credentials(app: AppKey): { clientId: string; clientSecret: string } {
    const vars = this.deps.env as unknown as Record<string, string | undefined>;
    const { clientIdVar, clientSecretVar } = APPS[app];
    const clientId = vars[clientIdVar];
    if (!clientId) throw new Error(`monday-auth: ${clientIdVar} is not set`);
    const clientSecret = vars[clientSecretVar];
    if (!clientSecret) throw new Error(`monday-auth: ${clientSecretVar} is not set`);
    return { clientId, clientSecret };
  }

  private async refreshUnderLease(
    row: StoredAppToken,
    leaseToken: string,
    credentials: { clientId: string; clientSecret: string }
  ): Promise<string> {
    const { app } = row;
    const { store } = this.deps;
    let fresh;
    try {
      fresh = await refresh({ ...credentials, refreshToken: row.refreshToken }, this.deps.fetchFn, this.deps.now);
    } catch (err) {
      if (err instanceof RefreshRejectedError) {
        // Mark before releasing, so a waiting caller re-reads needs_consent instead of taking the
        // freed lease and spending another call on the dead refresh token. Version-gated, so a
        // stale invalid_grant can't mark a row that was re-consented meanwhile.
        let changed = false;
        try {
          changed = await store.markNeedsConsent(app, row.version);
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
      // Everything else (network, 5xx, malformed response, a rejected client): retryable as far as
      // consumers go, since the stored token may still work. Record it for the cron's alert and
      // /health, then free the lease so the next caller can try. The record is best effort: a D1
      // failure here must not replace the refresh error.
      const now = this.deps.now();
      await store.recordRefreshError(app, row.version, now).catch(() => {});
      await store.releaseRefreshLease(app, leaseToken).catch(() => {});
      if (err instanceof ClientRejectedError) {
        // No retry fixes these, so alert now rather than waiting for the cron's near-expiry alert
        // (once per run of failures: the same flag that alert uses).
        if (await store.markRefreshErrorAlerted(app, row.version, now).catch(() => false)) {
          const { clientIdVar, clientSecretVar } = APPS[app];
          await this.deps
            .alert(
              `[${this.deps.env.ENVIRONMENT}] Monday rejected the ${app} app's client credentials (${err.code}). ` +
                `Check that ${clientIdVar} and ${clientSecretVar} in Cloudflare match the app in the Developer Center ` +
                `and that the app is still installed (re-run its consent flow if not). The stored token is handed ` +
                `out until it expires at ${row.accessTokenExpiresAt}.`
            )
            .catch(() => {});
        }
      }
      throw new TransientRefreshError(`monday-auth: refresh of the ${app} app failed (retryable): ${errorMessage(err)}`);
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
      console.error(
        `monday-auth: compare-and-swap lost for the ${app} app at version ${row.version}: this caller's lease ` +
          'lapsed mid-refresh and another caller took over at the same version and saved first. This ' +
          "caller's refreshed pair is discarded (its access token is still returned to this one request); " +
          'if Monday honours only the discarded refresh token, the next refresh gets invalid_grant.'
      );
    }
    return fresh.accessToken;
  }
}
