import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpQuickBooksClient } from './client';
import { isTerminalError } from '../errors';
import type { TokenStore, StoredQbTokens } from './tokenStore';

function fakeTokenStore(overrides: Partial<TokenStore> = {}): TokenStore {
  return {
    getTokens: vi.fn().mockResolvedValue(null),
    saveTokens: vi.fn().mockResolvedValue(undefined),
    acquireRefreshLease: vi.fn().mockResolvedValue(true),
    saveRefreshedTokens: vi.fn().mockResolvedValue(true),
    releaseRefreshLease: vi.fn().mockResolvedValue(undefined),
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

const validTokens: StoredQbTokens = {
  realmId: 'realm-1',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  version: 1,
};

const expiredTokens: StoredQbTokens = { ...validTokens, accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() };
const API_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const noSleep = { sleep: vi.fn().mockResolvedValue(undefined) };

function authorizationOf(call: unknown[] | undefined): unknown {
  return ((call?.[1] as Record<string, unknown>)?.headers as Record<string, unknown>)?.Authorization;
}

// GL#33: Intuit rotates refresh tokens and expires the previous one. The webhook and consumer both
// used to refresh near expiry with a last-writer-wins save, so a racing pair could leave D1 holding
// an invalidated refresh token (lockout until re-seeded by hand). Refreshes now take a D1 lease,
// save by compare-and-swap, and re-read D1 on invalid_grant.
describe('HttpQuickBooksClient token refresh (single refresher)', () => {
  it('refreshes under the lease and saves by compare-and-swap against the version it read', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(expiredTokens) });
    const fetchMock = mockFetchSequence([
      { ok: true, json: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 } },
      { ok: true, json: { Customer: { Id: '1' } } },
    ]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', API_BASE, noSleep);

    await client.getEntity('customer', '1');

    const [version, leaseToken] = (tokenStore.acquireRefreshLease as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(version).toBe(1);
    expect(tokenStore.saveRefreshedTokens).toHaveBeenCalledWith(
      { realmId: 'realm-1', accessToken: 'access-2', refreshToken: 'refresh-2', accessTokenExpiresAt: expect.any(String) },
      1,
      leaseToken
    );
    expect(tokenStore.saveTokens).not.toHaveBeenCalled();
    expect(authorizationOf(fetchMock.mock.calls[1])).toBe('Bearer access-2');
  });

  it('waits for another refresher and uses the token it saved, without calling Intuit itself', async () => {
    const refreshedByOther: StoredQbTokens = { ...validTokens, accessToken: 'access-other', version: 2 };
    const tokenStore = fakeTokenStore({
      getTokens: vi.fn().mockResolvedValueOnce(expiredTokens).mockResolvedValueOnce(refreshedByOther),
      acquireRefreshLease: vi.fn().mockResolvedValue(false),
    });
    const fetchMock = mockFetchSequence([{ ok: true, json: { Customer: { Id: '1' } } }]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', API_BASE, { sleep });

    await client.getEntity('customer', '1');

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authorizationOf(fetchMock.mock.calls[0])).toBe('Bearer access-other');
  });

  it('gives up with a retryable error when another refresher holds the lease too long', async () => {
    const tokenStore = fakeTokenStore({
      getTokens: vi.fn().mockResolvedValue(expiredTokens),
      acquireRefreshLease: vi.fn().mockResolvedValue(false),
    });
    const fetchMock = mockFetchSequence([]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', API_BASE, noSleep);

    await expect(client.getEntity('customer', '1')).rejects.toThrow(/refresh .*in progress/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on invalid_grant, re-reads D1 and uses a newer token another writer saved', async () => {
    const reseeded: StoredQbTokens = { ...validTokens, accessToken: 'access-reseeded', version: 5 };
    const tokenStore = fakeTokenStore({
      getTokens: vi.fn().mockResolvedValueOnce(expiredTokens).mockResolvedValueOnce(reseeded),
    });
    const fetchMock = mockFetchSequence([
      { ok: false, status: 400, json: { error: 'invalid_grant' } },
      { ok: true, json: { Customer: { Id: '1' } } },
    ]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', API_BASE, noSleep);

    await client.getEntity('customer', '1');

    expect(tokenStore.releaseRefreshLease).toHaveBeenCalled();
    expect(tokenStore.saveRefreshedTokens).not.toHaveBeenCalled();
    expect(authorizationOf(fetchMock.mock.calls[1])).toBe('Bearer access-reseeded');
  });

  it('on invalid_grant with nothing newer in D1, throws a re-seed error and leaves D1 alone', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(expiredTokens) });
    mockFetchSequence([{ ok: false, status: 400, json: { error: 'invalid_grant' } }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', API_BASE, noSleep);

    await expect(client.getEntity('customer', '1')).rejects.toThrow(/invalid_grant.*re-seed/);
    expect(tokenStore.saveRefreshedTokens).not.toHaveBeenCalled();
    expect(tokenStore.saveTokens).not.toHaveBeenCalled();
    expect(tokenStore.releaseRefreshLease).toHaveBeenCalled();
  });

  it('releases the lease when the refresh call fails for another reason', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(expiredTokens) });
    mockFetchSequence([{ ok: false, status: 503, json: {} }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', API_BASE, noSleep);

    await expect(client.getEntity('customer', '1')).rejects.toThrow(/refresh: HTTP 503/);
    expect(tokenStore.releaseRefreshLease).toHaveBeenCalled();
  });

  it('never overwrites D1 when its compare-and-swap loses, but still completes this call', async () => {
    const tokenStore = fakeTokenStore({
      getTokens: vi.fn().mockResolvedValue(expiredTokens),
      saveRefreshedTokens: vi.fn().mockResolvedValue(false),
    });
    const fetchMock = mockFetchSequence([
      { ok: true, json: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 } },
      { ok: true, json: { Customer: { Id: '1' } } },
    ]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', API_BASE, noSleep);

    await client.getEntity('customer', '1');

    expect(tokenStore.saveTokens).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/compare-and-swap/));
    expect(authorizationOf(fetchMock.mock.calls[1])).toBe('Bearer access-2');
    errorSpy.mockRestore();
  });
});

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
    expect(tokenStore.saveRefreshedTokens).toHaveBeenCalledWith(
      {
        realmId: 'realm-1',
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        accessTokenExpiresAt: expect.any(String),
      },
      1,
      expect.any(String)
    );
    // second call uses the refreshed token
    expect((fetchMock.mock.calls[1]?.[1] as Record<string, unknown>)?.headers).toBeDefined();
    expect(((fetchMock.mock.calls[1]?.[1] as Record<string, unknown>)?.headers as Record<string, unknown>)?.Authorization).toBe('Bearer access-2');
  });

  it('throws when no tokens have been stored yet', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(null) });
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', 'https://quickbooks.api.intuit.com/v3/company');
    await expect(client.getEntity('customer', '1')).rejects.toThrow(/no OAuth tokens stored/);
  });

  // Must run before any other test in this file calls createCustomer: the log guard
  // (`sinkLogged`) is module-scope, so it is only still `false` on the first call.
  it('logs the sandbox outbound sink once per isolate, not on the second call', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    const fetchMock = mockFetchSequence([
      { ok: true, json: { Customer: { Id: '1' } } },
      { ok: true, json: { Customer: { Id: '1' } } },
    ]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', 'https://sandbox-quickbooks.api.intuit.com/v3/company');

    await client.createCustomer({ DisplayName: 'New Co' }, 'req-1');
    await client.createCustomer({ DisplayName: 'New Co' }, 'req-1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toEqual({
      sandboxOutbound: 'quickbooks',
      apiBaseUrl: 'https://sandbox-quickbooks.api.intuit.com/v3/company',
    });

    logSpy.mockRestore();
  });

  it('creates a customer', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    const fetchMock = mockFetchSequence([{ ok: true, json: { Customer: { Id: '99' } } }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', 'https://quickbooks.api.intuit.com/v3/company');

    const result = await client.createCustomer({ DisplayName: 'New Co' }, 'monday-item-42');

    expect(result).toEqual({ id: '99' });
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call!;
    // requestid (GL#33): QuickBooks answers a repeat of the same requestid with the original
    // response instead of creating a second Customer.
    expect(url).toBe('https://quickbooks.api.intuit.com/v3/company/realm-1/customer?requestid=monday-item-42');
    expect(JSON.parse((init as Record<string, unknown>).body as string)).toEqual({ DisplayName: 'New Co' });
  });

  // GL#33 review: a create failure used to read only "HTTP 400 creating customer" and retried into
  // the DLQ. Intuit's Fault is now in the message, and a validation fault is terminal.
  it('puts Intuit fault details in the error and marks a validation fault terminal', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    mockFetchSequence([
      {
        ok: false,
        status: 400,
        json: {
          Fault: {
            type: 'ValidationFault',
            Error: [{ Message: 'Duplicate Name Exists Error', Detail: 'The name supplied already exists. : Id=58', code: '6240' }],
          },
        },
      },
    ]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', API_BASE);

    const err = await client.createCustomer({ DisplayName: 'Acme' }, 'req-9').catch((e: unknown) => e);

    expect(isTerminalError(err)).toBe(true);
    expect((err as Error).message).toBe(
      'quickbooks API: HTTP 400 creating customer — ValidationFault 6240 Duplicate Name Exists Error: The name supplied already exists. : Id=58'
    );
  });

  it('keeps a server-side fault retryable', async () => {
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) });
    mockFetchSequence([{ ok: false, status: 503, json: { Fault: { type: 'SystemFault', Error: [{ Message: 'Service down', code: '10000' }] } } }]);
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', API_BASE);

    const err = await client.getEntity('customer', '1').catch((e: unknown) => e);

    expect(isTerminalError(err)).toBe(false);
    expect((err as Error).message).toMatch(/HTTP 503 fetching customer 1 — SystemFault 10000 Service down/);
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

