import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { D1AppTokenStore } from './tokenStore';

const seed = {
  app: 'sync' as const,
  accessToken: 'acc1',
  refreshToken: 'ref1',
  accessTokenExpiresAt: '2026-10-30T12:00:00.000Z',
  authorizedUserId: '42',
};
const refreshed = { accessToken: 'acc2', refreshToken: 'ref2', accessTokenExpiresAt: '2026-10-30T13:00:00.000Z' };
const now = new Date('2026-10-30T11:00:00.000Z');

describe('D1AppTokenStore', () => {
  it('returns null for an app with no row, and round-trips a saved one', async () => {
    const store = new D1AppTokenStore(env.DB);
    expect(await store.get('sync')).toBeNull();
    await store.save(seed);
    expect(await store.get('sync')).toEqual({ ...seed, status: 'ok', version: 1 });
    expect(await store.get('portal')).toBeNull();
  });

  it('only one of two leases wins', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.save(seed);
    const [a, b] = await Promise.all([
      store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000),
      store.acquireRefreshLease('sync', 1, 'lease-b', now, 60_000),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('an expired lease can be taken over', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.save(seed);
    expect(await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000)).toBe(true);
    expect(await store.acquireRefreshLease('sync', 1, 'lease-b', new Date(now.getTime() + 61_000), 60_000)).toBe(true);
  });

  it('saveRefreshed writes, bumps the version and clears the lease', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.save(seed);
    await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000);
    expect(await store.saveRefreshed('sync', refreshed, 1, 'lease-a')).toBe(true);
    expect(await store.get('sync')).toMatchObject({ ...refreshed, version: 2, authorizedUserId: '42' });
    // Lease cleared: a new caller at version 2 can take it.
    expect(await store.acquireRefreshLease('sync', 2, 'lease-b', now, 60_000)).toBe(true);
  });

  it('saveRefreshed fails when the version moved', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.save(seed);
    await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000);
    await store.save({ ...seed, accessToken: 'reseeded' }); // version 2, lease cleared
    expect(await store.saveRefreshed('sync', refreshed, 1, 'lease-a')).toBe(false);
    expect((await store.get('sync'))?.accessToken).toBe('reseeded');
  });

  it('saveRefreshed fails when another caller holds the lease', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.save(seed);
    await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000);
    expect(await store.saveRefreshed('sync', refreshed, 1, 'lease-b')).toBe(false);
    expect((await store.get('sync'))?.accessToken).toBe('acc1');
  });

  it('releaseRefreshLease frees only the holder\'s lease', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.save(seed);
    await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000);
    await store.releaseRefreshLease('sync', 'lease-b');
    expect(await store.acquireRefreshLease('sync', 1, 'lease-c', now, 60_000)).toBe(false);
    await store.releaseRefreshLease('sync', 'lease-a');
    expect(await store.acquireRefreshLease('sync', 1, 'lease-c', now, 60_000)).toBe(true);
  });

  it('keeps apps independent', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.save(seed);
    await store.save({ ...seed, app: 'portal', accessToken: 'p' });
    await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000);
    expect(await store.acquireRefreshLease('portal', 1, 'lease-b', now, 60_000)).toBe(true);
  });

  it('markNeedsConsent returns true once, then false', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.save(seed);
    expect(await store.markNeedsConsent('sync', 1)).toBe(true);
    expect((await store.get('sync'))?.status).toBe('needs_consent');
    expect(await store.markNeedsConsent('sync', 1)).toBe(false);
    expect(await store.markNeedsConsent('portal', 1)).toBe(false); // no row
  });

  it('markNeedsConsent does nothing when the version moved (an old-generation invalid_grant)', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.save(seed);
    await store.save({ ...seed, accessToken: 'reconsented' }); // version 2
    expect(await store.markNeedsConsent('sync', 1)).toBe(false);
    expect(await store.get('sync')).toMatchObject({ status: 'ok', accessToken: 'reconsented' });
  });

  it('save after needs_consent resets status to ok', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.save(seed);
    await store.markNeedsConsent('sync', 1);
    await store.save(seed);
    expect(await store.get('sync')).toMatchObject({ status: 'ok', version: 2 });
  });

  it('takePending returns the verifier once and deletes on read', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.putPending('st1', 'portal', 'verifier', 'https://a.test/oauth/callback', now);
    expect(await store.takePending('st1', new Date(now.getTime() + 60_000))).toEqual({
      app: 'portal',
      codeVerifier: 'verifier',
      redirectUri: 'https://a.test/oauth/callback',
    });
    expect(await store.takePending('st1', now)).toBeNull();
  });

  it('takePending returns null after 10 minutes and deletes on read', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.putPending('st2', 'portal', 'verifier', 'https://a.test/oauth/callback', now);
    expect(await store.takePending('st2', new Date(now.getTime() + 10 * 60_000 + 1))).toBeNull();
    const row = await env.DB.prepare('SELECT 1 FROM oauth_pending WHERE state = ?1').bind('st2').first();
    expect(row).toBeNull();
  });

  it('purgeExpiredPending deletes only rows older than 10 minutes and reports the count', async () => {
    const store = new D1AppTokenStore(env.DB);
    await store.putPending('old', 'portal', 'v1', 'https://a.test/cb', now);
    await store.putPending('new', 'sync', 'v2', 'https://a.test/cb', new Date(now.getTime() + 9 * 60_000));
    const purged = await store.purgeExpiredPending(new Date(now.getTime() + 10 * 60_000 + 1));
    expect(purged).toBe(1);
    expect(await store.takePending('old', now)).toBeNull();
    expect(await store.takePending('new', new Date(now.getTime() + 10 * 60_000))).toEqual({ app: 'sync', codeVerifier: 'v2', redirectUri: 'https://a.test/cb' });
  });
});
