import type { MagicLinkTokenStore } from '../db/tokens';
import type { SessionStore } from '../db/sessions';
import { sha256Hex } from '../crypto/hash';
import { generateToken } from '../crypto/token';

export interface CreateSessionDeps {
  sessionStore: SessionStore;
  sessionTtlHours: number;
}

export interface VerifyLoginDeps extends CreateSessionDeps {
  tokenStore: MagicLinkTokenStore;
  now: () => Date;
}

// Opens a session for these donor items, starting at `now`, and returns the raw session token for
// the cookie; only its hash is stored. Shared by the emailed link (verifyLogin) and the emailed
// code (POST /auth/code).
export async function createSessionFor(donorItemIds: string[], now: Date, deps: CreateSessionDeps): Promise<string> {
  const rawSessionToken = generateToken();
  const sessionHash = await sha256Hex(rawSessionToken);
  const expiresAt = new Date(now.getTime() + deps.sessionTtlHours * 3_600_000).toISOString();

  await deps.sessionStore.createSession({ sessionHash, donorItemIds, expiresAt });

  return rawSessionToken;
}

export async function verifyLogin(rawToken: string, deps: VerifyLoginDeps): Promise<string | null> {
  const tokenHash = await sha256Hex(rawToken);
  const now = deps.now();
  const donorItemIds = await deps.tokenStore.consumeToken(tokenHash, now.toISOString());
  if (donorItemIds === null) {
    return null;
  }

  return createSessionFor(donorItemIds, now, deps);
}
