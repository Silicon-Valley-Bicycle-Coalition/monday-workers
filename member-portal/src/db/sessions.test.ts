import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1SessionStore } from './sessions';

describe('D1SessionStore', () => {
  it('creates a session and reads back its donor item ids while unexpired', async () => {
    const store = new D1SessionStore(env.DB);
    await store.createSession({
      sessionHash: 'session-1',
      donorItemIds: ['donor-1', 'donor-2'],
      expiresAt: '2026-08-23T00:00:00.000Z',
      emailHash: 'h1',
    });

    const result = await store.getSession('session-1', '2026-08-22T12:00:00.000Z');
    expect(result).toEqual({ donorItemIds: ['donor-1', 'donor-2'], emailHash: 'h1' });
  });

  it('returns null once the session has expired', async () => {
    const store = new D1SessionStore(env.DB);
    await store.createSession({
      sessionHash: 'session-2',
      donorItemIds: ['donor-3'],
      expiresAt: '2026-08-22T00:00:00.000Z',
      emailHash: null,
    });

    expect(await store.getSession('session-2', '2026-08-23T00:00:00.000Z')).toBeNull();
  });

  it('returns null for an unknown session hash', async () => {
    const store = new D1SessionStore(env.DB);
    expect(await store.getSession('does-not-exist', '2026-08-22T00:00:00.000Z')).toBeNull();
  });

  it('deletes a session so it can no longer be read', async () => {
    const store = new D1SessionStore(env.DB);
    await store.createSession({
      sessionHash: 'session-4',
      donorItemIds: ['donor-4'],
      expiresAt: '2026-08-23T00:00:00.000Z',
      emailHash: null,
    });

    await store.deleteSession('session-4');

    expect(await store.getSession('session-4', '2026-08-22T12:00:00.000Z')).toBeNull();
  });

  it('returns emailHash null for a session created with null', async () => {
    const store = new D1SessionStore(env.DB);
    await store.createSession({ sessionHash: 'session-5', donorItemIds: ['d'], expiresAt: '2026-08-23T00:00:00.000Z', emailHash: null });
    expect(await store.getSession('session-5', '2026-08-22T12:00:00.000Z')).toEqual({ donorItemIds: ['d'], emailHash: null });
  });

  it('returns emailHash null for a row written before migration 0008 set the column', async () => {
    await env.DB.prepare(`INSERT INTO sessions (session_hash, donor_item_ids, expires_at) VALUES (?1, ?2, ?3)`)
      .bind('session-6', JSON.stringify(['d']), '2026-08-23T00:00:00.000Z')
      .run();
    const store = new D1SessionStore(env.DB);
    expect(await store.getSession('session-6', '2026-08-22T12:00:00.000Z')).toEqual({ donorItemIds: ['d'], emailHash: null });
  });
});
