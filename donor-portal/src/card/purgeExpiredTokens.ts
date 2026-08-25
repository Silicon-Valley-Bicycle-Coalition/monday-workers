import type { CardTokenStore } from '../db/cardTokens';

export interface PurgeExpiredTokensDeps {
  store: CardTokenStore;
  retentionDays: number;
  now: () => Date;
}

// Retention purge: card_tokens rows are bearer credentials for a donor's PII (name, tier,
// status, expiry — see cardViews.ts) with no purpose once revoked, so revoked rows past
// retentionDays are deleted outright. Active rows are never touched — see
// D1CardTokenStore.purgeRevokedBefore. Returns the number of rows deleted.
export async function purgeExpiredCardTokens(deps: PurgeExpiredTokensDeps): Promise<number> {
  const dayMs = 24 * 60 * 60 * 1000;
  const cutoffISO = new Date(deps.now().getTime() - deps.retentionDays * dayMs).toISOString();
  return deps.store.purgeRevokedBefore(cutoffISO);
}
