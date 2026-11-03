/** camelCase mirror of a `dtd_records` row. */
export interface StoredRecord {
  donationIdentifier: string;
  mondayItemId: string | null;
  source: string | null;
  status: string | null;
  matchingGiftStatus: string | null;
  employerStatus: string | null;
  companyId: string | null;
  companyName: string | null;
  matchedAmount: number | null;
  donationDatetime: string | null;
  updatedSeenAt: string;
  unmatched: boolean;
  /** SHA-256 hex of the DTD donor email (trimmed, lowercased); the raw email is never stored. */
  donorEmailHash: string | null;
  donationAmount: number | null;
}

interface Row {
  donation_identifier: string;
  monday_item_id: string | null;
  source: string | null;
  status: string | null;
  matching_gift_status: string | null;
  employer_status: string | null;
  company_id: string | null;
  company_name: string | null;
  matched_amount: number | null;
  donation_datetime: string | null;
  updated_seen_at: string;
  unmatched: number;
  donor_email_hash: string | null;
  donation_amount: number | null;
}

function fromRow(r: Row): StoredRecord {
  return {
    donationIdentifier: r.donation_identifier,
    mondayItemId: r.monday_item_id,
    source: r.source,
    status: r.status,
    matchingGiftStatus: r.matching_gift_status,
    employerStatus: r.employer_status,
    companyId: r.company_id,
    companyName: r.company_name,
    matchedAmount: r.matched_amount,
    donationDatetime: r.donation_datetime,
    updatedSeenAt: r.updated_seen_at,
    unmatched: r.unmatched === 1,
    donorEmailHash: r.donor_email_hash,
    donationAmount: r.donation_amount,
  };
}

export async function getRecord(db: D1Database, identifier: string): Promise<StoredRecord | null> {
  const row = await db.prepare('SELECT * FROM dtd_records WHERE donation_identifier = ?').bind(identifier).first<Row>();
  return row ? fromRow(row) : null;
}

export async function upsertRecord(db: D1Database, r: StoredRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dtd_records (donation_identifier, monday_item_id, source, status, matching_gift_status, employer_status,
         company_id, company_name, matched_amount, donation_datetime, updated_seen_at, unmatched, donor_email_hash, donation_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(donation_identifier) DO UPDATE SET
         monday_item_id = excluded.monday_item_id, source = excluded.source, status = excluded.status,
         matching_gift_status = excluded.matching_gift_status, employer_status = excluded.employer_status,
         company_id = excluded.company_id, company_name = excluded.company_name, matched_amount = excluded.matched_amount,
         donation_datetime = excluded.donation_datetime, updated_seen_at = excluded.updated_seen_at,
         unmatched = excluded.unmatched, donor_email_hash = excluded.donor_email_hash,
         donation_amount = excluded.donation_amount`,
    )
    .bind(
      r.donationIdentifier, r.mondayItemId, r.source, r.status, r.matchingGiftStatus, r.employerStatus,
      r.companyId, r.companyName, r.matchedAmount, r.donationDatetime, r.updatedSeenAt, r.unmatched ? 1 : 0,
      r.donorEmailHash, r.donationAmount,
    )
    .run();
}

/** Records still waiting for a Monday Donations item, longest-waiting first. */
export async function listUnmatched(db: D1Database, limit: number): Promise<StoredRecord[]> {
  const { results } = await db
    .prepare('SELECT * FROM dtd_records WHERE unmatched = 1 ORDER BY updated_seen_at ASC, donation_identifier ASC LIMIT ?')
    .bind(limit)
    .all<Row>();
  return results.map(fromRow);
}

/**
 * Verified records (unmatched = 0 with an item link) whose donation_datetime is in [startISO, endISO),
 * compared as ISO strings. Unverified records, possibly forged via DTD's public key, are never counted.
 */
export async function recordsForFiscalYear(db: D1Database, startISO: string, endISO: string): Promise<StoredRecord[]> {
  const { results } = await db
    .prepare('SELECT * FROM dtd_records WHERE donation_datetime >= ? AND donation_datetime < ? AND unmatched = 0 AND monday_item_id IS NOT NULL ORDER BY donation_datetime ASC')
    .bind(startISO, endISO)
    .all<Row>();
  return results.map(fromRow);
}

export async function hasDtdRecordForItem(db: D1Database, mondayItemId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS one FROM dtd_records WHERE monday_item_id = ? LIMIT 1').bind(mondayItemId).first();
  return row !== null;
}

/** company_name of the most recently seen record linked to this Monday item, or null. */
export async function companyForItem(db: D1Database, mondayItemId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT company_name FROM dtd_records WHERE monday_item_id = ? ORDER BY updated_seen_at DESC LIMIT 1')
    .bind(mondayItemId)
    .first<{ company_name: string | null }>();
  return row?.company_name ?? null;
}
