import type { PendingRow, PendingStatus } from '../types';

export interface PendingInboundStore {
  upsertPending(email: string, receivedAt: string): Promise<void>;
  updateStatus(email: string, status: PendingStatus, error?: string, writtenAt?: string): Promise<void>;
}

export class D1PendingInboundStore implements PendingInboundStore {
  constructor(private db: D1Database) {}

  async upsertPending(email: string, receivedAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pending_inbound_syncs (email, status, received_at)
         VALUES (?1, 'received', ?2)
         ON CONFLICT (email) DO UPDATE SET
           status = 'received', error = NULL, received_at = excluded.received_at`,
      )
      .bind(email, receivedAt)
      .run();
  }

  // Read by the dead-letter consumer only (src/consumer/deadLetters.ts).
  async get(email: string): Promise<PendingRow | null> {
    const row = await this.db
      .prepare(`SELECT status, error, received_at, written_at FROM pending_inbound_syncs WHERE email = ?1`)
      .bind(email)
      .first<{ status: PendingStatus; error: string | null; received_at: string; written_at: string | null }>();
    return row === null ? null : { status: row.status, error: row.error, receivedAt: row.received_at, writtenAt: row.written_at };
  }

  async updateStatus(email: string, status: PendingStatus, error?: string, writtenAt?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE pending_inbound_syncs SET
           status = ?2, error = ?3, written_at = COALESCE(?4, written_at)
         WHERE email = ?1`,
      )
      .bind(email, status, error ?? null, writtenAt ?? null)
      .run();
  }
}
