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
           (event_id, kind, call_id, occurred_at, zoom_user_id, external_e164, direction, result, talk_seconds, status, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (event_id) DO NOTHING`,
      )
      .bind(
        event.eventId,
        event.kind,
        event.callId,
        event.occurredAt,
        event.zoomUserId,
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
