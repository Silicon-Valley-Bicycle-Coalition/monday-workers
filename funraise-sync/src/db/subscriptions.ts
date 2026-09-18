export interface SubscriptionRow {
  funraiseId: string;
  mondayItemId: string;
  donorItemId: string | null;
  status: string;
  // Funraise `updtime` (epoch ms) last written to Monday; null for an item adopted from the
  // board and not yet rewritten by the poller.
  updtime: number | null;
  writtenAt: string;
}

export type NewSubscriptionRow = Omit<SubscriptionRow, 'writtenAt'>;

export interface SubscriptionStore {
  getByFunraiseId(funraiseId: string): Promise<SubscriptionRow | null>;
  upsert(row: NewSubscriptionRow): Promise<void>;
  count(): Promise<number>;
  getCursor(name: string): Promise<number>;
  setCursor(name: string, value: number): Promise<void>;
}

interface D1SubscriptionRecord {
  funraise_id: string;
  monday_item_id: string;
  donor_item_id: string | null;
  status: string;
  updtime: number | null;
  written_at: string;
}

export class D1SubscriptionStore implements SubscriptionStore {
  constructor(private db: D1Database) {}

  async getByFunraiseId(funraiseId: string): Promise<SubscriptionRow | null> {
    const record = await this.db
      .prepare(`SELECT funraise_id, monday_item_id, donor_item_id, status, updtime, written_at FROM subscriptions WHERE funraise_id = ?1`)
      .bind(funraiseId)
      .first<D1SubscriptionRecord>();
    if (!record) return null;
    return {
      funraiseId: record.funraise_id,
      mondayItemId: record.monday_item_id,
      donorItemId: record.donor_item_id,
      status: record.status,
      updtime: record.updtime,
      writtenAt: record.written_at,
    };
  }

  async upsert(row: NewSubscriptionRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO subscriptions (funraise_id, monday_item_id, donor_item_id, status, updtime, written_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (funraise_id) DO UPDATE SET
           monday_item_id = excluded.monday_item_id,
           donor_item_id = excluded.donor_item_id,
           status = excluded.status,
           updtime = excluded.updtime,
           written_at = excluded.written_at`
      )
      .bind(row.funraiseId, row.mondayItemId, row.donorItemId, row.status, row.updtime, new Date().toISOString())
      .run();
  }

  async count(): Promise<number> {
    const result = await this.db.prepare(`SELECT COUNT(*) AS n FROM subscriptions`).first<{ n: number }>();
    return result?.n ?? 0;
  }

  async getCursor(name: string): Promise<number> {
    const result = await this.db.prepare(`SELECT value FROM poll_cursors WHERE name = ?1`).bind(name).first<{ value: number }>();
    return result?.value ?? 0;
  }

  async setCursor(name: string, value: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO poll_cursors (name, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .bind(name, value, new Date().toISOString())
      .run();
  }
}
