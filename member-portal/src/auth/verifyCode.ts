import type { MagicLinkTokenStore } from '../db/tokens';
import type { CodeFailureStore } from '../db/codeFailures';
import { sha256Hex } from '../crypto/hash';
import { secretsMatch } from '../crypto/secretsMatch';
import { startSession, type StartSessionDeps } from './session';

// Tries one request's code may take, right or wrong.
export const MAX_CODE_ATTEMPTS = 5;

// Not hex, so it never equals a code hash.
const NO_CODE = 'no-code';

export interface VerifyCodeDeps extends StartSessionDeps {
  tokenStore: MagicLinkTokenStore;
  codeFailureStore: CodeFailureStore;
  codeFailuresPerAddressDaily: number;
}

// requestId is the raw id the sign-in form carried; null for anything that isn't a live, matching
// code (the caller shows one generic error either way).
export async function verifyCode(requestId: string, code: string, deps: VerifyCodeDeps): Promise<string | null> {
  const now = deps.now();
  const nowISO = now.toISOString();
  const requestHash = await sha256Hex(requestId);

  // Uniform shape (the enumeration guard): whether or not the request matched a donor, this is one
  // D1 round trip and the presented code is hashed and compared. A request that matched no donor
  // has no row, so without this its refusal would come back measurably faster, telling anyone who
  // requested a code for an address from their own browser whether that address is on file.
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const attempt = await deps.tokenStore.takeCodeAttempt(requestHash, nowISO, MAX_CODE_ATTEMPTS, {
    sinceISO: since,
    max: deps.codeFailuresPerAddressDaily,
  });
  const presented = await sha256Hex(`${requestId}:${code}`);
  // With no row, or the address's failure budget spent, compare against a value no hash can equal:
  // the real code is never checked, but the work matches a checked one.
  const usable = attempt !== null && attempt.failureSlot !== null;
  const matched = await secretsMatch(presented, usable ? attempt.codeHash : NO_CODE);
  if (!usable || !matched) {
    return null;
  }
  // A wrong guess kept the slot the store reserved; a right one gives it back.
  await deps.codeFailureStore.releaseFailure(attempt.failureSlot!);

  const consumed = await deps.tokenStore.claimByRequest(requestHash, nowISO);
  if (consumed === null) {
    return null;
  }
  return startSession(consumed, deps);
}
