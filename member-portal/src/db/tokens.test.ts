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

  describe('consumeCode', () => {
    const EXPIRES = '2026-08-22T01:00:00.000Z';
    const NOW = '2026-08-22T00:30:00.000Z';

    async function createCodeRow(
      store: D1MagicLinkTokenStore,
      tokenHash: string,
      requestHash: string,
      codeHash: string,
      expiresAt = EXPIRES
    ): Promise<void> {
      await store.createToken({
        tokenHash,
        donorItemIds: ['donor-1'],
        expiresAt,
        requestHash,
        codeHash,
        locale: 'es',
      });
    }

    async function attemptsFor(requestHash: string): Promise<number[]> {
      const { results } = await env.DB.prepare(
        `SELECT code_attempts FROM magic_link_tokens WHERE request_hash = ?1`
      )
        .bind(requestHash)
        .all<{ code_attempts: number }>();
      return results.map((row) => row.code_attempts);
    }

    it('succeeds once', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, 'code-once-token', 'code-once-req', 'code-once-code');

      expect(await store.consumeCode('code-once-req', 'code-once-code', NOW)).toEqual({
        donorItemIds: ['donor-1'],
        locale: 'es',
      });
      expect(await store.consumeCode('code-once-req', 'code-once-code', NOW)).toBeNull();
    });

    it('burns the link', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, 'burn-link-token', 'burn-link-req', 'burn-link-code');

      expect(await store.consumeCode('burn-link-req', 'burn-link-code', NOW)).not.toBeNull();
      expect(await store.consumeToken('burn-link-token', NOW)).toBeNull();
    });

    it('is burned by consumeToken', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, 'burn-code-token', 'burn-code-req', 'burn-code-code');

      expect(await store.consumeToken('burn-code-token', NOW)).toEqual(['donor-1']);
      expect(await store.consumeCode('burn-code-req', 'burn-code-code', NOW)).toBeNull();
    });

    it('stops after 5 checks', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, 'cap-token', 'cap-req', 'cap-code');

      for (let i = 0; i < 5; i++) {
        expect(await store.consumeCode('cap-req', 'wrong-code', NOW)).toBeNull();
      }
      expect(await store.consumeCode('cap-req', 'cap-code', NOW)).toBeNull();
    });

    it('matches any live row for the request', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, 'multi-token-1', 'multi-req', 'multi-code-1');
      await createCodeRow(store, 'multi-token-2', 'multi-req', 'multi-code-2');

      expect(await store.consumeCode('multi-req', 'multi-code-1', NOW)).toEqual({
        donorItemIds: ['donor-1'],
        locale: 'es',
      });
    });

    it('ignores expired rows', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, 'expired-token', 'expired-req', 'expired-code', '2026-08-22T00:00:00.000Z');

      expect(await store.consumeCode('expired-req', 'expired-code', NOW)).toBeNull();
    });

    it('returns null for an unknown request', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      expect(await store.consumeCode('no-such-req', 'no-such-code', NOW)).toBeNull();
    });

    it('concurrent wrong guesses cannot exceed 5', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, 'race-token-1', 'race-req', 'race-code-1');
      await createCodeRow(store, 'race-token-2', 'race-req', 'race-code-2');

      const results = await Promise.all(
        Array.from({ length: 8 }, () => store.consumeCode('race-req', 'wrong-code', NOW))
      );

      expect(results.every((result) => result === null)).toBe(true);
      const attempts = await attemptsFor('race-req');
      expect(attempts).toHaveLength(2);
      for (const count of attempts) {
        expect(count).toBeLessThanOrEqual(5);
      }
    });

    it('never matches a row created without code fields', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await store.createToken({
        tokenHash: 'letter-token',
        donorItemIds: ['donor-1'],
        expiresAt: EXPIRES,
      });

      const row = await env.DB.prepare(
        `SELECT request_hash, code_hash, code_attempts, locale FROM magic_link_tokens WHERE token_hash = ?1`
      )
        .bind('letter-token')
        .first();
      expect(row).toEqual({ request_hash: null, code_hash: null, code_attempts: 0, locale: null });

      expect(await store.consumeCode('', '', NOW)).toBeNull();
      expect(await store.consumeToken('letter-token', NOW)).toEqual(['donor-1']);
    });
  });
});
