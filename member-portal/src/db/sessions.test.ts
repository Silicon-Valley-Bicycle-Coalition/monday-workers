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
    });

    const result = await store.getSession('session-1', '2026-08-22T12:00:00.000Z');
    expect(result).toEqual(['donor-1', 'donor-2']);
  });

  it('returns null once the session has expired', async () => {
    const store = new D1SessionStore(env.DB);
    await store.createSession({
      sessionHash: 'session-2',
      donorItemIds: ['donor-3'],
      expiresAt: '2026-08-22T00:00:00.000Z',
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
    });

    await store.deleteSession('session-4');

    expect(await store.getSession('session-4', '2026-08-22T12:00:00.000Z')).toBeNull();
  });
});
