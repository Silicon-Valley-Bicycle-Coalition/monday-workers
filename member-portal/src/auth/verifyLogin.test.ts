import { describe, it, expect, vi } from 'vitest';
import { verifyLogin } from './verifyLogin';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { SessionStore } from '../db/sessions';

const now = () => new Date('2026-08-22T00:00:00.000Z');

describe('verifyLogin', () => {
  it('creates a session covering the token\'s donor item ids and returns a session token', async () => {
    const tokenStore: MagicLinkTokenStore = {
      createToken: vi.fn(),
      consumeToken: vi.fn().mockResolvedValue(['donor-1', 'donor-2']),
      consumeCode: vi.fn(),
    };
    const sessionStore: SessionStore = {
      createSession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    };

    const sessionToken = await verifyLogin('raw-token', { tokenStore, sessionStore, sessionTtlHours: 24, now });

    expect(sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionStore.createSession).toHaveBeenCalledTimes(1);
    const call = (sessionStore.createSession as ReturnType<typeof vi.fn>).mock.calls[0]![0]!;
    expect(call.donorItemIds).toEqual(['donor-1', 'donor-2']);
    expect(call.expiresAt).toBe('2026-08-23T00:00:00.000Z');
    expect(call.sessionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null and creates no session when the token is invalid or already used', async () => {
    const tokenStore: MagicLinkTokenStore = {
      createToken: vi.fn(),
      consumeToken: vi.fn().mockResolvedValue(null),
      consumeCode: vi.fn(),
    };
    const sessionStore: SessionStore = {
      createSession: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    };

    const result = await verifyLogin('bad-token', { tokenStore, sessionStore, sessionTtlHours: 24, now });

    expect(result).toBeNull();
    expect(sessionStore.createSession).not.toHaveBeenCalled();
  });
});
