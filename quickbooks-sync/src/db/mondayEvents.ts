import type { MondayEventRow, SyncStatus } from '../types';

export interface NewMondayEvent {
  eventId: string;
  mondayItemId: string;
  rawPayload: string;
  receivedAt: string;
}

export interface MondayEventStatusPatch {
  qbId?: string;
  error?: string;
  writtenAt?: string;
}

export interface MondayEventStore {
  insertEvent(row: NewMondayEvent): Promise<'inserted' | 'duplicate'>;
  updateStatus(eventId: string, status: SyncStatus, patch?: MondayEventStatusPatch): Promise<void>;
  getEvent(eventId: string): Promise<MondayEventRow | null>;
}

interface D1MondayEventRecord {
  event_id: string;
  monday_item_id: string;
  raw_payload: string;
  status: SyncStatus;
  qb_id: string | null;
  error: string | null;
  received_at: string;
  written_at: string | null;
}

function toMondayEventRow(record: D1MondayEventRecord): MondayEventRow {
  return {
    eventId: record.event_id,
    mondayItemId: record.monday_item_id,
    rawPayload: record.raw_payload,
    status: record.status,
    qbId: record.qb_id,
    error: record.error,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
  };
}

export class D1MondayEventStore implements MondayEventStore {
  constructor(private db: D1Database) {}

  async insertEvent(row: NewMondayEvent): Promise<'inserted' | 'duplicate'> {
    const result = await this.db
      .prepare(
        `INSERT INTO monday_events (event_id, monday_item_id, raw_payload, status, received_at)
         VALUES (?1, ?2, ?3, 'received', ?4)
         ON CONFLICT (event_id) DO NOTHING`
      )
      .bind(row.eventId, row.mondayItemId, row.rawPayload, row.receivedAt)
      .run();
    return result.meta.changes > 0 ? 'inserted' : 'duplicate';
  }

  async updateStatus(eventId: string, status: SyncStatus, patch: MondayEventStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE monday_events SET
           status = ?2,
           qb_id = COALESCE(?3, qb_id),
           error = ?4,
           written_at = COALESCE(?5, written_at)
         WHERE event_id = ?1`
      )
      .bind(eventId, status, patch.qbId ?? null, patch.error ?? null, patch.writtenAt ?? null)
      .run();
  }

  async getEvent(eventId: string): Promise<MondayEventRow | null> {
    const record = await this.db
      .prepare(
        `SELECT event_id, monday_item_id, raw_payload, status, qb_id, error, received_at, written_at
         FROM monday_events WHERE event_id = ?1`
      )
      .bind(eventId)
      .first<D1MondayEventRecord>();
    return record === null ? null : toMondayEventRow(record);
  }
}
