// Daily PII retention pass (#68). The consumer re-reads every record from its source on each
// attempt, so qb_events.fetched_payload and monday_events.raw_payload are only ever a record for
// someone inspecting a row: nothing replays them, and emptying one never blocks a redrive.
//
// Rows are emptied, never deleted. They are also the webhook dedupe ledger, and their qb_id and
// pending_monday_item_id are what the create-loop guards read; those ids aren't PII.
//
// A row that never reached 'written' keeps its data longer, for whoever is working the failure.
// Its error is scrubbed along with the payload, because Intuit's fault detail and our own
// "search QuickBooks for <name>" text can name the customer. (Writing a row clears its error.)

export const PURGED_ERROR = 'error text removed after the retention window; redrive the row to see the current error';

export interface RetentionCutoffs {
  writtenBefore: string;
  unresolvedBefore: string;
}

export async function purgeExpiredEventData(
  db: D1Database,
  { writtenBefore, unresolvedBefore }: RetentionCutoffs
): Promise<{ written: number; unresolved: number }> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE qb_events SET fetched_payload = NULL
         WHERE status = 'written' AND written_at < ?1 AND fetched_payload IS NOT NULL`
      )
      .bind(writtenBefore),
    db
      .prepare(
        `UPDATE monday_events SET raw_payload = '{}'
         WHERE status = 'written' AND written_at < ?1 AND raw_payload != '{}'`
      )
      .bind(writtenBefore),
    db
      .prepare(
        `UPDATE qb_events SET fetched_payload = NULL, error = CASE WHEN error IS NULL THEN NULL ELSE ?2 END
         WHERE status != 'written' AND received_at < ?1
           AND (fetched_payload IS NOT NULL OR (error IS NOT NULL AND error != ?2))`
      )
      .bind(unresolvedBefore, PURGED_ERROR),
    db
      .prepare(
        `UPDATE monday_events SET raw_payload = '{}', error = CASE WHEN error IS NULL THEN NULL ELSE ?2 END
         WHERE status != 'written' AND received_at < ?1
           AND (raw_payload != '{}' OR (error IS NOT NULL AND error != ?2))`
      )
      .bind(unresolvedBefore, PURGED_ERROR),
  ]);
  const changes = (i: number) => results[i]!.meta.changes;
  return { written: changes(0) + changes(1), unresolved: changes(2) + changes(3) };
}
