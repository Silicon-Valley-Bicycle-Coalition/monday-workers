import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1TokenStore } from './tokenStore';

describe('D1TokenStore', () => {
  it('returns null before any tokens are saved', async () => {
    const store = new D1TokenStore(env.DB);
    expect(await store.getTokens()).toBeNull();
  });

  it('saves and reads back tokens', async () => {
    const store = new D1TokenStore(env.DB);
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
    const store = new D1TokenStore(env.DB);
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

// #33: Intuit rotates refresh tokens, so two writers refreshing at once can leave D1 holding a
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
    const store = new D1TokenStore(env.DB);
    await store.saveTokens(seed);
    const first = (await store.getTokens())!.version;
    await store.saveTokens(seed);
    expect((await store.getTokens())!.version).toBe(first + 1);
  });

  it('grants the lease to exactly one of two concurrent refreshers', async () => {
    const store = new D1TokenStore(env.DB);
    await store.saveTokens(seed);
    const { version } = (await store.getTokens())!;

    const [a, b] = await Promise.all([
      store.acquireRefreshLease(version, 'lease-a', now, 30_000),
      store.acquireRefreshLease(version, 'lease-b', now, 30_000),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('refuses the lease against a stale version', async () => {
    const store = new D1TokenStore(env.DB);
    await store.saveTokens(seed);
    const { version } = (await store.getTokens())!;
    expect(await store.acquireRefreshLease(version - 1, 'lease-a', now, 30_000)).toBe(false);
  });

  it('lets a new refresher take over an expired lease', async () => {
    const store = new D1TokenStore(env.DB);
    await store.saveTokens(seed);
    const { version } = (await store.getTokens())!;
    expect(await store.acquireRefreshLease(version, 'lease-a', now, 30_000)).toBe(true);
    expect(await store.acquireRefreshLease(version, 'lease-b', now, 30_000)).toBe(false);
    expect(await store.acquireRefreshLease(version, 'lease-b', new Date(now.getTime() + 31_000), 30_000)).toBe(true);
  });

  it('saves refreshed tokens only for the lease holder at the expected version, then clears the lease', async () => {
    const store = new D1TokenStore(env.DB);
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
    const store = new D1TokenStore(env.DB);
    await store.saveTokens(seed);
    const { version } = (await store.getTokens())!;
    await store.acquireRefreshLease(version, 'lease-a', now, 30_000);

    await store.releaseRefreshLease('lease-b');
    expect(await store.acquireRefreshLease(version, 'lease-c', now, 30_000)).toBe(false);
    await store.releaseRefreshLease('lease-a');
    expect(await store.acquireRefreshLease(version, 'lease-c', now, 30_000)).toBe(true);
  });
});
