import type { MagicLinkTokenStore } from '../db/tokens';
import type { CodeFailureStore } from '../db/codeFailures';
import { sha256Hex } from '../crypto/hash';
import { secretsMatch } from '../crypto/secretsMatch';
import { startSession, type StartSessionDeps } from './session';

// Tries one request's code may take, right or wrong.
export const MAX_CODE_ATTEMPTS = 5;

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

  const attempt = await deps.tokenStore.takeCodeAttempt(requestHash, nowISO, MAX_CODE_ATTEMPTS);
  if (attempt === null) {
    return null;
  }

  // Reserve a slot in the address's daily failure budget before comparing, in one statement, so
  // parallel guesses can't all pass a count first. A wrong guess keeps its slot; a right one gives it back.
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const slot = await deps.codeFailureStore.reserveFailure(attempt.emailHash, nowISO, since, deps.codeFailuresPerAddressDaily);
  if (slot === null) {
    return null;
  }

  if (!(await secretsMatch(await sha256Hex(`${requestId}:${code}`), attempt.codeHash))) {
    return null;
  }
  await deps.codeFailureStore.releaseFailure(slot);

  const consumed = await deps.tokenStore.claimByRequest(requestHash, nowISO);
  if (consumed === null) {
    return null;
  }
  return startSession(consumed, deps);
}
