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
      .prepare(`SELECT interest_id, monday_item_id, name, archived_at FROM campaign_items WHERE archived_at IS NULL`)
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

  async getByInterestId(interestId: string): Promise<CampaignItemRow | null> {
    const record = await this.db
      .prepare(`SELECT interest_id, monday_item_id, name, archived_at FROM campaign_items WHERE interest_id = ?1`)
      .bind(interestId)
      .first<D1CampaignItemRecord>();
    return record === null ? null : toRow(record);
  }
}
