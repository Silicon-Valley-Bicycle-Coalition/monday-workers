export type RowStatus = 'ingested' | 'written' | 'needs-review' | 'skipped';

export interface DonationRowRecord {
  transactionId: string;
  disbursementId: number;
  status: RowStatus;
  mondayEmployeeItemId: string | null;
  mondayMatchItemId: string | null;
  rawRow: string;
  error: string | null;
  ingestedAt: string;
  writtenAt: string | null;
}

export interface NewRow {
  transactionId: string;
  disbursementId: number;
  rawRow: string;
  status: RowStatus;
  ingestedAt: string;
}

export interface RowStatusPatch {
  mondayEmployeeItemId?: string;
  mondayMatchItemId?: string;
  error?: string;
  writtenAt?: string;
}

export type UpsertRowResult = 'inserted' | 'duplicate';

export interface RowStore {
  upsertRow(row: NewRow): Promise<UpsertRowResult>;
  getRow(transactionId: string): Promise<DonationRowRecord | null>;
  updateStatus(transactionId: string, status: RowStatus, patch?: RowStatusPatch): Promise<void>;
  purgeWrittenRawRows(writtenBefore: string): Promise<number>;
  purgeUnresolvedRawRows(ingestedBefore: string): Promise<number>;
}

interface D1RowRecord {
  transaction_id: string;
  disbursement_id: number;
  status: RowStatus;
  monday_employee_item_id: string | null;
  monday_match_item_id: string | null;
  raw_row: string;
  error: string | null;
  ingested_at: string;
  written_at: string | null;
}

function toRow(record: D1RowRecord): DonationRowRecord {
  return {
    transactionId: record.transaction_id,
    disbursementId: record.disbursement_id,
    status: record.status,
    mondayEmployeeItemId: record.monday_employee_item_id,
    mondayMatchItemId: record.monday_match_item_id,
    rawRow: record.raw_row,
    error: record.error,
    ingestedAt: record.ingested_at,
    writtenAt: record.written_at,
  };
}

export class D1RowStore implements RowStore {
  constructor(private db: D1Database) {}

  // Transaction ID is globally unique (PRIMARY KEY), so ON CONFLICT DO NOTHING is enough to make
  // a re-upload of an overlapping file a no-op for rows already known — never overwrites an
  // in-flight or completed row's status.
  async upsertRow(row: NewRow): Promise<UpsertRowResult> {
    const result = await this.db
      .prepare(
        `INSERT INTO rows (transaction_id, disbursement_id, status, raw_row, ingested_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (transaction_id) DO NOTHING`
      )
      .bind(row.transactionId, row.disbursementId, row.status, row.rawRow, row.ingestedAt)
      .run();
    return result.meta.changes === 0 ? 'duplicate' : 'inserted';
  }

  async getRow(transactionId: string): Promise<DonationRowRecord | null> {
    const record = await this.db
      .prepare(
        `SELECT transaction_id, disbursement_id, status, monday_employee_item_id, monday_match_item_id,
                raw_row, error, ingested_at, written_at
         FROM rows WHERE transaction_id = ?1`
      )
      .bind(transactionId)
      .first<D1RowRecord>();
    return record === null ? null : toRow(record);
  }

  async updateStatus(transactionId: string, status: RowStatus, patch: RowStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE rows SET
           status = ?2,
           monday_employee_item_id = COALESCE(?3, monday_employee_item_id),
           monday_match_item_id = COALESCE(?4, monday_match_item_id),
           error = ?5,
           written_at = COALESCE(?6, written_at)
         WHERE transaction_id = ?1`
      )
      .bind(
        transactionId,
        status,
        patch.mondayEmployeeItemId ?? null,
        patch.mondayMatchItemId ?? null,
        patch.error ?? null,
        patch.writtenAt ?? null
      )
      .run();
  }

  async purgeWrittenRawRows(writtenBefore: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE rows SET raw_row = '{}'
         WHERE status = 'written' AND written_at < ?1 AND raw_row != '{}'`
      )
      .bind(writtenBefore)
      .run();
    return result.meta.changes;
  }

  async purgeUnresolvedRawRows(ingestedBefore: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE rows SET raw_row = '{}'
         WHERE status != 'written' AND ingested_at < ?1 AND raw_row != '{}'`
      )
      .bind(ingestedBefore)
      .run();
    return result.meta.changes;
  }
}
