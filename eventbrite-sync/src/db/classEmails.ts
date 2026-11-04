// The ledger behind the class email page: one row per (event, kind, registration), keyed on the
// Eventbrite event id and the Monday Event Registrations item id. A row is the claim to email that
// registration; the primary key is what stops two sends racing for it. Ids and statuses only, no
// address or name.
export type ClassEmailKind = 'reminder' | 'thank-you' | 'missed-you';
export type ClassEmailStatus = 'claimed' | 'sent' | 'failed';

export interface ClassEmailRow {
  eventId: string;
  kind: ClassEmailKind;
  registrationId: string;
  status: ClassEmailStatus;
  claimedAt: string;
  resolvedAt: string | null;
}

export interface ClassEmailStore {
  listByEvent(eventId: string): Promise<ClassEmailRow[]>;
  // Claims the registrations nobody has claimed yet and returns just those ids, in the order given.
  claim(eventId: string, kind: ClassEmailKind, registrationIds: string[], claimedAt: string): Promise<string[]>;
  // Records the outcome of a claimed send. A row already `sent` is never changed.
  resolve(eventId: string, kind: ClassEmailKind, registrationId: string, status: 'sent' | 'failed', resolvedAt: string): Promise<void>;
  // Frees `failed` rows, and `claimed` rows claimed at or before `claimedBefore`, so they can be
  // claimed again, and returns the ids it freed. A `sent` row or a younger claim stays.
  release(eventId: string, kind: ClassEmailKind, registrationIds: string[], claimedBefore: string): Promise<string[]>;
}

interface D1ClassEmailRecord {
  event_id: string;
  kind: ClassEmailKind;
  registration_item_id: string;
  status: ClassEmailStatus;
  claimed_at: string;
  resolved_at: string | null;
}

export class D1ClassEmailStore implements ClassEmailStore {
  constructor(private db: D1Database) {}

  async listByEvent(eventId: string): Promise<ClassEmailRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT event_id, kind, registration_item_id, status, claimed_at, resolved_at
         FROM class_email_recipients WHERE event_id = ?1 ORDER BY claimed_at, registration_item_id`
      )
      .bind(eventId)
      .all<D1ClassEmailRecord>();
    return results.map((r) => ({
      eventId: r.event_id,
      kind: r.kind,
      registrationId: r.registration_item_id,
      status: r.status,
      claimedAt: r.claimed_at,
      resolvedAt: r.resolved_at,
    }));
  }

  async claim(eventId: string, kind: ClassEmailKind, registrationIds: string[], claimedAt: string): Promise<string[]> {
    if (registrationIds.length === 0) return [];
    // One batch (a single transaction) of inserts that do nothing on a conflict. RETURNING yields a
    // row only for an insert that happened, so of two concurrent claims on the same registration
    // exactly one gets it back.
    const results = await this.db.batch<{ registration_item_id: string }>(
      registrationIds.map((id) =>
        this.db
          .prepare(
            `INSERT INTO class_email_recipients (event_id, kind, registration_item_id, status, claimed_at)
             VALUES (?1, ?2, ?3, 'claimed', ?4)
             ON CONFLICT (event_id, kind, registration_item_id) DO NOTHING
             RETURNING registration_item_id`
          )
          .bind(eventId, kind, id, claimedAt)
      )
    );
    return results.flatMap((r) => r.results.map((row) => row.registration_item_id));
  }

  async resolve(eventId: string, kind: ClassEmailKind, registrationId: string, status: 'sent' | 'failed', resolvedAt: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE class_email_recipients SET status = ?4, resolved_at = ?5
         WHERE event_id = ?1 AND kind = ?2 AND registration_item_id = ?3 AND status != 'sent'`
      )
      .bind(eventId, kind, registrationId, status, resolvedAt)
      .run();
  }

  async release(eventId: string, kind: ClassEmailKind, registrationIds: string[], claimedBefore: string): Promise<string[]> {
    if (registrationIds.length === 0) return [];
    // The conditions live in the DELETE, so a row resolved or re-claimed since the caller read the
    // ledger is judged as it is now. claimed_at is always toISOString(), so text order is time order.
    const results = await this.db.batch<{ registration_item_id: string }>(
      registrationIds.map((id) =>
        this.db
          .prepare(
            `DELETE FROM class_email_recipients
             WHERE event_id = ?1 AND kind = ?2 AND registration_item_id = ?3
               AND (status = 'failed' OR (status = 'claimed' AND claimed_at <= ?4))
             RETURNING registration_item_id`
          )
          .bind(eventId, kind, id, claimedBefore)
      )
    );
    return results.flatMap((r) => r.results.map((row) => row.registration_item_id));
  }
}
