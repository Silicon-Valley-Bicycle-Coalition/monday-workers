import type { SessionStore } from '../db/sessions';
import type { ConsumedToken } from '../db/tokens';
import type { VerifiedEmailStore } from '../db/verifiedEmails';
import { sha256Hex } from '../crypto/hash';
import { generateToken } from '../crypto/token';
import { errorText } from '../logSafe';

export interface StartSessionDeps {
  sessionStore: SessionStore;
  verifiedEmailStore: Pick<VerifiedEmailStore, 'recordVerified'>;
  sessionTtlHours: number;
  now: () => Date;
}

// Shared by the emailed link and the typed code: opens a session for the claimed token's donors
// and returns the raw session token. A code or link both prove control of the address, so a row
// carrying an emailHash also records the address as verified.
export async function startSession(consumed: ConsumedToken, deps: StartSessionDeps): Promise<string> {
  const now = deps.now();
  const rawSessionToken = generateToken();
  const sessionHash = await sha256Hex(rawSessionToken);
  const expiresAt = new Date(now.getTime() + deps.sessionTtlHours * 3_600_000).toISOString();

  await deps.sessionStore.createSession({
    sessionHash,
    donorItemIds: consumed.donorItemIds,
    expiresAt,
    emailHash: consumed.emailHash,
    orgGrants: consumed.orgGrants,
  });

  if (consumed.emailHash !== null) {
    // A work-email grant proves the address for the Affiliation's person too.
    const verifiedIds = new Set(consumed.donorItemIds);
    for (const grant of consumed.orgGrants) {
      if (grant.via === 'workEmail' && grant.personItemId !== null) verifiedIds.add(grant.personItemId);
    }
    try {
      await deps.verifiedEmailStore.recordVerified(consumed.emailHash, [...verifiedIds], now.toISOString());
    } catch (err) {
      // The donor is signed in; a missed verified-address record must not undo that.
      console.error(`member-portal verified-address record failed: ${errorText(err)}`);
    }
  }

  return rawSessionToken;
}
