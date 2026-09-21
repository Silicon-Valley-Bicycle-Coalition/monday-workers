import type { CardTokenStore } from '../db/cardTokens';
import { generateToken } from '../crypto/token';

// Shared by the dashboard's inline card widgets and (eventually) any other card-issuing route.
// Extracted from what used to be a single card-page route's inline logic — the dashboard now
// needs this for every one of a session's donors on every /portal load, not just lazily when a
// dedicated card page was visited.
export async function getOrCreateCardToken(donorItemId: string, store: CardTokenStore, now: () => Date): Promise<string> {
  const existing = await store.getActiveToken(donorItemId);
  if (existing !== null) return existing;

  const token = generateToken();
  try {
    await store.createToken(donorItemId, token, now().toISOString());
    return token;
  } catch (err) {
    // The one-active-token-per-donor DB constraint (migrations/0003) throws here if a concurrent
    // request for the same donor won the race and inserted first. Re-read rather than fail — the
    // other request's token is just as valid. A genuine unrelated D1 outage fails again on this
    // re-read and rethrows, letting the caller decide how to surface it.
    console.error(`member-portal card token insert failed for donor "${donorItemId}", re-reading active token: ${err instanceof Error ? err.message : String(err)}`);
    const reread = await store.getActiveToken(donorItemId);
    if (reread !== null) return reread;
    throw err;
  }
}
