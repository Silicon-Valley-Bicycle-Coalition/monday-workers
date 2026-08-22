import type { EntityType } from '../types';
import type { QbTokens, TokenStore } from './tokenStore';

export interface QuickBooksClient {
  getEntity(entityType: EntityType, qbId: string): Promise<Record<string, unknown>>;
  createCustomer(fields: Record<string, unknown>): Promise<{ id: string }>;
}

const QB_ENTITY_PATH: Record<EntityType, string> = {
  customer: 'customer',
  invoice: 'invoice',
  product: 'item',
};

const QB_API_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export class HttpQuickBooksClient implements QuickBooksClient {
  constructor(
    private tokenStore: TokenStore,
    private clientId: string,
    private clientSecret: string
  ) {}

  private async getValidAccessToken(): Promise<{ realmId: string; accessToken: string }> {
    const tokens = await this.tokenStore.getTokens();
    if (tokens === null) {
      throw new Error('quickbooks: no OAuth tokens stored — run the initial authorization handshake first');
    }
    if (new Date(tokens.accessTokenExpiresAt).getTime() > Date.now() + 60_000) {
      return { realmId: tokens.realmId, accessToken: tokens.accessToken };
    }
    const refreshed = await this.refresh(tokens);
    return { realmId: refreshed.realmId, accessToken: refreshed.accessToken };
  }

  private async refresh(tokens: QbTokens): Promise<QbTokens> {
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
      throw new Error(`quickbooks oauth refresh: HTTP ${response.status}`);
    }
    const json = (await response.json()) as RefreshResponse;
    const refreshedTokens: QbTokens = {
      realmId: tokens.realmId,
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      accessTokenExpiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    };
    // Lockout risk: Intuit has already invalidated the previous refresh token by this point. If
    // this D1 write fails, the Worker is left holding a refresh token that no longer works and
    // no copy of the new one — every later call fails until the token pair is re-seeded by hand
    // via Intuit's OAuth Playground (the same manual step described in the Task 15 provisioning
    // notes). There's no automatic recovery from this state.
    await this.tokenStore.saveTokens(refreshedTokens);
    return refreshedTokens;
  }

  async getEntity(entityType: EntityType, qbId: string): Promise<Record<string, unknown>> {
    const { realmId, accessToken } = await this.getValidAccessToken();
    const path = QB_ENTITY_PATH[entityType];
    const response = await fetch(`${QB_API_BASE}/${realmId}/${path}/${qbId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`quickbooks API: HTTP ${response.status} fetching ${entityType} ${qbId}`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const entityKey = path.charAt(0).toUpperCase() + path.slice(1);
    return json[entityKey] as Record<string, unknown>;
  }

  async createCustomer(fields: Record<string, unknown>): Promise<{ id: string }> {
    const { realmId, accessToken } = await this.getValidAccessToken();
    const response = await fetch(`${QB_API_BASE}/${realmId}/customer`, {
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
