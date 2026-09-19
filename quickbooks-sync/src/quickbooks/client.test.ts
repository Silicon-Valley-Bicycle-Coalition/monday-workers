import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpQuickBooksClient } from './client';
import type { TokenStore, QbTokens } from './tokenStore';

function fakeTokenStore(overrides: Partial<TokenStore> = {}): TokenStore {
  return {
    getTokens: vi.fn().mockResolvedValue(null),
    saveTokens: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; json: unknown }>) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce({ ok: r.ok, status: r.status ?? 200, json: async () => r.json });
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const validTokens: QbTokens = {
  realmId: 'realm-1',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

describe('HttpQuickBooksClient', () => {
  it('fetches an entity using a cached, unexpired access token', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    const fetchMock = mockFetchSequence([{ ok: true, json: { Customer: { Id: '1', DisplayName: 'Acme' } } }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', 'https://quickbooks.api.intuit.com/v3/company');

    const result = await client.getEntity('customer', '1');

    expect(result).toEqual({ Id: '1', DisplayName: 'Acme' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://quickbooks.api.intuit.com/v3/company/realm-1/customer/1');
    expect(tokenStore.saveTokens).not.toHaveBeenCalled();
  });

  it('fetches an invoice using the "Item" path segment for a product', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    const fetchMock = mockFetchSequence([{ ok: true, json: { Item: { Id: '5', Name: 'Widget' } } }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', 'https://quickbooks.api.intuit.com/v3/company');

    const result = await client.getEntity('product', '5');

    expect(result).toEqual({ Id: '5', Name: 'Widget' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://quickbooks.api.intuit.com/v3/company/realm-1/item/5');
  });

  it('refreshes an expired access token before fetching', async () => {
    const expiredTokens: QbTokens = { ...validTokens, accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() };
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(expiredTokens) });
    const fetchMock = mockFetchSequence([
      { ok: true, json: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 } },
      { ok: true, json: { Customer: { Id: '1' } } },
    ]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', 'https://quickbooks.api.intuit.com/v3/company');

    const result = await client.getEntity('customer', '1');

    expect(result).toEqual({ Id: '1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    expect(tokenStore.saveTokens).toHaveBeenCalledWith({
      realmId: 'realm-1',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: expect.any(String),
    });
    // second call uses the refreshed token
    expect((fetchMock.mock.calls[1]?.[1] as Record<string, unknown>)?.headers).toBeDefined();
    expect(((fetchMock.mock.calls[1]?.[1] as Record<string, unknown>)?.headers as Record<string, unknown>)?.Authorization).toBe('Bearer access-2');
  });

  it('throws when no tokens have been stored yet', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(null) });
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', 'https://quickbooks.api.intuit.com/v3/company');
    await expect(client.getEntity('customer', '1')).rejects.toThrow(/no OAuth tokens stored/);
  });

  it('creates a customer', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    const fetchMock = mockFetchSequence([{ ok: true, json: { Customer: { Id: '99' } } }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', 'https://quickbooks.api.intuit.com/v3/company');

    const result = await client.createCustomer({ DisplayName: 'New Co' });

    expect(result).toEqual({ id: '99' });
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe('https://quickbooks.api.intuit.com/v3/company/realm-1/customer');
    expect(JSON.parse((init as Record<string, unknown>).body as string)).toEqual({ DisplayName: 'New Co' });
  });

  it('throws on a non-OK API response', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    mockFetchSequence([{ ok: false, status: 500, json: {} }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', 'https://quickbooks.api.intuit.com/v3/company');
    await expect(client.getEntity('invoice', '1')).rejects.toThrow(/HTTP 500/);
  });

  it('builds entity URLs from the configured API base, so the sandbox host is a config change', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    const fetchMock = mockFetchSequence([{ ok: true, json: { Customer: { Id: '1' } } }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', 'https://sandbox-quickbooks.api.intuit.com/v3/company');

    await client.getEntity('customer', '1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://sandbox-quickbooks.api.intuit.com/v3/company/realm-1/customer/1');
  });
});
