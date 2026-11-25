import type { GrantRecord } from '../tracker/grants';
import type { TrackerRecord } from '../tracker/totals';

// What the tracker job last wrote, by Monday item id: totals by tracker row, Grant by Events item.
export interface TrackerStore {
  listCounts(): Promise<Map<string, TrackerRecord>>;
  saveCounts(record: TrackerRecord, writtenAt: string): Promise<void>;
  deleteCounts(trackerItemId: string): Promise<void>;
  listGrants(): Promise<Map<string, GrantRecord>>;
  saveGrant(eventItemId: string, record: GrantRecord, writtenAt: string): Promise<void>;
  deleteGrant(eventItemId: string): Promise<void>;
}

interface D1CountsRecord {
  tracker_item_id: string;
  event_item_id: string;
  row_date: string;
  registered: number;
  checked_in: number;
  no_shows: number;
}

export class D1TrackerStore implements TrackerStore {
  constructor(private db: D1Database) {}

  async listCounts(): Promise<Map<string, TrackerRecord>> {
    const { results } = await this.db
      .prepare('SELECT tracker_item_id, event_item_id, row_date, registered, checked_in, no_shows FROM tracker_counts')
      .all<D1CountsRecord>();
    return new Map(results.map((r) => [r.tracker_item_id, {
      trackerItemId: r.tracker_item_id,
      eventItemId: r.event_item_id,
      date: r.row_date,
      totals: { registered: r.registered, checkedIn: r.checked_in, noShows: r.no_shows },
    }]));
  }

  async saveCounts({ trackerItemId, eventItemId, date, totals }: TrackerRecord, writtenAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tracker_counts (tracker_item_id, event_item_id, row_date, registered, checked_in, no_shows, written_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (tracker_item_id) DO UPDATE SET
           event_item_id = excluded.event_item_id,
           row_date = excluded.row_date,
           registered = excluded.registered,
           checked_in = excluded.checked_in,
           no_shows = excluded.no_shows,
           written_at = excluded.written_at`
      )
      .bind(trackerItemId, eventItemId, date, totals.registered, totals.checkedIn, totals.noShows, writtenAt)
      .run();
  }

  async deleteCounts(trackerItemId: string): Promise<void> {
    await this.db.prepare('DELETE FROM tracker_counts WHERE tracker_item_id = ?1').bind(trackerItemId).run();
  }

  async listGrants(): Promise<Map<string, GrantRecord>> {
    const { results } = await this.db
      .prepare('SELECT event_item_id, grant_label, tracker_item_id FROM event_grants')
      .all<{ event_item_id: string; grant_label: string; tracker_item_id: string }>();
    return new Map(results.map((r) => [r.event_item_id, { grant: r.grant_label, trackerItemId: r.tracker_item_id }]));
  }

  async saveGrant(eventItemId: string, { grant, trackerItemId }: GrantRecord, writtenAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO event_grants (event_item_id, grant_label, tracker_item_id, written_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (event_item_id) DO UPDATE SET grant_label = excluded.grant_label, tracker_item_id = excluded.tracker_item_id, written_at = excluded.written_at`
      )
      .bind(eventItemId, grant, trackerItemId, writtenAt)
      .run();
  }

  async deleteGrant(eventItemId: string): Promise<void> {
    await this.db.prepare('DELETE FROM event_grants WHERE event_item_id = ?1').bind(eventItemId).run();
  }
}
