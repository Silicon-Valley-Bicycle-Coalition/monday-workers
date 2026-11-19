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

  // The per-address failure budget each takeCodeAttempt call below is given: wide unless a test
  // is about the budget.
  const SINCE = '2026-08-21T00:30:00.000Z';
  const BUDGET = { sinceISO: SINCE, max: 100 };

  async function failureRows(emailHash: string): Promise<number> {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM code_failures WHERE email_hash = ?1').bind(emailHash).first<{ n: number }>();
    return row!.n;
  }

  it('takeCodeAttempt returns the hashes and a failure slot, and allows exactly 5 tries', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-att', 'req-att');
    for (let i = 0; i < 5; i++) {
      expect(await store.takeCodeAttempt('req-att', NOW, 5, BUDGET)).toEqual({
        codeHash: 'code-tok-att',
        emailHash: 'email-tok-att',
        failureSlot: expect.any(Number),
      });
    }
    expect(await store.takeCodeAttempt('req-att', NOW, 5, BUDGET)).toBeNull();
    expect(await failureRows('email-tok-att')).toBe(5);
  });

  it('takeCodeAttempt reserves no failure slot for a row already at the attempt cap', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-capped', 'req-capped');
    for (let i = 0; i < 2; i++) await store.takeCodeAttempt('req-capped', NOW, 2, BUDGET);
    expect(await failureRows('email-tok-capped')).toBe(2);

    expect(await store.takeCodeAttempt('req-capped', NOW, 2, BUDGET)).toBeNull();
    expect(await failureRows('email-tok-capped')).toBe(2);
  });

  it('takeCodeAttempt reserves no failure slot for an expired, used, code-less or unknown row', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-nos-exp', 'req-nos-exp', { expiresAt: '2026-08-22T00:00:00.000Z' });
    await codeRow(store, 'tok-nos-used', 'req-nos-used');
    await store.consumeToken('tok-nos-used', NOW);
    for (const req of ['req-nos-exp', 'req-nos-used', 'req-nos-unknown']) {
      expect(await store.takeCodeAttempt(req, NOW, 5, BUDGET)).toBeNull();
    }
    expect(await failureRows('email-tok-nos-exp')).toBe(0);
    expect(await failureRows('email-tok-nos-used')).toBe(0);
  });

  it('takeCodeAttempt still counts the try but reserves no slot once the address budget is spent', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-bud-a', 'req-bud-a', { emailHash: 'email-bud' });
    await codeRow(store, 'tok-bud-b', 'req-bud-b', { emailHash: 'email-bud' });
    const budget = { sinceISO: SINCE, max: 2 };
    expect((await store.takeCodeAttempt('req-bud-a', NOW, 5, budget))?.failureSlot).not.toBeNull();
    expect((await store.takeCodeAttempt('req-bud-a', NOW, 5, budget))?.failureSlot).not.toBeNull();
    // Another request for the same address shares the budget.
    expect(await store.takeCodeAttempt('req-bud-b', NOW, 5, budget)).toEqual({ codeHash: 'code-tok-bud-b', emailHash: 'email-bud', failureSlot: null });
    expect(await failureRows('email-bud')).toBe(2);
    // The refused try still counted against the request: 4 more reach its cap of 5.
    for (let i = 0; i < 4; i++) expect(await store.takeCodeAttempt('req-bud-b', NOW, 5, budget)).not.toBeNull();
    expect(await store.takeCodeAttempt('req-bud-b', NOW, 5, budget)).toBeNull();
  });

  it('takeCodeAttempt counts only that address and only failures at or after the cutoff', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-win-old', 'req-win-old', { emailHash: 'email-win' });
    await codeRow(store, 'tok-win', 'req-win', { emailHash: 'email-win' });
    await codeRow(store, 'tok-win-other', 'req-win-other', { emailHash: 'email-win-other' });
    // One failure from before the window.
    await store.takeCodeAttempt('req-win-old', '2026-08-21T00:00:00.000Z', 5, BUDGET);
    await store.takeCodeAttempt('req-win-other', NOW, 5, BUDGET);

    const budget = { sinceISO: SINCE, max: 1 };
    expect((await store.takeCodeAttempt('req-win', NOW, 5, budget))?.failureSlot).not.toBeNull();
    expect((await store.takeCodeAttempt('req-win', NOW, 5, budget))?.failureSlot).toBeNull();
  });

  it('takeCodeAttempt grants exactly max failure slots when tries race', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    // Three requests for one address: 15 tries in all, none over the per-request cap of 5.
    for (const n of [1, 2, 3]) await codeRow(store, `tok-race-${n}`, `req-race-${n}`, { emailHash: 'email-race' });
    const tries = [1, 2, 3].flatMap((n) => Array.from({ length: 5 }, () => store.takeCodeAttempt(`req-race-${n}`, NOW, 5, { sinceISO: SINCE, max: 10 })));
    const results = await Promise.all(tries);
    const slots = results.map((r) => r?.failureSlot ?? null).filter((id) => id !== null);
    expect(results.every((r) => r !== null)).toBe(true);
    expect(slots).toHaveLength(10);
    expect(new Set(slots).size).toBe(10);
    expect(await failureRows('email-race')).toBe(10);
  });

  it('takeCodeAttempt allows exactly maxAttempts tries when they race on one request', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-race1', 'req-race1');
    const results = await Promise.all(Array.from({ length: 12 }, () => store.takeCodeAttempt('req-race1', NOW, 5, BUDGET)));
    expect(results.filter((r) => r !== null)).toHaveLength(5);
    expect(await failureRows('email-tok-race1')).toBe(5);
  });

  it('takeCodeAttempt returns null for an expired, used, code-less, address-less or unknown row', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-exp', 'req-exp', { expiresAt: '2026-08-22T00:00:00.000Z' });
    await codeRow(store, 'tok-used', 'req-used');
    await store.consumeToken('tok-used', NOW);
    await store.createToken({ tokenHash: 'tok-nocode', donorItemIds: ['d'], expiresAt: FUTURE, requestHash: 'req-nocode' });
    expect(await store.takeCodeAttempt('req-exp', NOW, 5, BUDGET)).toBeNull();
    expect(await store.takeCodeAttempt('req-used', NOW, 5, BUDGET)).toBeNull();
    expect(await store.takeCodeAttempt('req-nocode', NOW, 5, BUDGET)).toBeNull();
    await store.createToken({ tokenHash: 'tok-noemail', donorItemIds: ['d'], expiresAt: FUTURE, requestHash: 'req-noemail', codeHash: 'c' });
    expect(await store.takeCodeAttempt('req-noemail', NOW, 5, BUDGET)).toBeNull();
    expect(await store.takeCodeAttempt('req-unknown', NOW, 5, BUDGET)).toBeNull();
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
    expect(await store.takeCodeAttempt('req-after', NOW, 5, BUDGET)).toBeNull();
  });

  it('keeps rows with different request hashes separate', async () => {
    const store = new D1MagicLinkTokenStore(env.DB);
    await codeRow(store, 'tok-sep-a', 'req-sep-a');
    await codeRow(store, 'tok-sep-b', 'req-sep-b');
    expect((await store.takeCodeAttempt('req-sep-a', NOW, 5, BUDGET))?.codeHash).toBe('code-tok-sep-a');
    expect((await store.claimByRequest('req-sep-b', NOW))?.emailHash).toBe('email-tok-sep-b');
    expect(await store.claimByRequest('req-sep-a', NOW)).not.toBeNull();
  });
});
