export interface DonationLink {
  donationItemId: string;
  donationBoardId: string;
  ownerItemId: string;
  ownerBoardId: string;
}

export interface DonationLinksStore {
  upsertLink(link: DonationLink, updatedAt: string): Promise<void>;
  // Grouped by donation_board_id, since fetching each donation's column values needs
  // that board's own column ids (see monday/client.ts getDonationsByIds).
  getLinksForOwner(ownerItemId: string): Promise<Map<string, string[]>>; // board id -> donation item ids
  bulkUpsert(links: (DonationLink & { updatedAt: string })[]): Promise<number>;
}

interface D1LinkRecord {
  donation_item_id: string;
  donation_board_id: string;
}

export class D1DonationLinksStore implements DonationLinksStore {
  constructor(private db: D1Database) {}

  async upsertLink(link: DonationLink, updatedAt: string): Promise<void> {
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
