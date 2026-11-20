import type { LetterSendStatus } from './letterSends';

// One row per organization statement email queued for a rep, keyed (organization, Affiliation,
// year) — migration 0009. Same status contract as letter_sends: 'sending' means an email may have
// gone out, and it is never sent again automatically (see processOrgStatementSend).
export type OrgStatementSendStatus = LetterSendStatus;

export interface OrgStatementSendRow {
  id: number;
  orgItemId: string;
  affiliationItemId: string;
  year: number;
  status: OrgStatementSendStatus;
  createdAt: string;
  sentAt: string | null;
}

export interface OrgStatementSendStore {
  // Every `${orgItemId}:${affiliationItemId}` with a row for the year, any status — the January
  // pass's dedupe pre-check.
  listKeysForYear(year: number): Promise<Set<string>>;
  createQueued(params: { orgItemId: string; affiliationItemId: string; year: number; createdAt: string }): Promise<number>;
  findByKey(orgItemId: string, affiliationItemId: string, year: number): Promise<OrgStatementSendRow | null>;
  getById(id: number): Promise<OrgStatementSendRow | null>;
  // queued → sending, atomically; false when the row isn't 'queued' (another delivery claimed it).
  claimForSending(id: number, nowISO: string): Promise<boolean>;
  // sending → queued, only when the send itself failed (nothing went out) so a retry may send.
  releaseClaim(id: number): Promise<void>;
  markSent(id: number, nowISO: string): Promise<void>;
  markSkipped(id: number, nowISO: string): Promise<void>;
  requeue(id: number, nowISO: string): Promise<void>;
}

export const orgStatementKey = (orgItemId: string, affiliationItemId: string): string => `${orgItemId}:${affiliationItemId}`;

interface Row {
  id: number;
  org_item_id: string;
  affiliation_item_id: string;
  year: number;
  status: OrgStatementSendStatus;
  created_at: string;
  sent_at: string | null;
}

const COLUMNS = 'id, org_item_id, affiliation_item_id, year, status, created_at, sent_at';

function fromRow(row: Row): OrgStatementSendRow {
  return {
    id: row.id,
    orgItemId: row.org_item_id,
    affiliationItemId: row.affiliation_item_id,
    year: row.year,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

export class D1OrgStatementSendStore implements OrgStatementSendStore {
  constructor(private db: D1Database) {}

  async listKeysForYear(year: number): Promise<Set<string>> {
    const result = await this.db
      .prepare(`SELECT org_item_id, affiliation_item_id FROM org_statement_sends WHERE year = ?1`)
      .bind(year)
      .all<{ org_item_id: string; affiliation_item_id: string }>();
    return new Set(result.results.map((row) => orgStatementKey(row.org_item_id, row.affiliation_item_id)));
  }

  async createQueued(params: { orgItemId: string; affiliationItemId: string; year: number; createdAt: string }): Promise<number> {
    const result = await this.db
      .prepare(`INSERT INTO org_statement_sends (org_item_id, affiliation_item_id, year, created_at) VALUES (?1, ?2, ?3, ?4)`)
      .bind(params.orgItemId, params.affiliationItemId, params.year, params.createdAt)
      .run();
    return result.meta.last_row_id;
  }

  async findByKey(orgItemId: string, affiliationItemId: string, year: number): Promise<OrgStatementSendRow | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM org_statement_sends WHERE org_item_id = ?1 AND affiliation_item_id = ?2 AND year = ?3`)
      .bind(orgItemId, affiliationItemId, year)
      .first<Row>();
    return row === null ? null : fromRow(row);
  }

  async getById(id: number): Promise<OrgStatementSendRow | null> {
    const row = await this.db.prepare(`SELECT ${COLUMNS} FROM org_statement_sends WHERE id = ?1`).bind(id).first<Row>();
    return row === null ? null : fromRow(row);
  }

  async claimForSending(id: number, nowISO: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE org_statement_sends SET status = 'sending', sent_at = ?1 WHERE id = ?2 AND status = 'queued'`)
      .bind(nowISO, id)
      .run();
    return result.meta.changes === 1;
  }

  async releaseClaim(id: number): Promise<void> {
    await this.db
      .prepare(`UPDATE org_statement_sends SET status = 'queued', sent_at = NULL WHERE id = ?1 AND status = 'sending'`)
      .bind(id)
      .run();
  }

  async markSent(id: number, nowISO: string): Promise<void> {
    await this.setStatus(id, 'sent', nowISO);
  }

  async markSkipped(id: number, nowISO: string): Promise<void> {
    await this.setStatus(id, 'skipped', nowISO);
  }

  async requeue(id: number, nowISO: string): Promise<void> {
    await this.setStatus(id, 'queued', nowISO);
  }

  private async setStatus(id: number, status: OrgStatementSendStatus, nowISO: string): Promise<void> {
    await this.db.prepare(`UPDATE org_statement_sends SET status = ?1, sent_at = ?2 WHERE id = ?3`).bind(status, nowISO, id).run();
  }
}
