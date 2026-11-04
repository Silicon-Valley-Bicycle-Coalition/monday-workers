import type { EventRow, LedgerStatus } from '../types';

export interface NewEventDelivery {
  eventId: string;
  action: string;
  receivedAt: string;
}

// What the consumer learned from the fetched event; recorded with the status change.
export interface EventStatusPatch {
  mondayItemId?: string;
  startsAt?: string;
  endsAt?: string;
  locationKey?: string;
  eventbriteStatus?: string;
  error?: string;
  writtenAt?: string;
}

export interface EventStore {
  // Insert the event on first sight, or bump its delivery count and reset it to 'received' —
  // keeping the Monday item id and event facts a previous write recorded.
  recordDelivery(delivery: NewEventDelivery): Promise<'inserted' | 'updated'>;
  updateStatus(eventId: string, status: LedgerStatus, patch?: EventStatusPatch): Promise<void>;
  getEvent(eventId: string): Promise<EventRow | null>;
}

interface D1EventRecord {
  event_id: string;
  monday_item_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location_key: string | null;
  eventbrite_status: string | null;
  status: LedgerStatus;
  last_action: string;
  error: string | null;
  deliveries: number;
  received_at: string;
  written_at: string | null;
}

function toEventRow(record: D1EventRecord): EventRow {
  return {
    eventId: record.event_id,
    mondayItemId: record.monday_item_id,
    startsAt: record.starts_at,
    endsAt: record.ends_at,
    locationKey: record.location_key,
    eventbriteStatus: record.eventbrite_status,
    status: record.status,
    lastAction: record.last_action,
    error: record.error,
    deliveries: record.deliveries,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
  };
}

const COLUMNS =
  'event_id, monday_item_id, starts_at, ends_at, location_key, eventbrite_status, status, last_action, error, deliveries, received_at, written_at';

export class D1EventStore implements EventStore {
  constructor(private db: D1Database) {}

  async recordDelivery(delivery: NewEventDelivery): Promise<'inserted' | 'updated'> {
    // The pre-SELECT only classifies the result; the primary key makes a concurrent insert of the
    // same event land on the ON CONFLICT path.
    const existing = await this.db.prepare(`SELECT event_id FROM events WHERE event_id = ?1`).bind(delivery.eventId).first<{ event_id: string }>();
    await this.db
      .prepare(
        `INSERT INTO events (event_id, last_action, status, deliveries, received_at)
         VALUES (?1, ?2, 'received', 1, ?3)
         ON CONFLICT (event_id) DO UPDATE SET
           last_action = excluded.last_action,
           status = 'received',
           error = NULL,
           deliveries = events.deliveries + 1,
           received_at = excluded.received_at`
      )
      .bind(delivery.eventId, delivery.action, delivery.receivedAt)
      .run();
    return existing === null ? 'inserted' : 'updated';
  }

  async updateStatus(eventId: string, status: LedgerStatus, patch: EventStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE events SET
           status = ?2,
           monday_item_id = COALESCE(?3, monday_item_id),
           starts_at = COALESCE(?4, starts_at),
           ends_at = COALESCE(?5, ends_at),
           location_key = COALESCE(?6, location_key),
           eventbrite_status = COALESCE(?7, eventbrite_status),
           error = ?8,
           written_at = COALESCE(?9, written_at)
         WHERE event_id = ?1`
      )
      .bind(
        eventId,
        status,
        patch.mondayItemId ?? null,
        patch.startsAt ?? null,
        patch.endsAt ?? null,
        patch.locationKey ?? null,
        patch.eventbriteStatus ?? null,
        patch.error ?? null,
        patch.writtenAt ?? null
      )
      .run();
  }

  async getEvent(eventId: string): Promise<EventRow | null> {
    const record = await this.db.prepare(`SELECT ${COLUMNS} FROM events WHERE event_id = ?1`).bind(eventId).first<D1EventRecord>();
    return record === null ? null : toEventRow(record);
  }
}
