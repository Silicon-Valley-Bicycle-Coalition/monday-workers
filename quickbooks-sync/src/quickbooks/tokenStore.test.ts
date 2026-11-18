import { env } from 'cloudflare:workers';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { HttpQuickBooksClient } from './client';
import { D1TokenStore } from './tokenStore';

// 32 bytes of base64, as `openssl rand -base64 32` prints. Test-only.
const TEST_KEY = btoa('k'.repeat(32));
const OTHER_KEY = btoa('o'.repeat(32));

describe('D1TokenStore', () => {
  it('returns null before any tokens are saved', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    expect(await store.getTokens()).toBeNull();
  });

  it('saves and reads back tokens', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    await store.saveTokens({
      realmId: 'realm-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: '2026-08-22T01:00:00.000Z',
    });

    expect(await store.getTokens()).toEqual({
      realmId: 'realm-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: '2026-08-22T01:00:00.000Z',
      version: expect.any(Number),
    });
  });

  it('overwrites the single stored row on a second save', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    await store.saveTokens({
      realmId: 'realm-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: '2026-08-22T01:00:00.000Z',
    });
    await store.saveTokens({
      realmId: 'realm-1',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: '2026-08-22T02:00:00.000Z',
    });

    expect(await store.getTokens()).toMatchObject({
      realmId: 'realm-1',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: '2026-08-22T02:00:00.000Z',
    });
  });
});

// GL#33: Intuit rotates refresh tokens, so two writers refreshing at once can leave D1 holding a
// token Intuit has already invalidated. Refreshes now take a D1 lease and save by
// compare-and-swap on a version column.
describe('D1TokenStore refresh lease and compare-and-swap', () => {
  const seed = {
    realmId: 'realm-1',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessTokenExpiresAt: '2026-08-22T01:00:00.000Z',
  };
  const refreshed = { ...seed, accessToken: 'access-2', refreshToken: 'refresh-2', accessTokenExpiresAt: '2026-08-22T02:00:00.000Z' };
  const now = new Date('2026-08-22T01:00:00.000Z');

  it('exposes a version that each save advances', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    await store.saveTokens(seed);
    const first = (await store.getTokens())!.version;
    await store.saveTokens(seed);
    expect((await store.getTokens())!.version).toBe(first + 1);
  });

  it('grants the lease to exactly one of two concurrent refreshers', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    await store.saveTokens(seed);
    const { version } = (await store.getTokens())!;

    const [a, b] = await Promise.all([
      store.acquireRefreshLease(version, 'lease-a', now, 30_000),
      store.acquireRefreshLease(version, 'lease-b', now, 30_000),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('refuses the lease against a stale version', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    await store.saveTokens(seed);
    const { version } = (await store.getTokens())!;
    expect(await store.acquireRefreshLease(version - 1, 'lease-a', now, 30_000)).toBe(false);
  });

  it('lets a new refresher take over an expired lease', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    await store.saveTokens(seed);
    const { version } = (await store.getTokens())!;
    expect(await store.acquireRefreshLease(version, 'lease-a', now, 30_000)).toBe(true);
    expect(await store.acquireRefreshLease(version, 'lease-b', now, 30_000)).toBe(false);
    expect(await store.acquireRefreshLease(version, 'lease-b', new Date(now.getTime() + 31_000), 30_000)).toBe(true);
  });

  it('saves refreshed tokens only for the lease holder at the expected version, then clears the lease', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    await store.saveTokens(seed);
    const { version } = (await store.getTokens())!;
    await store.acquireRefreshLease(version, 'lease-a', now, 30_000);

    expect(await store.saveRefreshedTokens(refreshed, version, 'lease-b')).toBe(false);
    expect(await store.saveRefreshedTokens(refreshed, version, 'lease-a')).toBe(true);
    expect(await store.getTokens()).toMatchObject({ ...refreshed, version: version + 1 });
    // A second save against the old version (a writer that lost the race) changes nothing.
    expect(await store.saveRefreshedTokens({ ...refreshed, refreshToken: 'refresh-stale' }, version, 'lease-a')).toBe(false);
    expect((await store.getTokens())!.refreshToken).toBe('refresh-2');
    // The lease was cleared by the save, so the next refresh can take it at the new version.
    expect(await store.acquireRefreshLease(version + 1, 'lease-c', now, 30_000)).toBe(true);
  });

  it('releases a lease only for its holder', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    await store.saveTokens(seed);
    const { version } = (await store.getTokens())!;
    await store.acquireRefreshLease(version, 'lease-a', now, 30_000);

    await store.releaseRefreshLease('lease-b');
    expect(await store.acquireRefreshLease(version, 'lease-c', now, 30_000)).toBe(false);
    await store.releaseRefreshLease('lease-a');
    expect(await store.acquireRefreshLease(version, 'lease-c', now, 30_000)).toBe(true);
  });
});

