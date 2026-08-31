import type { PendingStatus } from '../types';

export interface PendingOutboundStore {
  upsertPending(donorItemId: string, receivedAt: string): Promise<void>;
  updateStatus(donorItemId: string, status: PendingStatus, error?: string, writtenAt?: string): Promise<void>;
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
}
