export interface DonationLink {
  donationItemId: string;
  donationBoardId: string;
  ownerItemId: string;
  ownerBoardId: string;
}

export interface DonationLinksStore {
  // Diff-aware: an unchanged link costs no write and keeps its stored updated_at, so the
  // returned updatedAt is when this link LAST CHANGED — the consumer's coalescing rule compares
  // it against the owner's last recompute fetch (a link that changed after that fetch wasn't
  // covered by it). `changed` is true for a new or re-owned link. `previousOwner` is set only
  // when the donation moved from a different owner, which must be recomputed too (issue #26).
  upsertLink(link: DonationLink, updatedAt: string):
    Promise<{ changed: boolean; updatedAt: string; previousOwner?: { ownerItemId: string; ownerBoardId: string } }>;
  // Grouped by donation_board_id, since fetching each donation's column values needs
  // that board's own column ids (see monday/client.ts getDonationsByIds).
  getLinksForOwner(ownerItemId: string): Promise<Map<string, string[]>>; // board id -> donation item ids
  // The owner D1 already knows for one donation — the fallback when Monday's
  // board_relation reads back empty because the item is archived (see
  // projections/giftHistory.ts and consumer/processBatch.ts).
  getLinkForDonation(donationItemId: string): Promise<{ ownerItemId: string; ownerBoardId: string } | null>;
  bulkUpsert(links: (DonationLink & { updatedAt: string })[]): Promise<number>;
  // Drops a donation from the reverse index — deleted on Monday, or its Donor link cleared.
  deleteLink(donationItemId: string): Promise<void>;
}

interface D1LinkRecord {
  donation_item_id: string;
  donation_board_id: string;
}

export class D1DonationLinksStore implements DonationLinksStore {
  constructor(private db: D1Database) {}

  async upsertLink(link: DonationLink, updatedAt: string):
    Promise<{ changed: boolean; updatedAt: string; previousOwner?: { ownerItemId: string; ownerBoardId: string } }> {
    const existing = await this.db
      .prepare(`SELECT donation_board_id, owner_item_id, owner_board_id, updated_at FROM donation_links WHERE donation_item_id = ?1`)
      .bind(link.donationItemId)
      .first<{ donation_board_id: string; owner_item_id: string; owner_board_id: string; updated_at: string }>();
    if (existing !== null
      && existing.donation_board_id === link.donationBoardId
      && existing.owner_item_id === link.ownerItemId
      && existing.owner_board_id === link.ownerBoardId) {
      return { changed: false, updatedAt: existing.updated_at };
    }
    await this.db
      .prepare(
        `INSERT INTO donation_links (donation_item_id, donation_board_id, owner_item_id, owner_board_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (donation_item_id) DO UPDATE SET
           donation_board_id = excluded.donation_board_id,
           owner_item_id = excluded.owner_item_id,
           owner_board_id = excluded.owner_board_id,
           updated_at = excluded.updated_at`,
      )
      .bind(link.donationItemId, link.donationBoardId, link.ownerItemId, link.ownerBoardId, updatedAt)
      .run();
    const moved = existing !== null && existing.owner_item_id !== link.ownerItemId;
    return moved
      ? { changed: true, updatedAt, previousOwner: { ownerItemId: existing.owner_item_id, ownerBoardId: existing.owner_board_id } }
      : { changed: true, updatedAt };
  }

  async deleteLink(donationItemId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM donation_links WHERE donation_item_id = ?1`).bind(donationItemId).run();
  }

  async getLinksForOwner(ownerItemId: string): Promise<Map<string, string[]>> {
    const result = await this.db
      .prepare(`SELECT donation_item_id, donation_board_id FROM donation_links WHERE owner_item_id = ?1`)
      .bind(ownerItemId)
      .all<D1LinkRecord>();
    const byBoard = new Map<string, string[]>();
    for (const row of result.results) {
      const list = byBoard.get(row.donation_board_id) ?? [];
      list.push(row.donation_item_id);
      byBoard.set(row.donation_board_id, list);
    }
    return byBoard;
  }

  async getLinkForDonation(donationItemId: string): Promise<{ ownerItemId: string; ownerBoardId: string } | null> {
    const row = await this.db
      .prepare(`SELECT owner_item_id, owner_board_id FROM donation_links WHERE donation_item_id = ?1`)
      .bind(donationItemId)
      .first<{ owner_item_id: string; owner_board_id: string }>();
    return row === null ? null : { ownerItemId: row.owner_item_id, ownerBoardId: row.owner_board_id };
  }

  // Batched (D1 has a per-statement bind-parameter ceiling) — used by the one-time
  // bootstrap import, not by normal webhook processing (that's upsertLink, one row
  // at a time via the queue consumer).
  async bulkUpsert(links: (DonationLink & { updatedAt: string })[]): Promise<number> {
    const BATCH = 100;
    let written = 0;
    for (let i = 0; i < links.length; i += BATCH) {
      const chunk = links.slice(i, i + BATCH);
      const stmts = chunk.map((l) =>
        this.db
          .prepare(
            `INSERT INTO donation_links (donation_item_id, donation_board_id, owner_item_id, owner_board_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (donation_item_id) DO UPDATE SET
               donation_board_id = excluded.donation_board_id,
               owner_item_id = excluded.owner_item_id,
               owner_board_id = excluded.owner_board_id,
               updated_at = excluded.updated_at`,
          )
          .bind(l.donationItemId, l.donationBoardId, l.ownerItemId, l.ownerBoardId, l.updatedAt));
      await this.db.batch(stmts);
      written += chunk.length;
    }
    return written;
  }
}
