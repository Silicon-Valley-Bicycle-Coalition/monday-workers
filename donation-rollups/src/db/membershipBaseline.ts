import type { MembershipState, Tier } from '../membership/derive';

// One row per owner — the membership state the board held before this Worker's first
// membership write to that owner (spec §"Baseline"). Written once, read on every recompute.
export interface BaselineRow extends MembershipState {
  ownerItemId: string;
  ownerBoardId: string;
  capturedAt: string;
}

export interface MembershipBaselineStore {
  get(ownerItemId: string): Promise<BaselineRow | null>;
  // Insert-if-absent. Returns what is stored afterwards: the new row, or the existing one
  // when a concurrent recompute for the same owner got there first.
  captureIfAbsent(row: BaselineRow): Promise<BaselineRow>;
}

interface D1Row {
  owner_item_id: string; owner_board_id: string;
  since: string | null; until: string | null; tier: string | null; captured_at: string;
}

const fromRow = (r: D1Row): BaselineRow => ({
  ownerItemId: r.owner_item_id, ownerBoardId: r.owner_board_id,
  since: r.since, until: r.until, tier: r.tier as Tier | null, capturedAt: r.captured_at,
});

export class D1MembershipBaselineStore implements MembershipBaselineStore {
  constructor(private db: D1Database) {}

  async get(ownerItemId: string): Promise<BaselineRow | null> {
    const r = await this.db
      .prepare(`SELECT owner_item_id, owner_board_id, since, until, tier, captured_at
                FROM membership_baseline WHERE owner_item_id = ?1`)
      .bind(ownerItemId)
      .first<D1Row>();
    return r === null ? null : fromRow(r);
  }

  async captureIfAbsent(row: BaselineRow): Promise<BaselineRow> {
    await this.db
      .prepare(`INSERT INTO membership_baseline (owner_item_id, owner_board_id, since, until, tier, captured_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT (owner_item_id) DO NOTHING`)
      .bind(row.ownerItemId, row.ownerBoardId, row.since, row.until, row.tier, row.capturedAt)
      .run();
    return (await this.get(row.ownerItemId))!;
  }
}
