import type { ChangeRequestStore } from '../db/changeRequests';

export interface PurgeExpiredDeps {
  store: ChangeRequestStore;
  retentionDays: number;
  now: () => Date;
}

// Retention purge: change_requests rows carry donor PII (donor_name, old_value/new_value —
// often addresses, emails, or phone numbers) with no purpose once written to Monday, so
// 'written' rows past retentionDays are deleted outright. 'queued' rows are never touched — see
// D1ChangeRequestStore.purgeWrittenBefore. Returns the number of rows deleted.
export async function purgeExpiredChangeRequests(deps: PurgeExpiredDeps): Promise<number> {
  const dayMs = 24 * 60 * 60 * 1000;
  const cutoffISO = new Date(deps.now().getTime() - deps.retentionDays * dayMs).toISOString();
  return deps.store.purgeWrittenBefore(cutoffISO);
}
