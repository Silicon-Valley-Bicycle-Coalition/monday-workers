import type { UnsubscribeResult } from '../mailchimp/client';

export interface DnsUnsubscribeLog {
  has(email: string): Promise<boolean>;
  record(email: string, donorItemId: string, result: UnsubscribeResult, at: string): Promise<void>;
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export class D1DnsUnsubscribeLog implements DnsUnsubscribeLog {
  constructor(private db: D1Database) {}

  async has(email: string): Promise<boolean> {
    const row = await this.db.prepare(`SELECT 1 FROM dns_unsubscribes WHERE email = ?1`).bind(normalize(email)).first();
    return row !== null;
  }

  // First record wins: the row is the audit trail of the unsubscribe that actually happened.
  async record(email: string, donorItemId: string, result: UnsubscribeResult, at: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dns_unsubscribes (email, donor_item_id, result, unsubscribed_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (email) DO NOTHING`,
      )
      .bind(normalize(email), donorItemId, result, at)
      .run();
  }
}
