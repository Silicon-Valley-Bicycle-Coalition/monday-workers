// D1 side of the nightly job (#53): the phone_index table, and the unmatched rows it rematches or
// expires. Every method here writes only D1.

export interface IndexEntry {
  e164: string;
  itemId: string;
}

export interface PhoneIndexStore {
  /** Replaces the whole index in one transaction: a failed rebuild leaves the old one intact. */
  replaceIndex(entries: IndexEntry[]): Promise<void>;
  /** Unmatched events at or after `since` whose number is now in the index. */
  rematchCandidates(since: string): Promise<string[]>;
  /** Marks rematched events pending and enqueued, so the consumer picks them up as new. */
  markRematched(eventIds: string[], at: string): Promise<void>;
  /** Deletes unmatched events (and so their numbers) that occurred before `before`. */
  deleteExpiredUnmatched(before: string): Promise<number>;
}

// D1 allows 100 bound parameters per statement: 50 rows of (e164, item_id).
const ROWS_PER_INSERT = 50;
// Bound ids per IN (...) list, under the same limit with room for the other parameters.
const IDS_PER_UPDATE = 90;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class D1PhoneIndexStore implements PhoneIndexStore {
  constructor(private readonly db: D1Database) {}

  async replaceIndex(entries: IndexEntry[]): Promise<void> {
    // db.batch runs as one transaction: the delete and every insert commit together or not at all.
    const statements: D1PreparedStatement[] = [this.db.prepare('DELETE FROM phone_index')];
    for (const chunk of chunks(entries, ROWS_PER_INSERT)) {
      const placeholders = chunk.map(() => '(?, ?)').join(', ');
      statements.push(
        this.db
          .prepare(`INSERT OR IGNORE INTO phone_index (e164, item_id) VALUES ${placeholders}`)
          .bind(...chunk.flatMap((e) => [e.e164, e.itemId])),
      );
    }
    await this.db.batch(statements);
  }

  async rematchCandidates(since: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT event_id FROM phone_events
         WHERE status = 'unmatched' AND occurred_at >= ?
           AND external_e164 IN (SELECT e164 FROM phone_index)
         ORDER BY occurred_at`,
      )
      .bind(since)
      .all<{ event_id: string }>();
    return results.map((r) => r.event_id);
  }

  async markRematched(eventIds: string[], at: string): Promise<void> {
    const statements = chunks(eventIds, IDS_PER_UPDATE).map((ids) =>
      this.db
        .prepare(
          `UPDATE phone_events SET status = 'pending', enqueued_at = ?
           WHERE status = 'unmatched' AND event_id IN (${ids.map(() => '?').join(', ')})`,
        )
        .bind(at, ...ids),
    );
    if (statements.length > 0) await this.db.batch(statements);
  }

  async deleteExpiredUnmatched(before: string): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM phone_events WHERE status = 'unmatched' AND occurred_at < ?`)
      .bind(before)
      .run();
    return result.meta.changes;
  }
}
