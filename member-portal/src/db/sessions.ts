export interface NewSession {
  sessionHash: string;
  donorItemIds: string[];
  expiresAt: string;
  emailHash: string | null;
}

export interface SessionInfo {
  donorItemIds: string[];
  emailHash: string | null;
}

export interface SessionStore {
  createSession(params: NewSession): Promise<void>;
  getSession(sessionHash: string, nowISO: string): Promise<SessionInfo | null>;
  deleteSession(sessionHash: string): Promise<void>;
}

export class D1SessionStore implements SessionStore {
  constructor(private db: D1Database) {}

  async createSession(params: NewSession): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sessions (session_hash, donor_item_ids, expires_at, email_hash)
         VALUES (?1, ?2, ?3, ?4)`
      )
      .bind(params.sessionHash, JSON.stringify(params.donorItemIds), params.expiresAt, params.emailHash)
      .run();
  }

  async getSession(sessionHash: string, nowISO: string): Promise<SessionInfo | null> {
    const row = await this.db
      .prepare(`SELECT donor_item_ids, email_hash FROM sessions WHERE session_hash = ?1 AND expires_at > ?2`)
      .bind(sessionHash, nowISO)
      .first<{ donor_item_ids: string; email_hash: string | null }>();
    return row === null
      ? null
      : { donorItemIds: JSON.parse(row.donor_item_ids) as string[], emailHash: row.email_hash ?? null };
  }

  async deleteSession(sessionHash: string): Promise<void> {
    await this.db.prepare(`DELETE FROM sessions WHERE session_hash = ?1`).bind(sessionHash).run();
  }
}
