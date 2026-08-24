import type { NormalizedEvent } from '../types';

export interface EventStore {
  replaceSourceEvents(sourceId: string, events: NormalizedEvent[], todayUtc: string): Promise<void>;
  recordSourceSuccess(sourceId: string, nowUtc: string): Promise<void>;
  recordSourceFailure(sourceId: string, errorMessage: string): Promise<number>;
  getFutureEvents(nowUtc: string): Promise<NormalizedEvent[]>;
}

interface D1EventRow {
  id: string;
  source_id: string;
  title: string;
  committee_name: string;
  start_utc: string;
  end_utc: string | null;
  location: string | null;
  url: string | null;
  last_seen_at: string;
}

function toNormalizedEvent(row: D1EventRow): NormalizedEvent {
  return {
    sourceId: row.source_id,
    externalId: row.id.slice(row.source_id.length + 1),
    title: row.title,
    committeeName: row.committee_name,
    startUtc: row.start_utc,
    endUtc: row.end_utc,
    location: row.location,
    url: row.url,
  };
}

export class D1EventStore implements EventStore {
  constructor(private db: D1Database) {}

  async replaceSourceEvents(sourceId: string, events: NormalizedEvent[], todayUtc: string): Promise<void> {
    const statements = [
      this.db.prepare(`DELETE FROM events WHERE source_id = ?1 AND start_utc >= ?2`).bind(sourceId, todayUtc),
      ...events.map((event) =>
        this.db
          .prepare(
            `INSERT INTO events (id, source_id, title, committee_name, start_utc, end_utc, location, url, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (id) DO UPDATE SET
               title = excluded.title,
               committee_name = excluded.committee_name,
               start_utc = excluded.start_utc,
               end_utc = excluded.end_utc,
               location = excluded.location,
               url = excluded.url,
               last_seen_at = excluded.last_seen_at`
          )
          .bind(
            `${sourceId}:${event.externalId}`,
            sourceId,
            event.title,
            event.committeeName,
            event.startUtc,
            event.endUtc,
            event.location,
            event.url,
            todayUtc
          )
      ),
    ];
    await this.db.batch(statements);
  }

  async recordSourceSuccess(sourceId: string, nowUtc: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO source_status (source_id, last_success_at, consecutive_failures, last_error)
         VALUES (?1, ?2, 0, NULL)
         ON CONFLICT (source_id) DO UPDATE SET
           last_success_at = ?2,
           consecutive_failures = 0,
           last_error = NULL`
      )
      .bind(sourceId, nowUtc)
      .run();
  }

  async recordSourceFailure(sourceId: string, errorMessage: string): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO source_status (source_id, last_success_at, consecutive_failures, last_error)
         VALUES (?1, NULL, 1, ?2)
         ON CONFLICT (source_id) DO UPDATE SET
           consecutive_failures = source_status.consecutive_failures + 1,
           last_error = ?2
         RETURNING consecutive_failures`
      )
      .bind(sourceId, errorMessage)
      .first<{ consecutive_failures: number }>();
    if (result === null) {
      throw new Error(`db: recordSourceFailure returned no row for source "${sourceId}"`);
    }
    return result.consecutive_failures;
  }

  async getFutureEvents(nowUtc: string): Promise<NormalizedEvent[]> {
    const result = await this.db
      .prepare(`SELECT * FROM events WHERE start_utc >= ?1 ORDER BY start_utc ASC`)
      .bind(nowUtc)
      .all<D1EventRow>();
    return result.results.map(toNormalizedEvent);
  }
}
