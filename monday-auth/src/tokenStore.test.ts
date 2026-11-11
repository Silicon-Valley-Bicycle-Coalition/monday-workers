import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { D1AppTokenStore } from './tokenStore';
import { TEST_ENC_KEY } from '../test/enc-key';

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
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    expect(await store.get('sync')).toBeNull();
    await store.save(seed);
    expect(await store.get('sync')).toEqual({
      ...seed,
      status: 'ok',
      version: 1,
      lastRefreshErrorAt: null,
      refreshFailingSince: null,
      refreshErrorAlertedAt: null,
    });
    expect(await store.get('portal')).toBeNull();
  });

  it('stores both tokens encrypted, and a wrong key cannot read them', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    const raw = await env.DB.prepare('SELECT access_token, refresh_token FROM oauth_tokens').first<{ access_token: string; refresh_token: string }>();
    expect(raw?.access_token).toMatch(/^enc:v1:/);
    expect(raw?.refresh_token).toMatch(/^enc:v1:/);
    expect(JSON.stringify(raw)).not.toContain('acc1');
    expect(JSON.stringify(raw)).not.toContain('ref1');
    await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000);
    await store.saveRefreshed('sync', refreshed, 1, 'lease-a');
    const after = await env.DB.prepare('SELECT access_token, refresh_token FROM oauth_tokens').first<{ access_token: string; refresh_token: string }>();
    expect(after?.access_token).toMatch(/^enc:v1:/);
    expect(await store.get('sync')).toMatchObject(refreshed);
    const otherKey = Buffer.alloc(32, 1).toString('base64');
    await expect(new D1AppTokenStore(env.DB, otherKey).get('sync')).rejects.toThrow(/could not decrypt/);
  });

  it('fails closed without a valid key, and still reads a pre-encryption plaintext row', async () => {
    await expect(new D1AppTokenStore(env.DB, undefined).save(seed)).rejects.toThrow(/TOKEN_ENC_KEY/);
    await expect(new D1AppTokenStore(env.DB, 'not-a-key').save(seed)).rejects.toThrow(/TOKEN_ENC_KEY/);
    await env.DB.prepare(
      `INSERT INTO oauth_tokens (app, access_token, refresh_token, access_token_expires_at, authorized_user_id, status, version, updated_at)
       VALUES ('sync', 'plain-acc', 'plain-ref', '2026-10-30T12:00:00.000Z', '42', 'ok', 1, '2026-10-30T10:00:00.000Z')`
    ).run();
    expect(await new D1AppTokenStore(env.DB, TEST_ENC_KEY).get('sync')).toMatchObject({ accessToken: 'plain-acc', refreshToken: 'plain-ref' });
  });

  it('only one of two leases wins', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    const [a, b] = await Promise.all([
      store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000),
      store.acquireRefreshLease('sync', 1, 'lease-b', now, 60_000),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('an expired lease can be taken over', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    expect(await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000)).toBe(true);
    expect(await store.acquireRefreshLease('sync', 1, 'lease-b', new Date(now.getTime() + 61_000), 60_000)).toBe(true);
  });

  it('saveRefreshed writes, bumps the version and clears the lease', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000);
    expect(await store.saveRefreshed('sync', refreshed, 1, 'lease-a')).toBe(true);
    expect(await store.get('sync')).toMatchObject({ ...refreshed, version: 2, authorizedUserId: '42' });
    // Lease cleared: a new caller at version 2 can take it.
    expect(await store.acquireRefreshLease('sync', 2, 'lease-b', now, 60_000)).toBe(true);
  });

  it('saveRefreshed fails when the version moved', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000);
    await store.save({ ...seed, accessToken: 'reseeded' }); // version 2, lease cleared
    expect(await store.saveRefreshed('sync', refreshed, 1, 'lease-a')).toBe(false);
    expect((await store.get('sync'))?.accessToken).toBe('reseeded');
  });

  it('saveRefreshed fails when another caller holds the lease', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000);
    expect(await store.saveRefreshed('sync', refreshed, 1, 'lease-b')).toBe(false);
    expect((await store.get('sync'))?.accessToken).toBe('acc1');
  });

  it('releaseRefreshLease frees only the holder\'s lease', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000);
    await store.releaseRefreshLease('sync', 'lease-b');
    expect(await store.acquireRefreshLease('sync', 1, 'lease-c', now, 60_000)).toBe(false);
    await store.releaseRefreshLease('sync', 'lease-a');
    expect(await store.acquireRefreshLease('sync', 1, 'lease-c', now, 60_000)).toBe(true);
  });

  it('keeps apps independent', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    await store.save({ ...seed, app: 'portal', accessToken: 'p' });
    await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000);
    expect(await store.acquireRefreshLease('portal', 1, 'lease-b', now, 60_000)).toBe(true);
  });

  it('markNeedsConsent returns true once, then false', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    expect(await store.markNeedsConsent('sync', 1)).toBe(true);
    expect((await store.get('sync'))?.status).toBe('needs_consent');
    expect(await store.markNeedsConsent('sync', 1)).toBe(false);
    expect(await store.markNeedsConsent('portal', 1)).toBe(false); // no row
  });

  it('markNeedsConsent does nothing when the version moved (an old-generation invalid_grant)', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    await store.save({ ...seed, accessToken: 'reconsented' }); // version 2
    expect(await store.markNeedsConsent('sync', 1)).toBe(false);
    expect(await store.get('sync')).toMatchObject({ status: 'ok', accessToken: 'reconsented' });
  });

  it('recordRefreshError keeps the streak start, moves the last-error time, and is version-gated', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    const later = new Date(now.getTime() + 30 * 60_000);
    await store.recordRefreshError('sync', 1, now);
    await store.recordRefreshError('sync', 1, later);
    expect(await store.get('sync')).toMatchObject({
      refreshFailingSince: now.toISOString(),
      lastRefreshErrorAt: later.toISOString(),
      refreshErrorAlertedAt: null,
    });
    await store.recordRefreshError('sync', 7, new Date(later.getTime() + 1)); // stale version: no-op
    expect((await store.get('sync'))?.lastRefreshErrorAt).toBe(later.toISOString());
  });

  it('markRefreshErrorAlerted returns true once per failing streak, and only while failing', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    expect(await store.markRefreshErrorAlerted('sync', 1, now)).toBe(false); // not failing
    await store.recordRefreshError('sync', 1, now);
    expect(await store.markRefreshErrorAlerted('sync', 2, now)).toBe(false); // wrong version
    expect(await store.markRefreshErrorAlerted('sync', 1, now)).toBe(true);
    expect(await store.markRefreshErrorAlerted('sync', 1, now)).toBe(false);
    expect((await store.get('sync'))?.refreshErrorAlertedAt).toBe(now.toISOString());
  });

  it('saveRefreshed and save clear the refresh-error state, so the next streak alerts again', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    await store.recordRefreshError('sync', 1, now);
    await store.markRefreshErrorAlerted('sync', 1, now);
    await store.acquireRefreshLease('sync', 1, 'lease-a', now, 60_000);
    expect(await store.saveRefreshed('sync', refreshed, 1, 'lease-a')).toBe(true);
    const cleared = { lastRefreshErrorAt: null, refreshFailingSince: null, refreshErrorAlertedAt: null };
    expect(await store.get('sync')).toMatchObject({ version: 2, ...cleared });

    await store.recordRefreshError('sync', 2, now);
    expect(await store.markRefreshErrorAlerted('sync', 2, now)).toBe(true);
    await store.save(seed); // re-consent
    expect(await store.get('sync')).toMatchObject({ version: 3, ...cleared });
  });

  it('save after needs_consent resets status to ok', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.save(seed);
    await store.markNeedsConsent('sync', 1);
    await store.save(seed);
    expect(await store.get('sync')).toMatchObject({ status: 'ok', version: 2 });
  });

  it('takePending returns the verifier once and deletes on read', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.putPending('st1', 'portal', 'verifier', 'https://a.test/oauth/callback', now);
    expect(await store.takePending('st1', new Date(now.getTime() + 60_000))).toEqual({
      app: 'portal',
      codeVerifier: 'verifier',
      redirectUri: 'https://a.test/oauth/callback',
    });
    expect(await store.takePending('st1', now)).toBeNull();
  });

  it('takePending returns null after 10 minutes and deletes on read', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.putPending('st2', 'portal', 'verifier', 'https://a.test/oauth/callback', now);
    expect(await store.takePending('st2', new Date(now.getTime() + 10 * 60_000 + 1))).toBeNull();
    const row = await env.DB.prepare('SELECT 1 FROM oauth_pending WHERE state = ?1').bind('st2').first();
    expect(row).toBeNull();
  });

  it('purgeExpiredPending deletes only rows older than 10 minutes and reports the count', async () => {
    const store = new D1AppTokenStore(env.DB, TEST_ENC_KEY);
    await store.putPending('old', 'portal', 'v1', 'https://a.test/cb', now);
    await store.putPending('new', 'sync', 'v2', 'https://a.test/cb', new Date(now.getTime() + 9 * 60_000));
    const purged = await store.purgeExpiredPending(new Date(now.getTime() + 10 * 60_000 + 1));
    expect(purged).toBe(1);
    expect(await store.takePending('old', now)).toBeNull();
    expect(await store.takePending('new', new Date(now.getTime() + 10 * 60_000))).toEqual({ app: 'sync', codeVerifier: 'v2', redirectUri: 'https://a.test/cb' });
  });
});
