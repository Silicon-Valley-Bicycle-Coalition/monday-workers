// Per-owner recompute coalescing (README "operational findings, 2026-09-17", fix 3): one row per
// owner recording when this Worker last READ that owner's donations from Monday and when the
// resulting write landed. Written only by a successful recompute — a failed one leaves the
// previous row, so its retry is never coalesced away. See consumer/processBatch.ts for the
// two-part freshness rule that consults it.
export interface OwnerRecompute {
  ownerItemId: string;
  ownerBoardId: string;
  fetchedAt: string; // ISO; taken immediately before the Monday donations fetch
  writtenAt: string; // ISO; after every required Monday write succeeded
}

export interface OwnerRecomputesStore {
  get(ownerItemId: string): Promise<OwnerRecompute | null>;
  record(row: OwnerRecompute): Promise<void>;
}

interface D1Row { owner_item_id: string; owner_board_id: string; fetched_at: string; written_at: string }

export class D1OwnerRecomputesStore implements OwnerRecomputesStore {
  constructor(private db: D1Database) {}

  async get(ownerItemId: string): Promise<OwnerRecompute | null> {
    const r = await this.db
      .prepare(`SELECT owner_item_id, owner_board_id, fetched_at, written_at FROM owner_recomputes WHERE owner_item_id = ?1`)
      .bind(ownerItemId)
      .first<D1Row>();
    return r === null ? null
      : { ownerItemId: r.owner_item_id, ownerBoardId: r.owner_board_id, fetchedAt: r.fetched_at, writtenAt: r.written_at };
  }

  async record(row: OwnerRecompute): Promise<void> {
    await this.db
      .prepare(`INSERT INTO owner_recomputes (owner_item_id, owner_board_id, fetched_at, written_at)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT (owner_item_id) DO UPDATE SET
                  owner_board_id = excluded.owner_board_id,
                  fetched_at = excluded.fetched_at,
                  written_at = excluded.written_at`)
      .bind(row.ownerItemId, row.ownerBoardId, row.fetchedAt, row.writtenAt)
      .run();
  }
}
