import { describe, it, expect, vi } from 'vitest';
import { purgeExpiredAuthRows } from './purgeExpiredAuth';
import type { AuthRetentionStore } from '../db/authRetention';

function fakeStore(overrides: Partial<AuthRetentionStore> = {}): AuthRetentionStore {
  return {
    purgeLoginAttemptsBefore: vi.fn().mockResolvedValue(3),
    purgeSessionsExpiredBefore: vi.fn().mockResolvedValue(2),
    purgeMagicLinkTokensExpiredBefore: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

const now = () => new Date('2026-08-24T12:00:00.000Z');

describe('purgeExpiredAuthRows', () => {
  it('purges login attempts past retention and sessions/tokens past expiry', async () => {
    const store = fakeStore();

    const result = await purgeExpiredAuthRows({ store, attemptRetentionHours: 24, now });

    expect(store.purgeLoginAttemptsBefore).toHaveBeenCalledWith('2026-08-23T12:00:00.000Z');
    expect(store.purgeSessionsExpiredBefore).toHaveBeenCalledWith('2026-08-24T12:00:00.000Z');
    expect(store.purgeMagicLinkTokensExpiredBefore).toHaveBeenCalledWith('2026-08-24T12:00:00.000Z');
    expect(result).toEqual({ loginAttempts: 3, sessions: 2, magicLinkTokens: 1 });
  });

  // Runs inside scheduled() ahead of the letter cron: one table's D1 error must not skip the
  // others (or the letter cron after it).
  it('keeps going when one purge fails, reporting that table as null', async () => {
    const store = fakeStore({ purgeSessionsExpiredBefore: vi.fn().mockRejectedValue(new Error('D1 down')) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await purgeExpiredAuthRows({ store, attemptRetentionHours: 24, now });

    expect(result).toEqual({ loginAttempts: 3, sessions: null, magicLinkTokens: 1 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sessions'));
    errorSpy.mockRestore();
  });
});
