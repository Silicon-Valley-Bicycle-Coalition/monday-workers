export interface AliasStore {
  getAlias(rawCompanyName: string): Promise<string | null>;
  learnAlias(rawCompanyName: string, organizationItemId: string, learnedAt: string): Promise<void>;
}

export class D1AliasStore implements AliasStore {
  constructor(private db: D1Database) {}

  async getAlias(rawCompanyName: string): Promise<string | null> {
    const record = await this.db
      .prepare(`SELECT organization_item_id FROM aliases WHERE raw_company_name = ?1`)
      .bind(rawCompanyName)
      .first<{ organization_item_id: string }>();
    return record === null ? null : record.organization_item_id;
  }

  async learnAlias(rawCompanyName: string, organizationItemId: string, learnedAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO aliases (raw_company_name, organization_item_id, learned_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT (raw_company_name) DO UPDATE SET
           organization_item_id = excluded.organization_item_id,
           learned_at = excluded.learned_at`
      )
      .bind(rawCompanyName, organizationItemId, learnedAt)
      .run();
  }
}
