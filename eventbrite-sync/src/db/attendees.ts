import type { AttendeeRow, LedgerStatus } from '../types';

export interface NewAttendeeDelivery {
  attendeeId: string;
  eventId: string;
  action: string;
  receivedAt: string;
}

export interface AttendeeStatusPatch {
  mondayItemId?: string;
  matchedPersonItemId?: string;
  error?: string;
  writtenAt?: string;
}

export interface AttendeeStore {
  // Insert the attendee on first sight, or bump its delivery count and reset it to 'received' —
  // keeping the Monday item id and People match a previous write recorded.
  recordDelivery(delivery: NewAttendeeDelivery): Promise<void>;
  updateStatus(attendeeId: string, status: LedgerStatus, patch?: AttendeeStatusPatch): Promise<void>;
  getAttendee(attendeeId: string): Promise<AttendeeRow | null>;
  listByEvent(eventId: string): Promise<AttendeeRow[]>;
  countByEvent(eventId: string): Promise<number>;
}

interface D1AttendeeRecord {
  attendee_id: string;
  event_id: string;
  monday_item_id: string | null;
  matched_person_item_id: string | null;
  status: LedgerStatus;
  last_action: string;
  error: string | null;
  deliveries: number;
  received_at: string;
  written_at: string | null;
}

function toAttendeeRow(record: D1AttendeeRecord): AttendeeRow {
  return {
    attendeeId: record.attendee_id,
    eventId: record.event_id,
    mondayItemId: record.monday_item_id,
    matchedPersonItemId: record.matched_person_item_id,
    status: record.status,
    lastAction: record.last_action,
    error: record.error,
    deliveries: record.deliveries,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
  };
}

const COLUMNS =
  'attendee_id, event_id, monday_item_id, matched_person_item_id, status, last_action, error, deliveries, received_at, written_at';

export class D1AttendeeStore implements AttendeeStore {
  constructor(private db: D1Database) {}

  async recordDelivery(delivery: NewAttendeeDelivery): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO attendees (attendee_id, event_id, last_action, status, deliveries, received_at)
         VALUES (?1, ?2, ?3, 'received', 1, ?4)
         ON CONFLICT (attendee_id) DO UPDATE SET
           event_id = excluded.event_id,
           last_action = excluded.last_action,
           status = 'received',
           error = NULL,
           deliveries = attendees.deliveries + 1,
           received_at = excluded.received_at`
      )
      .bind(delivery.attendeeId, delivery.eventId, delivery.action, delivery.receivedAt)
      .run();
  }

  async updateStatus(attendeeId: string, status: LedgerStatus, patch: AttendeeStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE attendees SET
           status = ?2,
           monday_item_id = COALESCE(?3, monday_item_id),
           matched_person_item_id = COALESCE(?4, matched_person_item_id),
           error = ?5,
           written_at = COALESCE(?6, written_at)
         WHERE attendee_id = ?1`
      )
      .bind(attendeeId, status, patch.mondayItemId ?? null, patch.matchedPersonItemId ?? null, patch.error ?? null, patch.writtenAt ?? null)
      .run();
  }

  async getAttendee(attendeeId: string): Promise<AttendeeRow | null> {
    const record = await this.db.prepare(`SELECT ${COLUMNS} FROM attendees WHERE attendee_id = ?1`).bind(attendeeId).first<D1AttendeeRecord>();
    return record === null ? null : toAttendeeRow(record);
  }

  // In delivery order (received_at, which each redelivery moves forward), attendee_id breaking ties:
  // the class email planner's "first registration for an address" order.
  async listByEvent(eventId: string): Promise<AttendeeRow[]> {
    const { results } = await this.db.prepare(`SELECT ${COLUMNS} FROM attendees WHERE event_id = ?1 ORDER BY received_at, attendee_id`).bind(eventId).all<D1AttendeeRecord>();
    return results.map(toAttendeeRow);
  }

  async countByEvent(eventId: string): Promise<number> {
    const record = await this.db.prepare('SELECT COUNT(*) AS n FROM attendees WHERE event_id = ?1').bind(eventId).first<{ n: number }>();
    return record?.n ?? 0;
  }
}
