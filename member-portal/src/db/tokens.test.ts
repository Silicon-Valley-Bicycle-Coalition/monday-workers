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
    expect(first).toEqual({ donorItemIds: ['donor-1', 'donor-2'], emailHash: null });

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

  const FUTURE = '2026-08-22T01:00:00.000Z';
  const NOW = '2026-08-22T00:30:00.000Z';

  async function codeRow(store: D1MagicLinkTokenStore, tokenHash: string, requestHash: string, extra: object = {}) {
    await store.createToken({
      tokenHash,
      donorItemIds: ['donor-1'],
      expiresAt: FUTURE,
      requestHash,
      codeHash: `code-${tokenHash}`,
      emailHash: `email-${tokenHash}`,
      ...extra,
    });
  }

  it('returns the email hash stored with a token', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-eh', 'req-eh');
    expect(await store.consumeToken('tok-eh', NOW)).toEqual({ donorItemIds: ['donor-1'], emailHash: 'email-tok-eh' });
  });

  it('takeCodeAttempt returns the hashes and allows exactly 5 tries', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-att', 'req-att');
    for (let i = 0; i < 5; i++) {
      expect(await store.takeCodeAttempt('req-att', NOW, 5)).toEqual({ codeHash: 'code-tok-att', emailHash: 'email-tok-att' });
    }
    expect(await store.takeCodeAttempt('req-att', NOW, 5)).toBeNull();
  });

  it('takeCodeAttempt returns null for an expired, used, code-less or unknown row', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-exp', 'req-exp', { expiresAt: '2026-08-22T00:00:00.000Z' });
    await codeRow(store, 'tok-used', 'req-used');
    await store.consumeToken('tok-used', NOW);
    await store.createToken({ tokenHash: 'tok-nocode', donorItemIds: ['d'], expiresAt: FUTURE, requestHash: 'req-nocode' });
    expect(await store.takeCodeAttempt('req-exp', NOW, 5)).toBeNull();
    expect(await store.takeCodeAttempt('req-used', NOW, 5)).toBeNull();
    expect(await store.takeCodeAttempt('req-nocode', NOW, 5)).toBeNull();
    expect(await store.takeCodeAttempt('req-unknown', NOW, 5)).toBeNull();
  });

  it('claimByRequest claims once, and then consumeToken on the same row is null', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-claim', 'req-claim');
    expect(await store.claimByRequest('req-claim', NOW)).toEqual({ donorItemIds: ['donor-1'], emailHash: 'email-tok-claim' });
    expect(await store.claimByRequest('req-claim', NOW)).toBeNull();
    expect(await store.consumeToken('tok-claim', NOW)).toBeNull();
  });

  it('claimByRequest returns null for an expired row', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-cexp', 'req-cexp', { expiresAt: '2026-08-22T00:00:00.000Z' });
    expect(await store.claimByRequest('req-cexp', NOW)).toBeNull();
  });

  it('takeCodeAttempt returns null after consumeToken', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-after', 'req-after');
    await store.consumeToken('tok-after', NOW);
    expect(await store.takeCodeAttempt('req-after', NOW, 5)).toBeNull();
  });

  it('keeps rows with different request hashes separate', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-sep-a', 'req-sep-a');
    await codeRow(store, 'tok-sep-b', 'req-sep-b');
    expect((await store.takeCodeAttempt('req-sep-a', NOW, 5))?.codeHash).toBe('code-tok-sep-a');
    expect((await store.claimByRequest('req-sep-b', NOW))?.emailHash).toBe('email-tok-sep-b');
    expect(await store.claimByRequest('req-sep-a', NOW)).not.toBeNull();
  });
});
