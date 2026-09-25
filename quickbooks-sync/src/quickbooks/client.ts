import type { EntityType } from '../types';
import type { QbTokens, StoredQbTokens, TokenStore } from './tokenStore';

export interface QuickBooksClient {
  getEntity(entityType: EntityType, qbId: string): Promise<Record<string, unknown>>;
  // requestId is sent as Intuit's `requestid` query parameter: a repeat of the same id returns the
  // original response instead of creating a second Customer. Derive it from the triggering event
  // so every retry of that event reuses it.
  createCustomer(fields: Record<string, unknown>, requestId: string): Promise<{ id: string }>;
}

const QB_ENTITY_PATH: Record<EntityType, string> = {
  customer: 'customer',
  invoice: 'invoice',
  product: 'item',
};

const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

let sinkLogged = false;

interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface QuickBooksClientOptions {
  // Injected for tests; defaults to a real timer. Waiting costs wall time, not CPU time.
  sleep?: (ms: number) => Promise<void>;
}

// Refresh the access token this long before it expires.
const EXPIRY_SKEW_MS = 60_000;
// How long a refresher may hold the lease: far longer than one token-endpoint round trip, short
// enough that a refresher that died mid-refresh doesn't block the next one for long.
const REFRESH_LEASE_TTL_MS = 30_000;
// A caller that finds another refresher holding the lease re-reads D1 this many times, this far
// apart, before giving up with a (queue-retryable) error.
const LEASE_WAIT_ATTEMPTS = 5;
const LEASE_WAIT_MS = 500;

type AccessToken = { realmId: string; accessToken: string };

function isFresh(tokens: QbTokens): boolean {
  return new Date(tokens.accessTokenExpiresAt).getTime() > Date.now() + EXPIRY_SKEW_MS;
}

// Token refresh has exactly one writer at a time (#33). Intuit rotates the refresh token and
// expires the previous one, so two callers refreshing from the same stored token and saving
// last-writer-wins could leave D1 holding a token Intuit has already invalidated — and every call
// after that fails until the pair is re-seeded by hand. So:
//   1. a caller that finds the access token stale takes a D1 lease at the version it read
//      (acquireRefreshLease — one atomic UPDATE, so one winner);
//   2. the lease holder calls Intuit and saves by compare-and-swap on that version
//      (saveRefreshedTokens), which also clears the lease;
//   3. everyone else waits briefly and re-reads D1, picking up the holder's new token;
//   4. on invalid_grant the holder re-reads D1 — if someone saved a newer pair (a re-seed, or a
//      writer whose lease expired), use it; otherwise fail loudly with the re-seed instruction.
// A Durable Object would serialize this too, but would add a binding, a DO migration and a class
// to both environments for a code path that — now that only the queue consumer (max_concurrency
// 1) calls QuickBooks — is rarely contended; the D1 row already exists and a lease on it suffices.
export class HttpQuickBooksClient implements QuickBooksClient {
  private sleep: (ms: number) => Promise<void>;

