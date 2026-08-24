import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1MagicLinkTokenStore } from './tokens';

describe('D1MagicLinkTokenStore', () => {
  it('consumes a valid, unexpired token exactly once', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await store.createToken({
      tokenHash: 'hash-1',
      donorItemIds: ['donor-1', 'donor-2'],
      expiresAt: '2026-08-22T01:00:00.000Z',
    });

    const first = await store.consumeToken('hash-1', '2026-08-22T00:30:00.000Z');
    expect(first).toEqual(['donor-1', 'donor-2']);

    const second = await store.consumeToken('hash-1', '2026-08-22T00:31:00.000Z');
    expect(second).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await store.createToken({
      tokenHash: 'hash-2',
      donorItemIds: ['donor-3'],
      expiresAt: '2026-08-22T01:00:00.000Z',
    });

    const result = await store.consumeToken('hash-2', '2026-08-22T02:00:00.000Z');
    expect(result).toBeNull();
  });

  it('returns null for an unknown token hash', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    expect(await store.consumeToken('does-not-exist', '2026-08-22T00:00:00.000Z')).toBeNull();
  });
});
