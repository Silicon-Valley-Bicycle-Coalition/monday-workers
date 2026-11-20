import { describe, it, expect, vi } from 'vitest';
import { purgeExpiredChangeRequests } from './purgeExpired';
import type { ChangeRequestStore } from '../db/changeRequests';

function fakeStore(purgedCount: number): ChangeRequestStore {
  return {
    createRequest: vi.fn(),
    hasRecentDuplicate: vi.fn(),
    findRecentByDedupeHash: vi.fn(),
    getRequest: vi.fn(),
    markWritten: vi.fn(),
    hasNewerRequest: vi.fn().mockResolvedValue(false),
    purgeWrittenBefore: vi.fn().mockResolvedValue(purgedCount),
  };
}

describe('purgeExpiredChangeRequests', () => {
  it('purges rows written before now minus retentionDays and returns the count', async () => {
    const store = fakeStore(3);
    const now = () => new Date('2026-08-24T12:00:00.000Z');

    const purged = await purgeExpiredChangeRequests({ store, retentionDays: 180, now });

    expect(store.purgeWrittenBefore).toHaveBeenCalledWith('2026-02-25T12:00:00.000Z'); // now − 180d
    expect(purged).toBe(3);
  });
});
