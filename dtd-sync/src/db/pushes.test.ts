import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { getPush, recordPush, recordPushFailure } from './pushes';

beforeEach(async () => { await env.DB.prepare('DELETE FROM pushes').run(); });

describe('pushes', () => {
  it('returns null for an unknown item', async () => {
    expect(await getPush(env.DB, 'm-1')).toBeNull();
  });
  it('recordPush stores a sent row', async () => {
    await recordPush(env.DB, 'm-1', 'd-1', '2026-03-01T00:00:00Z');
    expect(await getPush(env.DB, 'm-1')).toEqual({
      mondayItemId: 'm-1', dtdIdentifier: 'd-1', state: 'sent', attempts: 1, lastError: null, sentAt: '2026-03-01T00:00:00Z',
    });
  });
  it('recordPushFailure increments attempts and redacts emails', async () => {
    await recordPushFailure(env.DB, 'm-1', 'd-1', 'bad donor ada@example.org rejected; cc bob.x+y@mail.example.org');
    let row = await getPush(env.DB, 'm-1');
    expect(row).toMatchObject({ state: 'failed', attempts: 1, sentAt: null });
    expect(row?.lastError).toBe('bad donor [email] rejected; cc [email]');
    await recordPushFailure(env.DB, 'm-1', 'd-1', 'timeout');
    row = await getPush(env.DB, 'm-1');
    expect(row).toMatchObject({ state: 'failed', attempts: 2, lastError: 'timeout' });
  });
  it('recordPush after a failure flips state to sent, clears the error, and counts the attempt', async () => {
    await recordPushFailure(env.DB, 'm-1', 'd-1', 'timeout');
    await recordPush(env.DB, 'm-1', 'd-1', '2026-03-02T00:00:00Z');
    expect(await getPush(env.DB, 'm-1')).toEqual({
      mondayItemId: 'm-1', dtdIdentifier: 'd-1', state: 'sent', attempts: 2, lastError: null, sentAt: '2026-03-02T00:00:00Z',
    });
  });
});
