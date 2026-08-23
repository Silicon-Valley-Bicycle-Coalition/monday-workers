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

    expect(await store.getTokens()).toEqual({
      realmId: 'realm-1',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: '2026-08-22T02:00:00.000Z',
    });
  });
});
