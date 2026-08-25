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
});
