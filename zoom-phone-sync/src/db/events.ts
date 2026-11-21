import type { WriteStamp } from '../flags';
import type { PhoneEvent } from '../webhook/parse';

// What the queue carries: the D1 key only. The consumer (#54) reads the row, so no phone number
// travels through the queue.
export interface PhoneQueueMessage extends WriteStamp {
  eventId: string;
}

export type InsertResult = 'inserted' | 'duplicate' | 'stranded';

export interface EventStore {
  /**
   * Inserts the event as `pending`, deduped on event_id. A redelivery is `duplicate` once the
   * first copy reached the queue, and `stranded` while it never did (the send failed, or the
   * isolate died between insert and send), so the caller enqueues it again.
   */
  insertEvent(event: PhoneEvent, receivedAt: string): Promise<InsertResult>;
  markEnqueued(eventId: string, at: string): Promise<void>;
}

export class D1EventStore implements EventStore {
  constructor(private readonly db: D1Database) {}

  async insertEvent(event: PhoneEvent, receivedAt: string): Promise<InsertResult> {
    const inserted = await this.db
      .prepare(
        `INSERT INTO phone_events
           (event_id, kind, call_id, occurred_at, zoom_user_id, staff_name, external_e164, direction, result, talk_seconds, status, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (event_id) DO NOTHING`,
      )
      .bind(
        event.eventId,
        event.kind,
        event.callId,
        event.occurredAt,
        event.zoomUserId,
        event.staffName,
        event.externalE164,
        event.direction,
        event.result,
        event.talkSeconds,
        receivedAt,
      )
      .run();
    if (inserted.meta.changes > 0) return 'inserted';
    const existing = await this.db
      .prepare('SELECT enqueued_at FROM phone_events WHERE event_id = ?')
      .bind(event.eventId)
      .first<{ enqueued_at: string | null }>();
    return existing !== null && existing.enqueued_at === null ? 'stranded' : 'duplicate';
  }

  async markEnqueued(eventId: string, at: string): Promise<void> {
    await this.db.prepare('UPDATE phone_events SET enqueued_at = ? WHERE event_id = ?').bind(at, eventId).run();
  }
}

export type EventStatus = 'pending' | 'logged' | 'unmatched' | 'failed' | 'dropped';

export interface StoredEvent {
  eventId: string;
  kind: 'call' | 'text';
  occurredAt: string;
  staffName: string | null;
  externalE164: string | null;
  direction: 'inbound' | 'outbound';
  result: string | null;
  talkSeconds: number | null;
  status: EventStatus;
}

// The consumer's side of phone_events, phone_event_items and phone_index (#54).
export interface LogStore {
  getEvent(eventId: string): Promise<StoredEvent | null>;
  /** People items whose normalized Phone is this number. */
  matchItems(e164: string): Promise<string[]>;
  /** Items this event already has a confirmed timeline entry on. */
  loggedItems(eventId: string): Promise<Set<string>>;
  recordItem(eventId: string, itemId: string, timelineId: string): Promise<void>;
  /** Logged: the number is cleared, so D1 keeps no record of whom staff called. */
  markLogged(eventId: string, at: string): Promise<void>;
  /** No People item holds the number: kept for the nightly rematch until retention expires. */
  markUnmatched(eventId: string): Promise<void>;
  /** Dry-run under `off`: never logged, so the number goes now. */
  markDropped(eventId: string): Promise<void>;
  recordAttempt(eventId: string): Promise<void>;
  /** Dead-lettered: still not logged after every retry. The number stays for a redrive. */
  markFailed(eventId: string): Promise<void>;
}

interface EventRow {
  event_id: string;
  kind: 'call' | 'text';
  occurred_at: string;
  staff_name: string | null;
  external_e164: string | null;
  direction: 'inbound' | 'outbound';
  result: string | null;
  talk_seconds: number | null;
  status: EventStatus;
}

export class D1LogStore implements LogStore {
  constructor(private readonly db: D1Database) {}

  async getEvent(eventId: string): Promise<StoredEvent | null> {
    const row = await this.db
      .prepare(
        `SELECT event_id, kind, occurred_at, staff_name, external_e164, direction, result, talk_seconds, status
         FROM phone_events WHERE event_id = ?`,
      )
      .bind(eventId)
      .first<EventRow>();
    if (row === null) return null;
    return {
      eventId: row.event_id,
      kind: row.kind,
      occurredAt: row.occurred_at,
      staffName: row.staff_name,
      externalE164: row.external_e164,
      direction: row.direction,
      result: row.result,
      talkSeconds: row.talk_seconds,
      status: row.status,
    };
  }

  async matchItems(e164: string): Promise<string[]> {
    const { results } = await this.db
      .prepare('SELECT item_id FROM phone_index WHERE e164 = ? ORDER BY item_id')
      .bind(e164)
      .all<{ item_id: string }>();
    return results.map((r) => r.item_id);
  }

  async loggedItems(eventId: string): Promise<Set<string>> {
    const { results } = await this.db
      .prepare('SELECT item_id FROM phone_event_items WHERE event_id = ? AND timeline_id IS NOT NULL')
      .bind(eventId)
      .all<{ item_id: string }>();
    return new Set(results.map((r) => r.item_id));
  }

  async recordItem(eventId: string, itemId: string, timelineId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO phone_event_items (event_id, item_id, timeline_id) VALUES (?, ?, ?)
         ON CONFLICT (event_id, item_id) DO UPDATE SET timeline_id = excluded.timeline_id`,
      )
      .bind(eventId, itemId, timelineId)
      .run();
  }

  async markLogged(eventId: string, at: string): Promise<void> {
    await this.db
      .prepare(`UPDATE phone_events SET status = 'logged', logged_at = ?, external_e164 = NULL WHERE event_id = ?`)
      .bind(at, eventId)
      .run();
  }

  async markUnmatched(eventId: string): Promise<void> {
    await this.db.prepare(`UPDATE phone_events SET status = 'unmatched' WHERE event_id = ?`).bind(eventId).run();
  }

  async markDropped(eventId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE phone_events SET status = 'dropped', external_e164 = NULL WHERE event_id = ?`)
      .bind(eventId)
      .run();
  }

  async recordAttempt(eventId: string): Promise<void> {
    await this.db.prepare('UPDATE phone_events SET attempts = attempts + 1 WHERE event_id = ?').bind(eventId).run();
  }

  async markFailed(eventId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE phone_events SET status = 'failed' WHERE event_id = ? AND status IN ('pending', 'unmatched')`)
      .bind(eventId)
      .run();
  }
}
