import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1LoginAttemptStore } from './loginAttempts';

describe('D1LoginAttemptStore', () => {
  it('counts only attempts recorded after the given cutoff', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    await store.recordAttempt('donor@example.org', '2026-08-22T00:00:00.000Z');
    await store.recordAttempt('donor@example.org', '2026-08-22T00:05:00.000Z');
    await store.recordAttempt('donor@example.org', '2026-08-22T00:20:00.000Z');

    const count = await store.countRecentAttempts('donor@example.org', '2026-08-22T00:04:00.000Z');
    expect(count).toBe(2);
  });

  it('is case-insensitive on email', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    await store.recordAttempt('Mixed.Case@Example.org', '2026-08-22T01:00:00.000Z');

    const count = await store.countRecentAttempts('mixed.case@example.org', '2026-08-22T00:59:00.000Z');
    expect(count).toBe(1);
  });

  it('does not count attempts for a different email', async () => {
    const store = new D1LoginAttemptStore(env.DB);
    await store.recordAttempt('other@example.org', '2026-08-22T02:00:00.000Z');

    const count = await store.countRecentAttempts('nobody@example.org', '2026-08-22T01:59:00.000Z');
    expect(count).toBe(0);
  });
});
