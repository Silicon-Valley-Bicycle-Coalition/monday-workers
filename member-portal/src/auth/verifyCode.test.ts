import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyCode, MAX_CODE_ATTEMPTS } from './verifyCode';
import { sha256Hex } from '../crypto/hash';
import * as hash from '../crypto/hash';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { CodeFailureStore } from '../db/codeFailures';
import type { SessionStore } from '../db/sessions';

const now = () => new Date('2026-08-22T12:00:00.000Z');
const REQUEST_ID = 'req-1';
const CODE = '123456';
const EMAIL_HASH = 'e'.repeat(64);

// attempt: false = no usable row; failures >= 10 = the address's budget is spent (no slot).
async function setup(opts: { attempt?: boolean; failures?: number; claim?: boolean } = {}) {
  const codeHash = await sha256Hex(`${REQUEST_ID}:${CODE}`);
  const failureSlot = (opts.failures ?? 0) >= 10 ? null : 77;
  const tokenStore: MagicLinkTokenStore = {
    createToken: vi.fn(),
    consumeToken: vi.fn(),
    takeCodeAttempt: vi.fn().mockResolvedValue(opts.attempt === false ? null : { codeHash, emailHash: EMAIL_HASH, failureSlot }),
    claimByRequest: vi.fn().mockResolvedValue(opts.claim === false ? null : { donorItemIds: ['d1'], emailHash: EMAIL_HASH, orgGrants: [] }),
  };
  const codeFailureStore: CodeFailureStore = { releaseFailure: vi.fn().mockResolvedValue(undefined) };
  const sessionStore: SessionStore = { createSession: vi.fn().mockResolvedValue(undefined), getSession: vi.fn(), deleteSession: vi.fn() };
  const verifiedEmailStore = { recordVerified: vi.fn().mockResolvedValue(undefined) };
  const deps = { tokenStore, codeFailureStore, sessionStore, verifiedEmailStore, sessionTtlHours: 24, codeFailuresPerAddressDaily: 10, now };
  return { deps, tokenStore, codeFailureStore, sessionStore };
}

afterEach(() => vi.restoreAllMocks());

describe('verifyCode', () => {
  it('returns null and claims nothing when there is no usable row (unknown, expired, used, or out of tries)', async () => {
    const s = await setup({ attempt: false });
    expect(await verifyCode(REQUEST_ID, CODE, s.deps)).toBeNull();
    expect(s.codeFailureStore.releaseFailure).not.toHaveBeenCalled();
    expect(s.tokenStore.claimByRequest).not.toHaveBeenCalled();
  });

  it('counts the attempt and reserves a failure slot in one store call', async () => {
    const s = await setup();
    await verifyCode(REQUEST_ID, CODE, s.deps);
    expect(s.tokenStore.takeCodeAttempt).toHaveBeenCalledTimes(1);
    expect(s.tokenStore.takeCodeAttempt).toHaveBeenCalledWith(await sha256Hex(REQUEST_ID), '2026-08-22T12:00:00.000Z', MAX_CODE_ATTEMPTS, {
      sinceISO: '2026-08-21T12:00:00.000Z',
      max: 10,
    });
    expect(MAX_CODE_ATTEMPTS).toBe(5);
  });

  // The enumeration guard: a request that matched no donor has no row, and must cost the same as one
  // that did — one store call and the presented code's hash either way.
  it('hashes the presented code whether or not the request has a row', async () => {
    for (const attempt of [true, false]) {
      const s = await setup({ attempt });
      const spy = vi.spyOn(hash, 'sha256Hex');
      await verifyCode(REQUEST_ID, '000000', s.deps);
      expect(spy).toHaveBeenCalledWith(`${REQUEST_ID}:000000`);
      expect(s.tokenStore.takeCodeAttempt).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    }
  });

  it('refuses when the address has 10 failures in the last 24 hours, even with the right code', async () => {
    const s = await setup({ failures: 10 });
    expect(await verifyCode(REQUEST_ID, CODE, s.deps)).toBeNull();
    expect(s.codeFailureStore.releaseFailure).not.toHaveBeenCalled();
    expect(s.tokenStore.claimByRequest).not.toHaveBeenCalled();
    expect(s.sessionStore.createSession).not.toHaveBeenCalled();
  });

  it('keeps its reserved slot for a wrong code', async () => {
    const s = await setup();
    expect(await verifyCode(REQUEST_ID, '000000', s.deps)).toBeNull();
    expect(s.codeFailureStore.releaseFailure).not.toHaveBeenCalled();
    expect(s.tokenStore.claimByRequest).not.toHaveBeenCalled();
  });

  it('releases its slot, claims the row and starts a session for the right code', async () => {
    const s = await setup();
    const token = await verifyCode(REQUEST_ID, CODE, s.deps);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(s.codeFailureStore.releaseFailure).toHaveBeenCalledWith(77);
    expect(s.tokenStore.claimByRequest).toHaveBeenCalledWith(await sha256Hex(REQUEST_ID), '2026-08-22T12:00:00.000Z');
    expect(s.sessionStore.createSession).toHaveBeenCalledTimes(1);
  });

  it('returns null when the link already claimed the row', async () => {
    const s = await setup({ claim: false });
    expect(await verifyCode(REQUEST_ID, CODE, s.deps)).toBeNull();
    expect(s.sessionStore.createSession).not.toHaveBeenCalled();
  });
});
