export interface LetterSendRow {
  id: number;
  donorItemId: string;
  year: number;
  status: 'queued' | 'sent' | 'skipped';
  createdAt: string;
  sentAt: string | null;
}

export interface LetterSendStore {
  findByDonorYear(donorItemId: string, year: number): Promise<{ id: number; status: 'queued' | 'sent' | 'skipped' } | null>;
  createQueued(params: { donorItemId: string; year: number; createdAt: string }): Promise<number>;
  getById(id: number): Promise<LetterSendRow | null>;
  markSent(id: number, sentAtISO: string): Promise<void>;
  markSkipped(id: number, atISO: string): Promise<void>;
  requeue(id: number, atISO: string): Promise<void>;
  // Every donor with a row for the year, any status — the January cron's dedupe pre-check, so
  // already-triggered donors cost zero Monday API calls on later runs.
  listDonorItemIdsForYear(year: number): Promise<Set<string>>;
}

export class D1LetterSendStore implements LetterSendStore {
  constructor(private db: D1Database) {}

  async findByDonorYear(donorItemId: string, year: number): Promise<{ id: number; status: 'queued' | 'sent' | 'skipped' } | null> {
    const row = await this.db
      .prepare(`SELECT id, status FROM letter_sends WHERE donor_item_id = ?1 AND year = ?2`)
      .bind(donorItemId, year)
      .first<{ id: number; status: 'queued' | 'sent' | 'skipped' }>();
    return row === null ? null : { id: row.id, status: row.status };
  }

  async createQueued(params: { donorItemId: string; year: number; createdAt: string }): Promise<number> {
    const result = await this.db
      .prepare(`INSERT INTO letter_sends (donor_item_id, year, created_at) VALUES (?1, ?2, ?3)`)
      .bind(params.donorItemId, params.year, params.createdAt)
      .run();
    return result.meta.last_row_id;
  }

  async getById(id: number): Promise<LetterSendRow | null> {
    const row = await this.db
      .prepare(`SELECT id, donor_item_id, year, status, created_at, sent_at FROM letter_sends WHERE id = ?1`)
      .bind(id)
      .first<{
        id: number;
        donor_item_id: string;
        year: number;
        status: 'queued' | 'sent' | 'skipped';
        created_at: string;
        sent_at: string | null;
      }>();
    if (row === null) return null;
    return {
      id: row.id,
      donorItemId: row.donor_item_id,
      year: row.year,
      status: row.status,
      createdAt: row.created_at,
      sentAt: row.sent_at,
    };
  }

  async markSent(id: number, sentAtISO: string): Promise<void> {
    await this.db
      .prepare(`UPDATE letter_sends SET status = 'sent', sent_at = ?1 WHERE id = ?2`)
      .bind(sentAtISO, id)
      .run();
  }

  async markSkipped(id: number, atISO: string): Promise<void> {
    await this.db
      .prepare(`UPDATE letter_sends SET status = 'skipped', sent_at = ?1 WHERE id = ?2`)
      .bind(atISO, id)
      .run();
  }

  async requeue(id: number, atISO: string): Promise<void> {
    await this.db
      .prepare(`UPDATE letter_sends SET status = 'queued', sent_at = ?1 WHERE id = ?2`)
      .bind(atISO, id)
      .run();
  }

  async listDonorItemIdsForYear(year: number): Promise<Set<string>> {
    const result = await this.db
      .prepare(`SELECT donor_item_id FROM letter_sends WHERE year = ?1`)
      .bind(year)
      .all<{ donor_item_id: string }>();
    return new Set(result.results.map((row) => row.donor_item_id));
  }
}
