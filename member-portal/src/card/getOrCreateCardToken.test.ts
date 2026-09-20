import { describe, it, expect, vi } from 'vitest';
import { getOrCreateCardToken } from './getOrCreateCardToken';
import type { CardTokenStore } from '../db/cardTokens';

function inMemoryCardTokenStore(): CardTokenStore {
  const byDonor = new Map<string, string>();
  return {
    async createToken(donorItemId, token) {
      byDonor.set(donorItemId, token);
    },
    async findActiveDonorId() {
      return null;
    },
    async getActiveToken(donorItemId) {
      return byDonor.get(donorItemId) ?? null;
    },
    async revokeAllForDonor(donorItemId) {
      byDonor.delete(donorItemId);
    },
    async purgeRevokedBefore() {
      return 0;
    },
  };
}

const now = () => new Date('2026-08-25T00:00:00.000Z');

describe('getOrCreateCardToken', () => {
  it('returns the existing active token instead of minting a new one', async () => {
    const store = inMemoryCardTokenStore();
    await store.createToken('donor-1', 'existing-token', now().toISOString());

    const token = await getOrCreateCardToken('donor-1', store, now);
    expect(token).toBe('existing-token');
  });

  it('mints and persists a new token when none exists', async () => {
    const store = inMemoryCardTokenStore();
    const token = await getOrCreateCardToken('donor-1', store, now);
    expect(token).toEqual(expect.any(String));
    expect(await store.getActiveToken('donor-1')).toBe(token);
  });

  it('re-reads instead of throwing when createToken races and loses (unique-constraint style failure)', async () => {
    const store = inMemoryCardTokenStore();
    const createToken = vi.spyOn(store, 'createToken').mockImplementationOnce(async () => {
      // Simulate a concurrent request winning the insert race first.
      await store.createToken('donor-1', 'winner-token', now().toISOString());
      throw new Error('UNIQUE constraint failed');
    });

    const token = await getOrCreateCardToken('donor-1', store, now);
    expect(token).toBe('winner-token');
    createToken.mockRestore();
  });

  it('rethrows when createToken fails and the re-read still finds nothing', async () => {
    const store = inMemoryCardTokenStore();
    vi.spyOn(store, 'createToken').mockRejectedValueOnce(new Error('D1 outage'));

    await expect(getOrCreateCardToken('donor-1', store, now)).rejects.toThrow('D1 outage');
  });
});
