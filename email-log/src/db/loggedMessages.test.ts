import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1LoggedMessageStore } from './loggedMessages';

const T0 = '2026-10-20T10:00:00.000Z';
const T1 = '2026-10-20T10:05:00.000Z';

async function row(hash: string) {
  return env.DB.prepare('SELECT * FROM logged_messages WHERE message_id_hash = ?1').bind(hash).first<Record<string, unknown>>();
}

describe('D1LoggedMessageStore', () => {
  it('claim inserts queued and returns true', async () => {
    const store = new D1LoggedMessageStore(env.DB);
    expect(await store.claim('h-1', 'bcc', T0)).toBe(true);
    expect(await row('h-1')).toEqual({
      message_id_hash: 'h-1', kind: 'bcc', status: 'queued', activity_item_id: null, error: null, created_at: T0, logged_at: null,
    });
  });

  it('a second claim returns false', async () => {
    const store = new D1LoggedMessageStore(env.DB);
    expect(await store.claim('h-2', 'forward', T0)).toBe(true);
    expect(await store.claim('h-2', 'forward', T1)).toBe(false);
    expect((await row('h-2'))?.created_at).toBe(T0);
  });

  it('claim re-opens a failed row and returns true', async () => {
    const store = new D1LoggedMessageStore(env.DB);
    await store.claim('h-3', 'bcc', T0);
    await store.markFailed('h-3', 'boom');
    expect(await row('h-3')).toMatchObject({ status: 'failed', error: 'boom' });
    expect(await store.claim('h-3', 'bcc', T1)).toBe(true);
    expect(await row('h-3')).toMatchObject({ status: 'queued', error: null });
  });

  it('claim on a logged row returns false', async () => {
    const store = new D1LoggedMessageStore(env.DB);
    await store.claim('h-4', 'bcc', T0);
    await store.markLogged('h-4', 'item-4', T1);
    expect(await store.claim('h-4', 'bcc', T1)).toBe(false);
    expect(await row('h-4')).toMatchObject({ status: 'logged' });
  });

  it('markLogged sets item id and logged_at', async () => {
    const store = new D1LoggedMessageStore(env.DB);
    await store.claim('h-5', 'bcc', T0);
    await store.markLogged('h-5', 'item-5', T1);
    expect(await row('h-5')).toMatchObject({ status: 'logged', activity_item_id: 'item-5', logged_at: T1, error: null });
  });

  it('markFailed truncates the error to 500 characters', async () => {
    const store = new D1LoggedMessageStore(env.DB);
    await store.claim('h-6', 'bcc', T0);
    await store.markFailed('h-6', 'x'.repeat(900));
    expect(((await row('h-6'))?.error as string).length).toBe(500);
  });

  it('alerts round-trip', async () => {
    const store = new D1LoggedMessageStore(env.DB);
    expect(await store.lastAlertAt('capacity')).toBeNull();
    await store.recordAlert('capacity', T0, 'it-1');
    expect(await store.lastAlertAt('capacity')).toBe(T0);
    await store.recordAlert('capacity', T1, null);
    expect(await store.lastAlertAt('capacity')).toBe(T1);
    expect(await store.lastAlertAt('dead-letter')).toBeNull();
  });
});
