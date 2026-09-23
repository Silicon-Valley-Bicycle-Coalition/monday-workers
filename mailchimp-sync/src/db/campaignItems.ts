export interface CampaignItemRow {
  interestId: string;
  mondayItemId: string;
  name: string;
  archivedAt: string | null;
}

export interface CampaignItemsStore {
  listActive(): Promise<CampaignItemRow[]>;
  upsert(row: CampaignItemRow): Promise<void>;
  markArchived(interestId: string, archivedAt: string): Promise<void>;
  getByInterestId(interestId: string): Promise<CampaignItemRow | null>;
  /**
   * Atomically reserve the right to create the Monday item for an interest. True for
   * exactly one caller when the interest is untracked, archived, or held by a claim older
   * than `staleBefore`; false when a live item or a fresh claim already exists. A claimed
   * row is invisible to listActive/getByInterestId until `upsert` fills in its item id.
   */
  claim(interestId: string, name: string, now: string, staleBefore: string): Promise<boolean>;
}

interface D1CampaignItemRecord {
  interest_id: string;
  monday_item_id: string;
  name: string;
  archived_at: string | null;
}

function toRow(record: D1CampaignItemRecord): CampaignItemRow {
  return { interestId: record.interest_id, mondayItemId: record.monday_item_id, name: record.name, archivedAt: record.archived_at };
}

export class D1CampaignItemsStore implements CampaignItemsStore {
  constructor(private db: D1Database) {}

  async listActive(): Promise<CampaignItemRow[]> {
    const { results } = await this.db
      .prepare(`SELECT interest_id, monday_item_id, name, archived_at FROM campaign_items WHERE archived_at IS NULL AND monday_item_id != ''`)
      .all<D1CampaignItemRecord>();
    return results.map(toRow);
  }

  async upsert(row: CampaignItemRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO campaign_items (interest_id, monday_item_id, name, archived_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (interest_id) DO UPDATE SET
           monday_item_id = excluded.monday_item_id, name = excluded.name, archived_at = excluded.archived_at`,
      )
      .bind(row.interestId, row.mondayItemId, row.name, row.archivedAt)
      .run();
  }

  async markArchived(interestId: string, archivedAt: string): Promise<void> {
    await this.db
      .prepare(`UPDATE campaign_items SET archived_at = ?2 WHERE interest_id = ?1`)
      .bind(interestId, archivedAt)
      .run();
  }

  async claim(interestId: string, name: string, now: string, staleBefore: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO campaign_items (interest_id, monday_item_id, name, archived_at, claimed_at)
         VALUES (?1, '', ?2, NULL, ?3)
         ON CONFLICT (interest_id) DO UPDATE SET
           monday_item_id = '', name = excluded.name, archived_at = NULL, claimed_at = excluded.claimed_at
         WHERE campaign_items.archived_at IS NOT NULL
            OR (campaign_items.monday_item_id = '' AND campaign_items.claimed_at < ?4)`,
      )
      .bind(interestId, name, now, staleBefore)
      .run();
    return result.meta.changes === 1;
  }

  async getByInterestId(interestId: string): Promise<CampaignItemRow | null> {
    const record = await this.db
      .prepare(`SELECT interest_id, monday_item_id, name, archived_at FROM campaign_items WHERE interest_id = ?1 AND monday_item_id != ''`)
      .bind(interestId)
      .first<D1CampaignItemRecord>();
    return record === null ? null : toRow(record);
  }
}
