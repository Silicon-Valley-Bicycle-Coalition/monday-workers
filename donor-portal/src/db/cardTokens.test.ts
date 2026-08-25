import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1CardTokenStore } from './cardTokens';

describe('D1CardTokenStore', () => {
  it('creates a token and finds its donor id while active', async () => {
    const store = new D1CardTokenStore(env.DB);
    await store.createToken('donor-1', 'token-a', '2026-08-24T10:00:00.000Z');

    expect(await store.findActiveDonorId('token-a')).toBe('donor-1');
  });

  it('returns null for an unknown token', async () => {
    const store = new D1CardTokenStore(env.DB);
    expect(await store.findActiveDonorId('no-such-token')).toBeNull();
  });

  it('returns the active token for a donor, or null if none exists', async () => {
    const store = new D1CardTokenStore(env.DB);
    expect(await store.getActiveToken('donor-2')).toBeNull();

    await store.createToken('donor-2', 'token-b', '2026-08-24T10:00:00.000Z');
    expect(await store.getActiveToken('donor-2')).toBe('token-b');
  });

  it('stops a token from resolving once revoked, for both lookup directions', async () => {
    const store = new D1CardTokenStore(env.DB);
    await store.createToken('donor-3', 'token-c', '2026-08-24T10:00:00.000Z');

    await store.revokeAllForDonor('donor-3', '2026-08-24T11:00:00.000Z');

    expect(await store.findActiveDonorId('token-c')).toBeNull();
    expect(await store.getActiveToken('donor-3')).toBeNull();
  });

  it('lets a donor get a fresh active token after revocation', async () => {
    const store = new D1CardTokenStore(env.DB);
    await store.createToken('donor-4', 'token-old', '2026-08-24T10:00:00.000Z');
    await store.revokeAllForDonor('donor-4', '2026-08-24T11:00:00.000Z');
    await store.createToken('donor-4', 'token-new', '2026-08-24T11:00:01.000Z');

    expect(await store.getActiveToken('donor-4')).toBe('token-new');
    expect(await store.findActiveDonorId('token-old')).toBeNull();
    expect(await store.findActiveDonorId('token-new')).toBe('donor-4');
  });

  it('rejects a second active token for the same donor (one-active-token-per-donor DB constraint)', async () => {
    const store = new D1CardTokenStore(env.DB);
    await store.createToken('donor-5', 'token-first', '2026-08-24T10:00:00.000Z');

    await expect(store.createToken('donor-5', 'token-second', '2026-08-24T10:00:01.000Z')).rejects.toThrow();

    // The first token is still the one and only active token — the rejected insert didn't
    // leave a partial/second row behind.
    expect(await store.getActiveToken('donor-5')).toBe('token-first');
  });

  it('purges revoked rows before the cutoff and returns the count deleted', async () => {
    const store = new D1CardTokenStore(env.DB);
    await store.createToken('donor-6', 'token-old', '2026-01-01T10:00:00.000Z');
    await store.revokeAllForDonor('donor-6', '2026-01-01T11:00:00.000Z');
    await store.createToken('donor-6', 'token-new', '2026-08-24T10:00:00.000Z');

    const purged = await store.purgeRevokedBefore('2026-06-01T00:00:00.000Z');

    expect(purged).toBe(1);
    expect(await store.findActiveDonorId('token-old')).toBeNull();
    // The purged row is gone, not just inactive — recreating it (same token value) must not
    // collide with a leftover row.
    await store.revokeAllForDonor('donor-6', '2026-08-24T11:00:00.000Z');
    await store.createToken('donor-6', 'token-old', '2026-08-24T11:00:01.000Z');
    expect(await store.getActiveToken('donor-6')).toBe('token-old');
  });

  it('leaves active (non-revoked) rows alone regardless of age', async () => {
    const store = new D1CardTokenStore(env.DB);
    await store.createToken('donor-7', 'token-ancient', '2020-01-01T00:00:00.000Z');

    const purged = await store.purgeRevokedBefore('2026-08-24T00:00:00.000Z');

    expect(purged).toBe(0);
    expect(await store.getActiveToken('donor-7')).toBe('token-ancient');
  });
});
