import { describe, it, expect, vi } from 'vitest';
import { purgeExpiredCardTokens } from './purgeExpiredTokens';
import type { CardTokenStore } from '../db/cardTokens';

function fakeStore(purgedCount: number): CardTokenStore {
  return {
    createToken: vi.fn(),
    findActiveDonorId: vi.fn(),
    getActiveToken: vi.fn(),
    revokeAllForDonor: vi.fn(),
    purgeRevokedBefore: vi.fn().mockResolvedValue(purgedCount),
  };
}

describe('purgeExpiredCardTokens', () => {
  it('purges rows revoked before now minus retentionDays and returns the count', async () => {
    const store = fakeStore(2);
    const now = () => new Date('2026-08-24T12:00:00.000Z');

    const purged = await purgeExpiredCardTokens({ store, retentionDays: 30, now });

    expect(store.purgeRevokedBefore).toHaveBeenCalledWith('2026-07-25T12:00:00.000Z'); // now − 30d
    expect(purged).toBe(2);
  });
});
