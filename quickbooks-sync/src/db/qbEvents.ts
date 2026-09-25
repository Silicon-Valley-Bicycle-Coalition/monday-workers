import type { EntityType, QbEventRow, SyncStatus } from '../types';

export interface NewQbEvent {
  eventId: string;
  entityType: EntityType;
  qbId: string;
  receivedAt: string;
}

export interface QbEventStatusPatch {
  fetchedPayload?: string;
  pendingMondayItemId?: string;
  error?: string;
  writtenAt?: string;
}

export interface QbEventStore {
  insertEvent(row: NewQbEvent): Promise<'inserted' | 'duplicate'>;
  updateStatus(eventId: string, status: SyncStatus, patch?: QbEventStatusPatch): Promise<void>;
  getEvent(eventId: string): Promise<QbEventRow | null>;
  // Create-loop guard (#33, migration 0004). Stamped just before Monday's create_item call.
  markMondayCreateStarted(eventId: string, at: string): Promise<void>;
  // The row whose Monday create produced `mondayItemId`, if its id was recorded.
  findByPendingMondayItemId(entityType: EntityType, mondayItemId: string): Promise<QbEventRow | null>;
  // True while some row of this type stamped a create at or after `since` but has neither
  // recorded the resulting item id nor finished — i.e. a Monday item may exist that nothing
  // links back to QuickBooks yet.
  hasMondayCreateInFlight(entityType: EntityType, since: string): Promise<boolean>;
}

interface D1QbEventRecord {
  event_id: string;
  entity_type: EntityType;
  qb_id: string;
  fetched_payload: string | null;
  pending_monday_item_id: string | null;
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
    pendingMondayItemId: record.pending_monday_item_id,
    status: record.status,
    error: record.error,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
  };
}

const SELECT_COLUMNS =
  'event_id, entity_type, qb_id, fetched_payload, pending_monday_item_id, status, error, received_at, written_at';

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
           pending_monday_item_id = COALESCE(?4, pending_monday_item_id),
           error = ?5,
           written_at = COALESCE(?6, written_at)
         WHERE event_id = ?1`
      )
      .bind(
        eventId,
        status,
        patch.fetchedPayload ?? null,
        patch.pendingMondayItemId ?? null,
        patch.error ?? null,
        patch.writtenAt ?? null
      )
      .run();
  }

  async getEvent(eventId: string): Promise<QbEventRow | null> {
    const record = await this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM qb_events WHERE event_id = ?1`)
      .bind(eventId)
      .first<D1QbEventRecord>();
    return record === null ? null : toQbEventRow(record);
  }

  async markMondayCreateStarted(eventId: string, at: string): Promise<void> {
    await this.db.prepare('UPDATE qb_events SET monday_create_started_at = ?2 WHERE event_id = ?1').bind(eventId, at).run();
  }

  async findByPendingMondayItemId(entityType: EntityType, mondayItemId: string): Promise<QbEventRow | null> {
    const record = await this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM qb_events
         WHERE entity_type = ?1 AND pending_monday_item_id = ?2
         ORDER BY received_at DESC LIMIT 1`
      )
      .bind(entityType, mondayItemId)
      .first<D1QbEventRecord>();
    return record === null ? null : toQbEventRow(record);
  }

  async hasMondayCreateInFlight(entityType: EntityType, since: string): Promise<boolean> {
    const record = await this.db
      .prepare(
        `SELECT 1 AS hit FROM qb_events
         WHERE entity_type = ?1 AND monday_create_started_at IS NOT NULL AND monday_create_started_at >= ?2
           AND pending_monday_item_id IS NULL AND status != 'written'
         LIMIT 1`
      )
      .bind(entityType, since)
      .first<{ hit: number }>();
    return record !== null;
  }
}
