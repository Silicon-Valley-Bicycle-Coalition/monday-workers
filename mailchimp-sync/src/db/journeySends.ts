// The Journey send log's ledger (migration 0007). Rows are keyed on the Mailchimp subscriber hash
// (email_id), never the address.

export type JourneySendStatus = 'pending' | 'logged' | 'unmatched' | 'ambiguous' | 'failed' | 'dropped';
export type UnresolvedStatus = 'unmatched' | 'ambiguous' | 'failed';
export type Delivery = 'sent' | 'hard' | 'soft';

export interface NewJourneySend {
  campaignId: string;
  emailId: string;
  journeyId: number;
  stepId: number;
  delivery: Delivery;
}

export interface PendingJourneySend extends NewJourneySend {
  firstSeenAt: string;
  attempts: number;
}

export interface JourneySendStore {
  // campaign id → sent-to rows at its last full read.
  getCounts(): Promise<Map<string, number>>;
  setCount(campaignId: string, count: number, at: string): Promise<void>;
  // Inserts each row not already present with `status`; returns how many were new.
  insertNew(rows: readonly NewJourneySend[], status: 'pending' | 'dropped', at: string): Promise<number>;
  listPending(limit: number): Promise<PendingJourneySend[]>;
  markLogged(campaignId: string, emailId: string, peopleItemId: string, sentAt: string, at: string): Promise<void>;
  markUnresolved(campaignId: string, emailId: string, status: UnresolvedStatus): Promise<void>;
  // A failed attempt leaves the row pending for the next run.
  recordAttempt(campaignId: string, emailId: string): Promise<void>;
}

// D1 caps bound parameters per statement at 100; 6 per row.
const INSERT_CHUNK = 15;

export class D1JourneySendStore implements JourneySendStore {
  constructor(private db: D1Database) {}

  async getCounts(): Promise<Map<string, number>> {
    const { results } = await this.db.prepare(`SELECT campaign_id, sent_to_count FROM journey_email_counts`)
      .all<{ campaign_id: string; sent_to_count: number }>();
    return new Map(results.map((r) => [r.campaign_id, r.sent_to_count]));
  }

  async setCount(campaignId: string, count: number, at: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO journey_email_counts (campaign_id, sent_to_count, read_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (campaign_id) DO UPDATE SET sent_to_count = excluded.sent_to_count, read_at = excluded.read_at`,
    ).bind(campaignId, count, at).run();
  }

  async insertNew(rows: readonly NewJourneySend[], status: 'pending' | 'dropped', at: string): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const values = chunk.map((_, n) => `(?${n * 6 + 1}, ?${n * 6 + 2}, ?${n * 6 + 3}, ?${n * 6 + 4}, ?${n * 6 + 5}, '${status}', ?${n * 6 + 6})`).join(', ');
      const params = chunk.flatMap((r) => [r.campaignId, r.emailId, r.journeyId, r.stepId, r.delivery, at]);
      const result = await this.db.prepare(
        `INSERT INTO journey_sends (campaign_id, email_id, journey_id, step_id, delivery, status, first_seen_at)
         VALUES ${values} ON CONFLICT (campaign_id, email_id) DO NOTHING`,
      ).bind(...params).run();
      inserted += result.meta.changes ?? 0;
    }
    return inserted;
  }

  async listPending(limit: number): Promise<PendingJourneySend[]> {
    const { results } = await this.db.prepare(
      `SELECT campaign_id, email_id, journey_id, step_id, delivery, first_seen_at, attempts FROM journey_sends
       WHERE status = 'pending' ORDER BY first_seen_at, campaign_id, email_id LIMIT ?1`,
    ).bind(limit).all<{ campaign_id: string; email_id: string; journey_id: number; step_id: number; delivery: Delivery; first_seen_at: string; attempts: number }>();
    return results.map((r) => ({
      campaignId: r.campaign_id, emailId: r.email_id, journeyId: r.journey_id, stepId: r.step_id,
      delivery: r.delivery, firstSeenAt: r.first_seen_at, attempts: r.attempts,
    }));
  }

  async markLogged(campaignId: string, emailId: string, peopleItemId: string, sentAt: string, at: string): Promise<void> {
    await this.db.prepare(
      `UPDATE journey_sends SET status = 'logged', people_item_id = ?3, sent_at = ?4, logged_at = ?5
       WHERE campaign_id = ?1 AND email_id = ?2`,
    ).bind(campaignId, emailId, peopleItemId, sentAt, at).run();
  }

  async markUnresolved(campaignId: string, emailId: string, status: UnresolvedStatus): Promise<void> {
    await this.db.prepare(`UPDATE journey_sends SET status = ?3 WHERE campaign_id = ?1 AND email_id = ?2`)
      .bind(campaignId, emailId, status).run();
  }

  async recordAttempt(campaignId: string, emailId: string): Promise<void> {
    await this.db.prepare(`UPDATE journey_sends SET attempts = attempts + 1 WHERE campaign_id = ?1 AND email_id = ?2`)
      .bind(campaignId, emailId).run();
  }
}
