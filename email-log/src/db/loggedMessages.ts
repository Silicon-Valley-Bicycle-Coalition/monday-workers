export type AlertKind = 'capacity' | 'board-full' | 'dead-letter';

const MAX_ERROR_CHARS = 500;

/**
 * The dedupe ledger. Holds only the message hash, status and Monday item id: never an address,
 * subject or body. Timestamps are supplied by the caller (ISO strings).
 */
export interface LoggedMessageStore {
  /** True when the row was inserted or re-opened from 'failed': the caller should enqueue. */
  claim(hash: string, kind: 'bcc' | 'forward', now: string): Promise<boolean>;
  markLogged(hash: string, itemId: string, now: string): Promise<void>;
  /** `error` must be an error message only, never message content; stored truncated to 500 chars. */
  markFailed(hash: string, error: string): Promise<void>;
  lastAlertAt(kind: AlertKind): Promise<string | null>;
  recordAlert(kind: AlertKind, at: string, itemId: string | null): Promise<void>;
}

export class D1LoggedMessageStore implements LoggedMessageStore {
  constructor(private db: D1Database) {}

  async claim(hash: string, kind: 'bcc' | 'forward', now: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO logged_messages (message_id_hash, kind, status, created_at)
         VALUES (?1, ?2, 'queued', ?3)
         ON CONFLICT (message_id_hash) DO UPDATE SET status = 'queued', error = NULL
         WHERE logged_messages.status = 'failed'`
      )
      .bind(hash, kind, now)
      .run();
    return result.meta.changes === 1;
  }

  async markLogged(hash: string, itemId: string, now: string): Promise<void> {
    await this.db
      .prepare(`UPDATE logged_messages SET status = 'logged', activity_item_id = ?2, logged_at = ?3, error = NULL WHERE message_id_hash = ?1`)
      .bind(hash, itemId, now)
      .run();
  }

  async markFailed(hash: string, error: string): Promise<void> {
    await this.db
      .prepare(`UPDATE logged_messages SET status = 'failed', error = ?2 WHERE message_id_hash = ?1`)
      .bind(hash, error.slice(0, MAX_ERROR_CHARS))
      .run();
  }

  async lastAlertAt(kind: AlertKind): Promise<string | null> {
    const row = await this.db.prepare(`SELECT last_at FROM alerts WHERE kind = ?1`).bind(kind).first<{ last_at: string }>();
    return row?.last_at ?? null;
  }

  async recordAlert(kind: AlertKind, at: string, itemId: string | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO alerts (kind, last_at, item_id) VALUES (?1, ?2, ?3)
         ON CONFLICT (kind) DO UPDATE SET last_at = excluded.last_at, item_id = excluded.item_id`
      )
      .bind(kind, at, itemId)
      .run();
  }
}