  constructor(
    private tokenStore: TokenStore,
    private clientId: string,
    private clientSecret: string,
    private apiBaseUrl: string,
    options: QuickBooksClientOptions = {}
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async getValidAccessToken(): Promise<AccessToken> {
    let lastSeenVersion: number | null = null;
    for (let attempt = 0; attempt <= LEASE_WAIT_ATTEMPTS; attempt++) {
      const tokens = await this.tokenStore.getTokens();
      if (tokens === null) {
        throw new Error('quickbooks: no OAuth tokens stored — run the initial authorization handshake first');
      }
      if (isFresh(tokens)) {
        return { realmId: tokens.realmId, accessToken: tokens.accessToken };
      }
      // Already failed with invalid_grant at this version and nothing newer has landed.
      if (lastSeenVersion === tokens.version) break;

      const leaseToken = crypto.randomUUID();
      if (await this.tokenStore.acquireRefreshLease(tokens.version, leaseToken, new Date(), REFRESH_LEASE_TTL_MS)) {
        const refreshed = await this.refreshUnderLease(tokens, leaseToken);
        if (refreshed !== 'invalid_grant') return refreshed;
        // Re-read immediately: a newer pair may already be in D1.
        lastSeenVersion = tokens.version;
        continue;
      }
      if (attempt < LEASE_WAIT_ATTEMPTS) await this.sleep(LEASE_WAIT_MS);
    }
    if (lastSeenVersion !== null) {
      throw new Error(
        'quickbooks oauth refresh: invalid_grant — the stored refresh token was rejected and no newer one is in D1; ' +
          're-seed the token pair via the OAuth Playground (README "OAuth tokens")'
      );
    }
    throw new Error('quickbooks oauth refresh: another refresh is still in progress; retry later');
  }

  private async refreshUnderLease(tokens: StoredQbTokens, leaseToken: string): Promise<AccessToken | 'invalid_grant'> {
    let json: RefreshResponse;
    try {
      const basicAuth = btoa(`${this.clientId}:${this.clientSecret}`);
      const response = await fetch(QB_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'invalid_grant') {
          await this.tokenStore.releaseRefreshLease(leaseToken);
          return 'invalid_grant';
        }
        throw new Error(`quickbooks oauth refresh: HTTP ${response.status}`); // lease released below
      }
      json = (await response.json()) as RefreshResponse;
    } catch (err) {
      await this.tokenStore.releaseRefreshLease(leaseToken).catch(() => {});
      throw err;
    }

    const refreshedTokens: QbTokens = {
      realmId: tokens.realmId,
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      accessTokenExpiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    };
    // Lockout risk that no lease can remove: Intuit may have expired the previous refresh token
    // by now. If this D1 write throws, the new pair exists nowhere else and the pair must be
    // re-seeded by hand via Intuit's OAuth Playground.
    const saved = await this.tokenStore.saveRefreshedTokens(refreshedTokens, tokens.version, leaseToken);
    if (!saved) {
      // Our lease expired and another writer saved first. Which refresh token Intuit still honors
      // is unknowable from here, so don't overwrite theirs; this call can still use its fresh
      // access token. If theirs turns out to be the invalidated one, the next refresh hits
      // invalid_grant and says to re-seed.
      console.error(
        `quickbooks oauth refresh: compare-and-swap lost at version ${tokens.version} (lease expired mid-refresh) — kept the newer stored token`
      );
    }
    return { realmId: refreshedTokens.realmId, accessToken: refreshedTokens.accessToken };
  }

  async getEntity(entityType: EntityType, qbId: string): Promise<Record<string, unknown>> {
    const { realmId, accessToken } = await this.getValidAccessToken();
    const path = QB_ENTITY_PATH[entityType];
    const response = await fetch(`${this.apiBaseUrl}/${realmId}/${path}/${qbId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`quickbooks API: HTTP ${response.status} fetching ${entityType} ${qbId}`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const entityKey = path.charAt(0).toUpperCase() + path.slice(1);
    return json[entityKey] as Record<string, unknown>;
  }

  async createCustomer(fields: Record<string, unknown>, requestId: string): Promise<{ id: string }> {
    if (!sinkLogged) {
      sinkLogged = true;
      // Design doc §6: one line per isolate naming the sink this deployment writes to.
      console.log(JSON.stringify({ sandboxOutbound: 'quickbooks', apiBaseUrl: this.apiBaseUrl }));
    }
    const { realmId, accessToken } = await this.getValidAccessToken();
    const response = await fetch(`${this.apiBaseUrl}/${realmId}/customer?requestid=${encodeURIComponent(requestId)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(fields),
    });
    if (!response.ok) {
      throw new Error(`quickbooks API: HTTP ${response.status} creating customer`);
    }
    const json = (await response.json()) as { Customer: { Id: string } };
    return { id: json.Customer.Id };
  }
}
