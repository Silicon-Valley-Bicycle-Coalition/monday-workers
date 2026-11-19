import type { MagicLinkTokenStore } from '../db/tokens';
import { sha256Hex } from '../crypto/hash';
import { startSession, type StartSessionDeps } from './session';

export interface VerifyLoginDeps extends StartSessionDeps {
  tokenStore: MagicLinkTokenStore;
}

export async function verifyLogin(rawToken: string, deps: VerifyLoginDeps): Promise<string | null> {
  const tokenHash = await sha256Hex(rawToken);
  const consumed = await deps.tokenStore.consumeToken(tokenHash, deps.now().toISOString());
  if (consumed === null) {
    return null;
  }
  return startSession(consumed, deps);
}
