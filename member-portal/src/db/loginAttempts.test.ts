import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1LoginAttemptStore, emailHash } from './loginAttempts';

const limits = { cooldownSeconds: 60, windowSeconds: 900, maxInWindow: 3, maxPerDay: 5 };

function at(base: string, plusSeconds: number): Date {
  return new Date(new Date(base).getTime() + plusSeconds * 1000);
}

async function rowCount(email: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE email_hash = ?1')
    .bind(await emailHash(email))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('D1LoginAttemptStore.tryReserve', () => {
  it('reserves the first send for an address', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    expect(await store.tryReserve('first@example.org', new Date('2026-08-22T00:00:00.000Z'), limits)).toBe(true);
    expect(await rowCount('first@example.org')).toBe(1);
  });

  it('denies a second send inside the cooldown, and records nothing for it', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    const base = '2026-08-22T01:00:00.000Z';
    expect(await store.tryReserve('cool@example.org', at(base, 0), limits)).toBe(true);
    expect(await store.tryReserve('cool@example.org', at(base, 59), limits)).toBe(false);
    expect(await rowCount('cool@example.org')).toBe(1);
    expect(await store.tryReserve('cool@example.org', at(base, 61), limits)).toBe(true);
  });

  it('caps sends per window, and denied requests do not push the window out (issue #62)', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    const base = '2026-08-22T02:00:00.000Z';
    for (const s of [0, 120, 240]) expect(await store.tryReserve('window@example.org', at(base, s), limits)).toBe(true);
    // Rotating IPs keep hammering: every one is denied and none is recorded...
    for (const s of [360, 480, 600, 720, 840]) expect(await store.tryReserve('window@example.org', at(base, s), limits)).toBe(false);
    expect(await rowCount('window@example.org')).toBe(3);
    // ...so the address frees up as soon as the first send ages out of the window.
    expect(await store.tryReserve('window@example.org', at(base, 901), limits)).toBe(true);
  });

  it('caps sends per rolling 24 hours', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    const base = '2026-08-22T03:00:00.000Z';
    // Five sends, each in its own 15-minute window.
    for (let i = 0; i < 5; i++) expect(await store.tryReserve('daily@example.org', at(base, i * 1000), limits)).toBe(true);
    expect(await store.tryReserve('daily@example.org', at(base, 6000), limits)).toBe(false);
    expect(await store.tryReserve('daily@example.org', at(base, 86_401), limits)).toBe(true);
  });

  it('is case-insensitive on email, and budgets each address separately', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    const now = new Date('2026-08-22T04:00:00.000Z');
    expect(await store.tryReserve('Mixed.Case@Example.org', now, limits)).toBe(true);
    expect(await store.tryReserve('mixed.case@example.org', now, limits)).toBe(false);
    expect(await store.tryReserve('someone-else@example.org', now, limits)).toBe(true);
  });

  it('stores a hash, never the address', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    await store.tryReserve('hashed@example.org', new Date('2026-08-22T05:00:00.000Z'), limits);
    const rows = await env.DB.prepare('SELECT * FROM login_attempts').all<Record<string, unknown>>();
    for (const row of rows.results) {
      expect(JSON.stringify(row)).not.toContain('@');
    }
    expect(await rowCount('hashed@example.org')).toBe(1);
  });

  it('lets only one of a burst of concurrent requests through the cooldown', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    const now = new Date('2026-08-22T06:00:00.000Z');
    const results = await Promise.all(Array.from({ length: 10 }, () => store.tryReserve('burst@example.org', now, limits)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await rowCount('burst@example.org')).toBe(1);
  });
});
