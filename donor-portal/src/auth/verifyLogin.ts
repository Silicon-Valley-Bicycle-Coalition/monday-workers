import type { MagicLinkTokenStore } from '../db/tokens';
import type { SessionStore } from '../db/sessions';
import { sha256Hex } from '../crypto/hash';
import { generateToken } from '../crypto/token';

export interface VerifyLoginDeps {
  tokenStore: MagicLinkTokenStore;
  sessionStore: SessionStore;
  sessionTtlHours: number;
  now: () => Date;
}

export async function verifyLogin(rawToken: string, deps: VerifyLoginDeps): Promise<string | null> {
  const tokenHash = await sha256Hex(rawToken);
  const now = deps.now();
  const donorItemIds = await deps.tokenStore.consumeToken(tokenHash, now.toISOString());
  if (donorItemIds === null) {
    return null;
  }

  const rawSessionToken = generateToken();
  const sessionHash = await sha256Hex(rawSessionToken);
  const expiresAt = new Date(now.getTime() + deps.sessionTtlHours * 3_600_000).toISOString();

  await deps.sessionStore.createSession({ sessionHash, donorItemIds, expiresAt });

  return rawSessionToken;
}
