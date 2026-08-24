export type ChangeRequestField = 'address' | 'email' | 'phone';

export interface NewChangeRequest {
  donorItemId: string;
  donorName: string;
  field: ChangeRequestField;
  oldValue: string;
  newValue: string;
  dedupeHash: string;
  createdAt: string;
}

export interface ChangeRequestRow {
  id: number;
  donorItemId: string;
  donorName: string;
  field: ChangeRequestField;
  oldValue: string;
  newValue: string;
  status: 'queued' | 'written';
}

export interface ChangeRequestStore {
  createRequest(params: NewChangeRequest): Promise<number>;
  hasRecentDuplicate(dedupeHash: string, sinceISO: string): Promise<boolean>;
  getRequest(id: number): Promise<ChangeRequestRow | null>;
  markWritten(id: number, writtenAtISO: string): Promise<void>;
}

export class D1ChangeRequestStore implements ChangeRequestStore {
  constructor(private db: D1Database) {}

  async createRequest(params: NewChangeRequest): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO change_requests (donor_item_id, donor_name, field, old_value, new_value, dedupe_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind(
        params.donorItemId,
        params.donorName,
        params.field,
        params.oldValue,
        params.newValue,
        params.dedupeHash,
        params.createdAt
      )
      .run();
    return result.meta.last_row_id;
  }

  async hasRecentDuplicate(dedupeHash: string, sinceISO: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS found FROM change_requests WHERE dedupe_hash = ?1 AND created_at > ?2 LIMIT 1`)
      .bind(dedupeHash, sinceISO)
      .first<{ found: number }>();
    return row !== null;
  }

  async getRequest(id: number): Promise<ChangeRequestRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, donor_item_id, donor_name, field, old_value, new_value, status
         FROM change_requests WHERE id = ?1`
      )
      .bind(id)
      .first<{
        id: number;
        donor_item_id: string;
        donor_name: string;
        field: ChangeRequestField;
        old_value: string;
        new_value: string;
        status: 'queued' | 'written';
      }>();
    if (row === null) return null;
    return {
      id: row.id,
      donorItemId: row.donor_item_id,
      donorName: row.donor_name,
      field: row.field,
      oldValue: row.old_value,
      newValue: row.new_value,
      status: row.status,
    };
  }

  async markWritten(id: number, writtenAtISO: string): Promise<void> {
    await this.db
      .prepare(`UPDATE change_requests SET status = 'written', written_at = ?1 WHERE id = ?2`)
      .bind(writtenAtISO, id)
      .run();
  }
}
