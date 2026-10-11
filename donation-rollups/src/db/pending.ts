import type { PendingRow, PendingStatus, RecomputeKind } from '../types';

export interface NewPending {
  donationItemId: string;
  donationBoardId: string;
  eventId: string;
  receivedAt: string;
  kind?: RecomputeKind;
}

export interface PendingStatusPatch {
  ownerItemId?: string;
  ownerBoard?: string;
  error?: string;
  writtenAt?: string;
}

export type UpsertResult = 'inserted' | 'updated' | 'duplicate';

export interface PendingStore {
  upsertPending(row: NewPending): Promise<UpsertResult>;
  updateStatus(donationItemId: string, status: PendingStatus, patch?: PendingStatusPatch): Promise<void>;
  getPending(donationItemId: string): Promise<PendingRow | null>;
  // Rows the queue never finished — still 'received' (enqueue never happened) or 'queued'
  // (message expired unconsumed, or its batch died before touching D1) — received before the
  // cutoff, oldest first. The custodian's nightly requeue duty re-enqueues them (fix 5), with
  // their kind — a registration re-sent as a donation message would read the wrong board.
  listStuck(olderThanISO: string, limit: number): Promise<StuckPending[]>;
}

export interface StuckPending { donationItemId: string; donationBoardId: string; receivedAt: string; kind: RecomputeKind }

interface D1PendingRecord {
  donation_item_id: string;
  donation_board_id: string;
  event_id: string;
  status: PendingStatus;
  owner_item_id: string | null;
  owner_board: string | null;
  error: string | null;
  received_at: string;
  written_at: string | null;
  kind: RecomputeKind;
}

function toPendingRow(record: D1PendingRecord): PendingRow {
  return {
    donationItemId: record.donation_item_id,
    donationBoardId: record.donation_board_id,
    eventId: record.event_id,
    status: record.status,
    ownerItemId: record.owner_item_id,
    ownerBoard: record.owner_board,
    error: record.error,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
    kind: record.kind,
  };
}

export class D1PendingStore implements PendingStore {
  constructor(private db: D1Database) {}

  // Keyed on the Donation item — a redelivery for the same donation replaces the
  // pending row's event_id and resets to 'received' rather than being dropped, since
  // it's still the same recompute work either way (donation-level dedup, same
  // reasoning as funraise-sync's entity-keyed events table).
  async upsertPending(row: NewPending): Promise<UpsertResult> {
    const existing = await this.db
      .prepare(`SELECT donation_item_id FROM pending_recomputes WHERE donation_item_id = ?1`)
      .bind(row.donationItemId)
      .first<{ donation_item_id: string }>();

    const result = await this.db
      .prepare(
        `INSERT INTO pending_recomputes (donation_item_id, donation_board_id, event_id, status, received_at, kind)
         VALUES (?1, ?2, ?3, 'received', ?4, ?5)
         ON CONFLICT (donation_item_id) DO UPDATE SET
           donation_board_id = excluded.donation_board_id,
           event_id = excluded.event_id,
           status = 'received',
           error = NULL,
           received_at = excluded.received_at,
           kind = excluded.kind`,
      )
      .bind(row.donationItemId, row.donationBoardId, row.eventId, row.receivedAt, row.kind ?? 'donation')
      .run();

    if (existing !== null && result.meta.changes === 0) return 'duplicate';
    return existing === null ? 'inserted' : 'updated';
  }

  async updateStatus(donationItemId: string, status: PendingStatus, patch: PendingStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE pending_recomputes SET
           status = ?2,
           owner_item_id = COALESCE(?3, owner_item_id),
           owner_board = COALESCE(?4, owner_board),
           error = ?5,
           written_at = COALESCE(?6, written_at)
         WHERE donation_item_id = ?1`,
      )
      .bind(
        donationItemId, status,
        patch.ownerItemId ?? null, patch.ownerBoard ?? null,
        patch.error ?? null, patch.writtenAt ?? null,
      )
      .run();
  }

  async getPending(donationItemId: string): Promise<PendingRow | null> {
    const record = await this.db
      .prepare(
        `SELECT donation_item_id, donation_board_id, event_id, status, owner_item_id, owner_board, error, received_at, written_at, kind
         FROM pending_recomputes WHERE donation_item_id = ?1`,
      )
      .bind(donationItemId)
      .first<D1PendingRecord>();
    return record === null ? null : toPendingRow(record);
  }

  async listStuck(olderThanISO: string, limit: number): Promise<StuckPending[]> {
    const res = await this.db
      .prepare(
        `SELECT donation_item_id, donation_board_id, received_at, kind FROM pending_recomputes
         WHERE status IN ('received', 'queued') AND received_at < ?1
         ORDER BY received_at LIMIT ?2`,
      )
      .bind(olderThanISO, limit)
      .all<{ donation_item_id: string; donation_board_id: string; received_at: string; kind: RecomputeKind }>();
    return res.results.map((r) => ({ donationItemId: r.donation_item_id, donationBoardId: r.donation_board_id, receivedAt: r.received_at, kind: r.kind }));
  }
}
