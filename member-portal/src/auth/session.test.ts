import { describe, it, expect, vi } from 'vitest';
import { startSession } from './session';
import type { SessionStore } from '../db/sessions';
import type { VerifiedEmailStore } from '../db/verifiedEmails';

const now = () => new Date('2026-08-22T00:00:00.000Z');

function deps(recordVerified = vi.fn().mockResolvedValue(undefined)) {
  const sessionStore: SessionStore = { createSession: vi.fn().mockResolvedValue(undefined), getSession: vi.fn(), deleteSession: vi.fn() };
  const verifiedEmailStore: VerifiedEmailStore = { recordVerified };
  return { sessionStore, verifiedEmailStore, sessionTtlHours: 24, now };
}

describe('startSession', () => {
  it('creates a session for the donor ids and returns its raw token', async () => {
    const d = deps();
    const token = await startSession({ donorItemIds: ['a', 'b'], emailHash: null }, d);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const call = (d.sessionStore.createSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.donorItemIds).toEqual(['a', 'b']);
    expect(call.emailHash).toBeNull();
    expect(call.expiresAt).toBe('2026-08-23T00:00:00.000Z');
  });

  it('records the verified address when the token carries an emailHash', async () => {
    const recordVerified = vi.fn().mockResolvedValue(undefined);
    await startSession({ donorItemIds: ['a'], emailHash: 'h'.repeat(64) }, deps(recordVerified));
    expect(recordVerified).toHaveBeenCalledWith('h'.repeat(64), ['a'], '2026-08-22T00:00:00.000Z');
  });

  it('passes the consumed emailHash into createSession', async () => {
    const d = deps();
    await startSession({ donorItemIds: ['a'], emailHash: 'h'.repeat(64) }, d);
    const call = (d.sessionStore.createSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.emailHash).toBe('h'.repeat(64));
  });

  it('does not record anything when emailHash is null', async () => {
    const recordVerified = vi.fn();
    await startSession({ donorItemIds: ['a'], emailHash: null }, deps(recordVerified));
    expect(recordVerified).not.toHaveBeenCalled();
  });

  it('logs and still returns the session token when recordVerified throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = await startSession({ donorItemIds: ['a'], emailHash: 'h' }, deps(vi.fn().mockRejectedValue(new Error('d1 down'))));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
