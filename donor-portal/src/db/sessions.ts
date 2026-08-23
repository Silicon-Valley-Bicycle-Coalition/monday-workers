export interface NewSession {
  sessionHash: string;
  donorItemIds: string[];
  expiresAt: string;
}

export interface SessionStore {
  createSession(params: NewSession): Promise<void>;
  getSession(sessionHash: string, nowISO: string): Promise<string[] | null>;
  deleteSession(sessionHash: string): Promise<void>;
}

export class D1SessionStore implements SessionStore {
  constructor(private db: D1Database) {}

  async createSession(params: NewSession): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sessions (session_hash, donor_item_ids, expires_at)
         VALUES (?1, ?2, ?3)`
      )
      .bind(params.sessionHash, JSON.stringify(params.donorItemIds), params.expiresAt)
      .run();
  }

  async getSession(sessionHash: string, nowISO: string): Promise<string[] | null> {
    const row = await this.db
      .prepare(`SELECT donor_item_ids FROM sessions WHERE session_hash = ?1 AND expires_at > ?2`)
      .bind(sessionHash, nowISO)
      .first<{ donor_item_ids: string }>();
    return row === null ? null : (JSON.parse(row.donor_item_ids) as string[]);
  }

  async deleteSession(sessionHash: string): Promise<void> {
    await this.db.prepare(`DELETE FROM sessions WHERE session_hash = ?1`).bind(sessionHash).run();
  }
}
