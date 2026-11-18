import type { EntityType, EventRow, EventStatus } from '../types';

export interface NewEvent {
  eventId: string;
  entityType: EntityType;
  entityId: string;
  rawPayload: string;
  // Delivery send time (epoch ms) from the Funraise envelope; null when it had none. Orders
  // deliveries for the same entity — see upsertEvent.
  sentAt: number | null;
  receivedAt: string;
}

export interface EventStatusPatch {
  matchedDonorItemId?: string;
  mondayItemId?: string;
  error?: string;
  writtenAt?: string;
}

// 'stored' covers a first delivery and a newer one for a known entity alike: the webhook only
// branches on 'duplicate', so the upsert stays one statement with no pre-SELECT (GL#101).
export type UpsertResult = 'stored' | 'duplicate';

export interface EventStore {
  upsertEvent(row: NewEvent): Promise<UpsertResult>;
  updateStatusByEntity(
    entityType: EntityType,
    entityId: string,
    status: EventStatus,
    patch?: EventStatusPatch
  ): Promise<void>;
  getEventByEntity(entityType: EntityType, entityId: string): Promise<EventRow | null>;
  purgeWrittenPayloads(writtenBefore: string): Promise<number>;
  purgeUnresolvedPayloads(receivedBefore: string): Promise<number>;
}

interface D1EventRecord {
  event_id: string;
  entity_type: EntityType;
  entity_id: string;
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
    entityId: record.entity_id,
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

  async upsertEvent(row: NewEvent): Promise<UpsertResult> {
    // A delivery for a known entity replaces the row only if it isn't older than what's stored:
    // at-least-once delivery can replay an earlier edit after a later one was written, and
    // applying it would push stale columns back onto the Monday item. Ordering is by the
    // envelope's send time; a NULL on either side means the order is unknown, so it updates.
    // A stale delivery hits the WHERE, changes nothing, and is reported as a duplicate.
    const result = await this.db
      .prepare(
        `INSERT INTO events (event_id, entity_type, entity_id, raw_payload, sent_at, status, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'received', ?6)
         ON CONFLICT (event_id) DO NOTHING
         ON CONFLICT (entity_type, entity_id) DO UPDATE SET
           event_id = excluded.event_id,
           raw_payload = excluded.raw_payload,
           sent_at = excluded.sent_at,
           status = 'received',
           error = NULL,
           received_at = excluded.received_at
         WHERE excluded.sent_at IS NULL OR events.sent_at IS NULL OR excluded.sent_at >= events.sent_at`
      )
      .bind(row.eventId, row.entityType, row.entityId, row.rawPayload, row.sentAt, row.receivedAt)
      .run();

    return result.meta.changes === 0 ? 'duplicate' : 'stored';
  }

  async updateStatusByEntity(
    entityType: EntityType,
    entityId: string,
    status: EventStatus,
    patch: EventStatusPatch = {}
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE events SET
           status = ?3,
           matched_donor_item_id = COALESCE(?4, matched_donor_item_id),
           monday_item_id = COALESCE(?5, monday_item_id),
           error = ?6,
           written_at = COALESCE(?7, written_at)
         WHERE entity_type = ?1 AND entity_id = ?2`
      )
      .bind(
        entityType,
        entityId,
        status,
        patch.matchedDonorItemId ?? null,
        patch.mondayItemId ?? null,
        patch.error ?? null,
        patch.writtenAt ?? null
      )
      .run();
  }

  async getEventByEntity(entityType: EntityType, entityId: string): Promise<EventRow | null> {
    const record = await this.db
      .prepare(
        `SELECT event_id, entity_type, entity_id, raw_payload, matched_donor_item_id, monday_item_id, status, error, received_at, written_at
         FROM events WHERE entity_type = ?1 AND entity_id = ?2`
      )
      .bind(entityType, entityId)
      .first<D1EventRecord>();
    return record === null ? null : toEventRow(record);
  }

  async purgeWrittenPayloads(writtenBefore: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE events SET raw_payload = '{}'
         WHERE status = 'written' AND written_at < ?1 AND raw_payload != '{}'`
      )
      .bind(writtenBefore)
      .run();
    return result.meta.changes;
  }

  // Outer PII bound: events that never completed their Monday write (failed enqueue,
  // DLQ-exhausted, unconfigured board) keep their payload for replay only this long.
  async purgeUnresolvedPayloads(receivedBefore: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE events SET raw_payload = '{}'
         WHERE status != 'written' AND received_at < ?1 AND raw_payload != '{}'`
      )
      .bind(receivedBefore)
      .run();
    return result.meta.changes;
  }
}
