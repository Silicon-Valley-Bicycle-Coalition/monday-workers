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
  // Issue #88: SHA-256 of the owner column values / description last written to Monday. null =
  // unknown (or the description write failed): the next recompute writes. A recompute whose
  // values hash to the same skip that mutation.
  valuesHash?: string | null;
  descriptionHash?: string | null;
}

export interface OwnerRecomputesStore {
  get(ownerItemId: string): Promise<OwnerRecompute | null>;
  record(row: OwnerRecompute): Promise<void>;
  // Owners recomputed at/after an instant — the membership duty's all=true pass skips them: a
  // recompute after its phases 1–2 finished (or after the caller's `since`) already saw the
  // loaded history.
  writtenSince(iso: string): Promise<Set<string>>;
  // One recompute per owner at a time (migration 0010): true when this holder now has the lease,
  // false while another holder's lease is unexpired. Release is a no-op for anyone but the holder.
  acquireLease(ownerItemId: string, holder: string, nowISO: string, expiresAtISO: string): Promise<boolean>;
  releaseLease(ownerItemId: string, holder: string): Promise<void>;
}

interface D1Row {
  owner_item_id: string; owner_board_id: string; fetched_at: string; written_at: string;
  values_hash: string | null; description_hash: string | null;
}

export class D1OwnerRecomputesStore implements OwnerRecomputesStore {
  constructor(private db: D1Database) {}

  async get(ownerItemId: string): Promise<OwnerRecompute | null> {
    const r = await this.db
      .prepare(`SELECT owner_item_id, owner_board_id, fetched_at, written_at, values_hash, description_hash FROM owner_recomputes WHERE owner_item_id = ?1`)
      .bind(ownerItemId)
      .first<D1Row>();
    return r === null ? null
      : { ownerItemId: r.owner_item_id, ownerBoardId: r.owner_board_id, fetchedAt: r.fetched_at, writtenAt: r.written_at,
        valuesHash: r.values_hash, descriptionHash: r.description_hash };
  }

  async record(row: OwnerRecompute): Promise<void> {
    await this.db
      .prepare(`INSERT INTO owner_recomputes (owner_item_id, owner_board_id, fetched_at, written_at, values_hash, description_hash)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT (owner_item_id) DO UPDATE SET
                  owner_board_id = excluded.owner_board_id,
                  fetched_at = excluded.fetched_at,
                  written_at = excluded.written_at,
                  values_hash = excluded.values_hash,
                  description_hash = excluded.description_hash`)
      .bind(row.ownerItemId, row.ownerBoardId, row.fetchedAt, row.writtenAt, row.valuesHash ?? null, row.descriptionHash ?? null)
      .run();
  }

  async writtenSince(iso: string): Promise<Set<string>> {
    const res = await this.db
      .prepare(`SELECT owner_item_id FROM owner_recomputes WHERE written_at >= ?1`)
      .bind(iso)
      .all<{ owner_item_id: string }>();
    return new Set(res.results.map((r) => r.owner_item_id));
  }

  async acquireLease(ownerItemId: string, holder: string, nowISO: string, expiresAtISO: string): Promise<boolean> {
    const row = await this.db
      .prepare(`INSERT INTO owner_leases (owner_item_id, holder, expires_at) VALUES (?1, ?2, ?3)
                ON CONFLICT (owner_item_id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
                WHERE owner_leases.expires_at <= ?4
                RETURNING holder`)
      .bind(ownerItemId, holder, expiresAtISO, nowISO)
      .first<{ holder: string }>();
    return row?.holder === holder;
  }

  async releaseLease(ownerItemId: string, holder: string): Promise<void> {
    await this.db.prepare(`DELETE FROM owner_leases WHERE owner_item_id = ?1 AND holder = ?2`).bind(ownerItemId, holder).run();
  }
}
