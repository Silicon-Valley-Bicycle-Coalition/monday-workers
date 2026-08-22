import type { EntityType, QbEventRow, SyncStatus } from '../types';

export interface NewQbEvent {
  eventId: string;
  entityType: EntityType;
  qbId: string;
  receivedAt: string;
}

export interface QbEventStatusPatch {
  fetchedPayload?: string;
  error?: string;
  writtenAt?: string;
}

export interface QbEventStore {
  insertEvent(row: NewQbEvent): Promise<'inserted' | 'duplicate'>;
  updateStatus(eventId: string, status: SyncStatus, patch?: QbEventStatusPatch): Promise<void>;
  getEvent(eventId: string): Promise<QbEventRow | null>;
}

interface D1QbEventRecord {
  event_id: string;
  entity_type: EntityType;
  qb_id: string;
  fetched_payload: string | null;
  status: SyncStatus;
  error: string | null;
  received_at: string;
  written_at: string | null;
}

function toQbEventRow(record: D1QbEventRecord): QbEventRow {
  return {
    eventId: record.event_id,
    entityType: record.entity_type,
    qbId: record.qb_id,
    fetchedPayload: record.fetched_payload,
    status: record.status,
    error: record.error,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
  };
}

export class D1QbEventStore implements QbEventStore {
  constructor(private db: D1Database) {}

  async insertEvent(row: NewQbEvent): Promise<'inserted' | 'duplicate'> {
    const result = await this.db
      .prepare(
        `INSERT INTO qb_events (event_id, entity_type, qb_id, status, received_at)
         VALUES (?1, ?2, ?3, 'received', ?4)
         ON CONFLICT (event_id) DO NOTHING`
      )
      .bind(row.eventId, row.entityType, row.qbId, row.receivedAt)
      .run();
    return result.meta.changes > 0 ? 'inserted' : 'duplicate';
  }

  async updateStatus(eventId: string, status: SyncStatus, patch: QbEventStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE qb_events SET
           status = ?2,
           fetched_payload = COALESCE(?3, fetched_payload),
           error = ?4,
           written_at = COALESCE(?5, written_at)
         WHERE event_id = ?1`
      )
      .bind(eventId, status, patch.fetchedPayload ?? null, patch.error ?? null, patch.writtenAt ?? null)
      .run();
  }

  async getEvent(eventId: string): Promise<QbEventRow | null> {
    const record = await this.db
      .prepare(
        `SELECT event_id, entity_type, qb_id, fetched_payload, status, error, received_at, written_at
         FROM qb_events WHERE event_id = ?1`
      )
      .bind(eventId)
      .first<D1QbEventRecord>();
    return record === null ? null : toQbEventRow(record);
  }
}
