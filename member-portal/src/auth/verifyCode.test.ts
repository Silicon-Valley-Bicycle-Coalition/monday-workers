import { describe, it, expect, vi } from 'vitest';
import { verifyCode, MAX_CODE_ATTEMPTS } from './verifyCode';
import { sha256Hex } from '../crypto/hash';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { CodeFailureStore } from '../db/codeFailures';
import type { SessionStore } from '../db/sessions';

const now = () => new Date('2026-08-22T12:00:00.000Z');
const REQUEST_ID = 'req-1';
const CODE = '123456';
const EMAIL_HASH = 'e'.repeat(64);

async function setup(opts: { attempt?: boolean; failures?: number; claim?: boolean } = {}) {
  const codeHash = await sha256Hex(`${REQUEST_ID}:${CODE}`);
  const tokenStore: MagicLinkTokenStore = {
    createToken: vi.fn(),
    consumeToken: vi.fn(),
    takeCodeAttempt: vi.fn().mockResolvedValue(opts.attempt === false ? null : { codeHash, emailHash: EMAIL_HASH }),
    claimByRequest: vi.fn().mockResolvedValue(opts.claim === false ? null : { donorItemIds: ['d1'], emailHash: EMAIL_HASH }),
  };
  const codeFailureStore: CodeFailureStore = {
    recordFailure: vi.fn().mockResolvedValue(undefined),
    countSince: vi.fn().mockResolvedValue(opts.failures ?? 0),
  };
  const sessionStore: SessionStore = { createSession: vi.fn().mockResolvedValue(undefined), getSession: vi.fn(), deleteSession: vi.fn() };
  const verifiedEmailStore = { recordVerified: vi.fn().mockResolvedValue(undefined) };
  const deps = { tokenStore, codeFailureStore, sessionStore, verifiedEmailStore, sessionTtlHours: 24, codeFailuresPerAddressDaily: 10, now };
  return { deps, tokenStore, codeFailureStore, sessionStore };
}

describe('verifyCode', () => {
  it('returns null and records no failure when there is no usable row', async () => {
    const s = await setup({ attempt: false });
    expect(await verifyCode(REQUEST_ID, CODE, s.deps)).toBeNull();
    expect(s.codeFailureStore.recordFailure).not.toHaveBeenCalled();
    expect(s.tokenStore.claimByRequest).not.toHaveBeenCalled();
  });

  it('counts the attempt against MAX_CODE_ATTEMPTS by request hash', async () => {
    const s = await setup();
    await verifyCode(REQUEST_ID, CODE, s.deps);
    expect(s.tokenStore.takeCodeAttempt).toHaveBeenCalledWith(await sha256Hex(REQUEST_ID), '2026-08-22T12:00:00.000Z', MAX_CODE_ATTEMPTS);
    expect(MAX_CODE_ATTEMPTS).toBe(5);
  });

  it('refuses when the address has 10 failures in the last 24 hours, even with the right code', async () => {
    const s = await setup({ failures: 10 });
    expect(await verifyCode(REQUEST_ID, CODE, s.deps)).toBeNull();
    expect(s.codeFailureStore.countSince).toHaveBeenCalledWith(EMAIL_HASH, '2026-08-21T12:00:00.000Z');
    expect(s.tokenStore.claimByRequest).not.toHaveBeenCalled();
  });

  it('records one failure for a wrong code', async () => {
    const s = await setup();
    expect(await verifyCode(REQUEST_ID, '000000', s.deps)).toBeNull();
    expect(s.codeFailureStore.recordFailure).toHaveBeenCalledTimes(1);
    expect(s.codeFailureStore.recordFailure).toHaveBeenCalledWith(EMAIL_HASH, '2026-08-22T12:00:00.000Z');
    expect(s.tokenStore.claimByRequest).not.toHaveBeenCalled();
  });

  it('claims the row and starts a session for the right code', async () => {
    const s = await setup();
    const token = await verifyCode(REQUEST_ID, CODE, s.deps);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(s.tokenStore.claimByRequest).toHaveBeenCalledWith(await sha256Hex(REQUEST_ID), '2026-08-22T12:00:00.000Z');
    expect(s.sessionStore.createSession).toHaveBeenCalledTimes(1);
  });

  it('returns null when the link already claimed the row', async () => {
    const s = await setup({ claim: false });
    expect(await verifyCode(REQUEST_ID, CODE, s.deps)).toBeNull();
    expect(s.sessionStore.createSession).not.toHaveBeenCalled();
  });

  it('refuses the 6th try even with the right code (store reports no attempt left)', async () => {
    const s = await setup();
    (s.tokenStore.takeCodeAttempt as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null);
    expect(await verifyCode(REQUEST_ID, CODE, s.deps)).toBeNull();
  });
});