// GL#73: a hung Intuit call must fail well inside the 30 s refresh lease, so the lease holder releases
// it (or saves) before another refresher can take over and rotate the same refresh token again.
describe('HttpQuickBooksClient request timeouts', () => {
  function hangingFetch() {
    const fetchMock = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function fastTimeouts() {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    return vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(1));
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('times out a hung token refresh below the lease TTL and releases the lease', async () => {
    const timeoutSpy = fastTimeouts();
    hangingFetch();
    const tokenStore = fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(expiredTokens) });
    const client = new HttpQuickBooksClient(tokenStore, 'client-id', 'client-secret', API_BASE, noSleep);

    await expect(client.getEntity('customer', '1')).rejects.toMatchObject({ name: 'TimeoutError' });

    const [timeoutMs] = timeoutSpy.mock.calls[0]!;
    expect(timeoutMs).toBeLessThan(30_000);
    expect(tokenStore.releaseRefreshLease).toHaveBeenCalled();
    expect(tokenStore.saveRefreshedTokens).not.toHaveBeenCalled();
  });

  it('times out a hung entity read', async () => {
    fastTimeouts();
    hangingFetch();
    const client = new HttpQuickBooksClient(fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) }), 'id', 'secret', API_BASE, noSleep);

    await expect(client.getEntity('invoice', '7')).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('times out a hung customer create', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fastTimeouts();
    hangingFetch();
    const client = new HttpQuickBooksClient(fakeTokenStore({ getTokens: vi.fn().mockResolvedValue(validTokens) }), 'id', 'secret', API_BASE, noSleep);

    await expect(client.createCustomer({ DisplayName: 'A' }, 'req-1')).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
