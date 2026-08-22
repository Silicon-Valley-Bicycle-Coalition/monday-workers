import type { EntityType, EventRow, EventStatus } from '../types';

export interface NewEvent {
  eventId: string;
  entityType: EntityType;
  rawPayload: string;
  receivedAt: string;
}

export interface EventStatusPatch {
  matchedDonorItemId?: string;
  mondayItemId?: string;
  error?: string;
  writtenAt?: string;
}

export interface EventStore {
  insertEvent(row: NewEvent): Promise<'inserted' | 'duplicate'>;
  updateStatus(eventId: string, status: EventStatus, patch?: EventStatusPatch): Promise<void>;
  getEvent(eventId: string): Promise<EventRow | null>;
}

interface D1EventRecord {
  event_id: string;
  entity_type: EntityType;
  raw_payload: string;
  matched_donor_item_id: string | null;
  monday_item_id: string | null;
  status: EventStatus;
  error: string | null;
  received_at: string;
  written_at: string | null;
}

function toEventRow(record: D1EventRecord): EventRow {
  return {
    eventId: record.event_id,
    entityType: record.entity_type,
    rawPayload: record.raw_payload,
    matchedDonorItemId: record.matched_donor_item_id,
    mondayItemId: record.monday_item_id,
    status: record.status,
    error: record.error,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
  };
}

export class D1EventStore implements EventStore {
  constructor(private db: D1Database) {}

  async insertEvent(row: NewEvent): Promise<'inserted' | 'duplicate'> {
    const result = await this.db
      .prepare(
        `INSERT INTO events (event_id, entity_type, raw_payload, status, received_at)
         VALUES (?1, ?2, ?3, 'received', ?4)
         ON CONFLICT (event_id) DO NOTHING`
      )
      .bind(row.eventId, row.entityType, row.rawPayload, row.receivedAt)
      .run();
    return result.meta.changes > 0 ? 'inserted' : 'duplicate';
  }

  async updateStatus(eventId: string, status: EventStatus, patch: EventStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE events SET
           status = ?2,
           matched_donor_item_id = COALESCE(?3, matched_donor_item_id),
           monday_item_id = COALESCE(?4, monday_item_id),
           error = ?5,
           written_at = COALESCE(?6, written_at)
         WHERE event_id = ?1`
      )
      .bind(
        eventId,
        status,
        patch.matchedDonorItemId ?? null,
        patch.mondayItemId ?? null,
        patch.error ?? null,
        patch.writtenAt ?? null
      )
      .run();
  }

  async getEvent(eventId: string): Promise<EventRow | null> {
    const record = await this.db
      .prepare(
        `SELECT event_id, entity_type, raw_payload, matched_donor_item_id, monday_item_id, status, error, received_at, written_at
         FROM events WHERE event_id = ?1`
      )
      .bind(eventId)
      .first<D1EventRecord>();
    return record === null ? null : toEventRow(record);
  }
}
