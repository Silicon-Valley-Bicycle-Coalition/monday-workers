import type { PendingRow, PendingStatus } from '../types';

export interface PendingOutboundStore {
  upsertPending(donorItemId: string, receivedAt: string): Promise<void>;
  updateStatus(donorItemId: string, status: PendingStatus, error?: string, writtenAt?: string): Promise<void>;
  // Coalescing (#97): when the last completed sync began, null if none has.
  lastSyncStartedAt(donorItemId: string): Promise<string | null>;
  recordSyncStart(donorItemId: string, startedAt: string): Promise<void>;
}

export class D1PendingOutboundStore implements PendingOutboundStore {
  constructor(private db: D1Database) {}

  async upsertPending(donorItemId: string, receivedAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pending_outbound_syncs (donor_item_id, status, received_at)
         VALUES (?1, 'received', ?2)
         ON CONFLICT (donor_item_id) DO UPDATE SET
           status = 'received', error = NULL, received_at = excluded.received_at`,
      )
      .bind(donorItemId, receivedAt)
      .run();
  }

  // Read by the dead-letter consumer only (src/consumer/deadLetters.ts).
  async get(donorItemId: string): Promise<PendingRow | null> {
    const row = await this.db
      .prepare(`SELECT status, error, received_at, written_at FROM pending_outbound_syncs WHERE donor_item_id = ?1`)
      .bind(donorItemId)
      .first<{ status: PendingStatus; error: string | null; received_at: string; written_at: string | null }>();
    return row === null ? null : { status: row.status, error: row.error, receivedAt: row.received_at, writtenAt: row.written_at };
  }

  async updateStatus(donorItemId: string, status: PendingStatus, error?: string, writtenAt?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE pending_outbound_syncs SET
           status = ?2, error = ?3, written_at = COALESCE(?4, written_at)
         WHERE donor_item_id = ?1`,
      )
      .bind(donorItemId, status, error ?? null, writtenAt ?? null)
      .run();
  }

  async lastSyncStartedAt(donorItemId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT last_sync_started_at FROM pending_outbound_syncs WHERE donor_item_id = ?1`)
      .bind(donorItemId)
      .first<{ last_sync_started_at: string | null }>();
    return row?.last_sync_started_at ?? null;
  }

  async recordSyncStart(donorItemId: string, startedAt: string): Promise<void> {
    await this.db
      .prepare(`UPDATE pending_outbound_syncs SET last_sync_started_at = ?2 WHERE donor_item_id = ?1`)
      .bind(donorItemId, startedAt)
      .run();
  }
}