// GL#68: anyone who can read D1 (a dashboard session, a D1 export, an API token scoped to D1) could
// otherwise lift a live refresh token. The key lives apart from the data, in a Worker secret.
describe('D1TokenStore encryption at rest', () => {
  const pair = {
    realmId: 'realm-1',
    accessToken: 'plain-access-token',
    refreshToken: 'plain-refresh-token',
    accessTokenExpiresAt: '2026-08-22T01:00:00.000Z',
  };
  const raw = () =>
    env.DB.prepare('SELECT * FROM qb_oauth_tokens WHERE id = 1').first<{
      realm_id: string;
      access_token: string;
      refresh_token: string;
      access_token_expires_at: string;
    }>();
  // How the README's OAuth Playground seed writes the row: plaintext, expiry in the past.
  const seedPlaintext = () =>
    env.DB.prepare(
      `INSERT INTO qb_oauth_tokens (id, realm_id, access_token, refresh_token, access_token_expires_at, updated_at)
       VALUES (1, 'realm-1', 'seed-access', 'seed-refresh', '1970-01-01T00:00:00.000Z', datetime('now'))`
    ).run();

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM qb_oauth_tokens').run();
  });

  it('saveTokens stores neither token readably, and reads them back', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    await store.saveTokens(pair);

    const row = (await raw())!;
    expect(row.access_token).toMatch(/^enc:v1:/);
    expect(row.refresh_token).toMatch(/^enc:v1:/);
    expect(JSON.stringify(row)).not.toContain('plain-');
    expect(row.realm_id).toBe('realm-1');
    expect(row.access_token_expires_at).toBe(pair.accessTokenExpiresAt);
    expect(await store.getTokens()).toMatchObject(pair);
  });

  it('saveRefreshedTokens stores neither token readably, and reads them back', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    await store.saveTokens(pair);
    const version = (await store.getTokens())!.version;
    expect(await store.acquireRefreshLease(version, 'lease', new Date(), 30_000)).toBe(true);

    const rotated = { ...pair, accessToken: 'plain-access-2', refreshToken: 'plain-refresh-2' };
    expect(await store.saveRefreshedTokens(rotated, version, 'lease')).toBe(true);

    expect(JSON.stringify(await raw())).not.toContain('plain-');
    expect(await store.getTokens()).toMatchObject(rotated);
  });

  it('never repeats a ciphertext for the same token', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    await store.saveTokens(pair);
    const first = (await raw())!.refresh_token;
    await store.saveTokens(pair);
    expect((await raw())!.refresh_token).not.toBe(first);
  });

  it('reads a plaintext pair seeded by hand', async () => {
    await seedPlaintext();
    expect(await new D1TokenStore(env.DB, TEST_KEY).getTokens()).toMatchObject({ accessToken: 'seed-access', refreshToken: 'seed-refresh' });
  });

  it('rejects a ciphertext moved to the other column', async () => {
    const store = new D1TokenStore(env.DB, TEST_KEY);
    await store.saveTokens(pair);
    await env.DB.prepare('UPDATE qb_oauth_tokens SET refresh_token = access_token').run();
    await expect(store.getTokens()).rejects.toThrow(/could not decrypt/);
  });

  it('refuses a wrong key by name, without revealing either token', async () => {
    await new D1TokenStore(env.DB, TEST_KEY).saveTokens(pair);
    const error = await new D1TokenStore(env.DB, OTHER_KEY).getTokens().catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/QB_TOKEN_ENCRYPTION_KEY/);
    expect((error as Error).message).not.toContain('plain-');
    expect((error as Error).message).not.toContain(OTHER_KEY);
  });

  it.each([undefined, '', 'not base64!', btoa('too short')])('refuses to read or save with the key %j', async (badKey) => {
    await seedPlaintext();
    const store = new D1TokenStore(env.DB, badKey);
    await expect(store.getTokens()).rejects.toThrow(/QB_TOKEN_ENCRYPTION_KEY/);
    await expect(store.saveTokens(pair)).rejects.toThrow(/QB_TOKEN_ENCRYPTION_KEY/);
  });

  // The ordering that matters: Intuit rotates the refresh token when it's used, so a key problem
  // first found while saving the new pair would lose it and force a re-seed by hand.
  it('never reaches Intuit without a usable key, even for a plaintext pair due for refresh', async () => {
    await seedPlaintext();
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    try {
      const client = new HttpQuickBooksClient(new D1TokenStore(env.DB, undefined), 'id', 'secret', 'https://sandbox-quickbooks.api.intuit.com/v3/company');
      await expect(client.getEntity('customer', '60')).rejects.toThrow(/QB_TOKEN_ENCRYPTION_KEY/);
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('getRealmId needs no key, so the webhook route never holds decrypted tokens', async () => {
    const store = new D1TokenStore(env.DB, undefined);
    expect(await store.getRealmId()).toBeNull();
    await new D1TokenStore(env.DB, TEST_KEY).saveTokens(pair);
    expect(await store.getRealmId()).toBe('realm-1');
  });
});
