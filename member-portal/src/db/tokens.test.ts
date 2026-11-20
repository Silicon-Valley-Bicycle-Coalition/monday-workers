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
    const CREATED = '2026-08-22T00:00:00.000Z';
    const EXPIRES = '2026-08-22T01:00:00.000Z';
    const NOW = '2026-08-22T00:30:00.000Z';

    interface CodeRow {
      tokenHash: string;
      requestHash: string;
      codeHash: string;
      emailHash?: string;
      expiresAt?: string;
      createdAt?: string;
    }

    async function createCodeRow(store: D1MagicLinkTokenStore, row: CodeRow): Promise<void> {
      await store.createToken({
        donorItemIds: ['donor-1'],
        expiresAt: EXPIRES,
        createdAt: CREATED,
        emailHash: 'email-a',
        locale: 'es',
        ...row,
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

    async function checksFor(emailHash: string): Promise<number> {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM login_code_checks WHERE email_hash = ?1`)
        .bind(emailHash)
        .first<{ n: number }>();
      return row?.n ?? 0;
    }

    it('succeeds once', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, { tokenHash: 'code-once-token', requestHash: 'code-once-req', codeHash: 'code-once-code' });

      expect(await store.consumeCode('code-once-req', 'code-once-code', NOW)).toEqual({
        donorItemIds: ['donor-1'],
        locale: 'es',
      });
      expect(await store.consumeCode('code-once-req', 'code-once-code', NOW)).toBeNull();
    });

    it('burns the link', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, { tokenHash: 'burn-link-token', requestHash: 'burn-link-req', codeHash: 'burn-link-code' });

      expect(await store.consumeCode('burn-link-req', 'burn-link-code', NOW)).not.toBeNull();
      expect(await store.consumeToken('burn-link-token', NOW)).toBeNull();
    });

    it('is burned by consumeToken', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, { tokenHash: 'burn-code-token', requestHash: 'burn-code-req', codeHash: 'burn-code-code' });

      expect(await store.consumeToken('burn-code-token', NOW)).toEqual(['donor-1']);
      expect(await store.consumeCode('burn-code-req', 'burn-code-code', NOW)).toBeNull();
    });

    it('stops after 5 checks', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, { tokenHash: 'cap-token', requestHash: 'cap-req', codeHash: 'cap-code', emailHash: 'cap-email' });

      for (let i = 0; i < 5; i++) {
        expect(await store.consumeCode('cap-req', 'wrong-code', NOW)).toBeNull();
      }
      expect(await store.consumeCode('cap-req', 'cap-code', NOW)).toBeNull();
    });

    // A resend for the same request must not buy fresh guesses at the older code.
    it('keeps the cap across a row created after the checks', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, { tokenHash: 'resend-token-1', requestHash: 'resend-req', codeHash: 'resend-code-1', emailHash: 'resend-email' });
      for (let i = 0; i < 5; i++) {
        await store.consumeCode('resend-req', 'wrong-code', NOW);
      }

      await createCodeRow(store, {
        tokenHash: 'resend-token-2',
        requestHash: 'resend-req',
        codeHash: 'resend-code-2',
        emailHash: 'resend-email',
        createdAt: NOW,
      });

      expect(await attemptsFor('resend-req')).toEqual([5, 5]);
      expect(await store.consumeCode('resend-req', 'resend-code-1', NOW)).toBeNull();
      expect(await store.consumeCode('resend-req', 'resend-code-2', NOW)).toBeNull();
    });

    it('matches any live row for the request', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, { tokenHash: 'multi-token-1', requestHash: 'multi-req', codeHash: 'multi-code-1' });
      await createCodeRow(store, { tokenHash: 'multi-token-2', requestHash: 'multi-req', codeHash: 'multi-code-2' });

      expect(await store.consumeCode('multi-req', 'multi-code-1', NOW)).toEqual({
        donorItemIds: ['donor-1'],
        locale: 'es',
      });
    });

    it('ignores expired rows', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, {
        tokenHash: 'expired-token',
        requestHash: 'expired-req',
        codeHash: 'expired-code',
        expiresAt: '2026-08-22T00:10:00.000Z',
      });

      expect(await store.consumeCode('expired-req', 'expired-code', NOW)).toBeNull();
    });

    it('returns null for an unknown request', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      expect(await store.consumeCode('no-such-req', 'no-such-code', NOW)).toBeNull();
    });

    it('concurrent wrong guesses cannot exceed 5', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, { tokenHash: 'race-token-1', requestHash: 'race-req', codeHash: 'race-code-1', emailHash: 'race-email' });
      await createCodeRow(store, { tokenHash: 'race-token-2', requestHash: 'race-req', codeHash: 'race-code-2', emailHash: 'race-email' });

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

    it('caps an address at 10 checks a day across requests', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      const emailHash = 'daily-email';
      await createCodeRow(store, { tokenHash: 'daily-token-1', requestHash: 'daily-req-1', codeHash: 'daily-code-1', emailHash });
      await createCodeRow(store, { tokenHash: 'daily-token-2', requestHash: 'daily-req-2', codeHash: 'daily-code-2', emailHash });
      await createCodeRow(store, { tokenHash: 'daily-token-3', requestHash: 'daily-req-3', codeHash: 'daily-code-3', emailHash });
      for (let i = 0; i < 5; i++) {
        await store.consumeCode('daily-req-1', 'wrong-code', NOW);
        await store.consumeCode('daily-req-2', 'wrong-code', NOW);
      }
      expect(await checksFor(emailHash)).toBe(10);

      expect(await store.consumeCode('daily-req-3', 'daily-code-3', NOW)).toBeNull();
      expect(await checksFor(emailHash)).toBe(10);

      // The link is not limited by the code budget.
      expect(await store.consumeToken('daily-token-3', NOW)).toEqual(['donor-1']);

      const nextDay = '2026-08-23T00:30:01.000Z';
      await createCodeRow(store, {
        tokenHash: 'daily-token-4',
        requestHash: 'daily-req-4',
        codeHash: 'daily-code-4',
        emailHash,
        createdAt: nextDay,
        expiresAt: '2026-08-23T01:00:00.000Z',
      });
      expect(await store.consumeCode('daily-req-4', 'daily-code-4', nextDay)).toEqual({
        donorItemIds: ['donor-1'],
        locale: 'es',
      });
    });

    it('detaches a request\'s rows for another address when a new address is asked for', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await createCodeRow(store, { tokenHash: 'swap-token-a', requestHash: 'swap-req', codeHash: 'swap-code-a', emailHash: 'swap-email-a' });
      await createCodeRow(store, {
        tokenHash: 'swap-token-b',
        requestHash: 'swap-req',
        codeHash: 'swap-code-b',
        emailHash: 'swap-email-b',
        createdAt: NOW,
      });

      // The old address's code no longer matches, and checking it isn't charged to that address.
      expect(await store.consumeCode('swap-req', 'swap-code-a', NOW)).toBeNull();
      expect(await checksFor('swap-email-a')).toBe(0);
      const detached = await env.DB.prepare(`SELECT request_hash, code_hash, used_at FROM magic_link_tokens WHERE token_hash = ?1`)
        .bind('swap-token-a')
        .first();
      expect(detached).toEqual({ request_hash: null, code_hash: null, used_at: null });

      expect(await store.consumeCode('swap-req', 'swap-code-b', NOW)).not.toBeNull();
      // Its link still works: a household sharing a browser can each use their own link.
      expect(await store.consumeToken('swap-token-a', NOW)).toEqual(['donor-1']);
    });

    it('never matches a row without an email hash', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await store.createToken({
        tokenHash: 'no-email-token',
        donorItemIds: ['donor-1'],
        expiresAt: EXPIRES,
        createdAt: CREATED,
        requestHash: 'no-email-req',
        codeHash: 'no-email-code',
      });

      expect(await store.consumeCode('no-email-req', 'no-email-code', NOW)).toBeNull();
    });

    it('refuses a code row without createdAt', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await expect(
        store.createToken({
          tokenHash: 'no-created-token',
          donorItemIds: ['donor-1'],
          expiresAt: EXPIRES,
          requestHash: 'no-created-req',
          codeHash: 'no-created-code',
          emailHash: 'email-a',
        })
      ).rejects.toThrow();
    });

    // Merging deploys the sandbox before anyone applies 0007 by hand, and production may deploy
    // before it too: a row without a request must still insert on the pre-0007 table.
    it('inserts a row without a request on a table without the 0007 columns', async () => {
      await env.DB.exec(
        'CREATE TABLE IF NOT EXISTS magic_link_tokens_pre0007 (token_hash TEXT PRIMARY KEY, donor_item_ids TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)'
      );
      const store = new D1MagicLinkTokenStore(renamedTable(env.DB, 'magic_link_tokens_pre0007'));

      await store.createToken({ tokenHash: 'pre0007-letter', donorItemIds: ['donor-1'], expiresAt: EXPIRES });
      expect(await store.consumeToken('pre0007-letter', NOW)).toEqual(['donor-1']);

      // A code row does need the migration.
      await expect(
        createCodeRow(store, { tokenHash: 'pre0007-code', requestHash: 'pre0007-req', codeHash: 'pre0007-code', emailHash: 'email-a' })
      ).rejects.toThrow();
    });

    it('never matches a row created without code fields', async () => {
      const store = new D1MagicLinkTokenStore(env.DB);
      await store.createToken({
        tokenHash: 'letter-token',
        donorItemIds: ['donor-1'],
        expiresAt: EXPIRES,
      });

      const row = await env.DB.prepare(
        `SELECT request_hash, code_hash, code_attempts, locale, email_hash FROM magic_link_tokens WHERE token_hash = ?1`
      )
        .bind('letter-token')
        .first();
      expect(row).toEqual({ request_hash: null, code_hash: null, code_attempts: 0, locale: null, email_hash: null });

      expect(await store.consumeCode('', '', NOW)).toBeNull();
      expect(await store.consumeToken('letter-token', NOW)).toEqual(['donor-1']);
    });
  });
});

// The same database with every statement pointed at another table, to run the store's real SQL
// against an older schema.
function renamedTable(db: D1Database, table: string): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => target.prepare(sql.replaceAll('magic_link_tokens', table));
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
