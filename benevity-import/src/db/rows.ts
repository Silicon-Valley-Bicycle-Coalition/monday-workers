export type RowStatus = 'ingested' | 'written' | 'needs-review' | 'skipped';

export interface DonationRowRecord {
  transactionId: string;
  disbursementId: number;
  status: RowStatus;
  mondayEmployeeItemId: string | null;
  mondayMatchItemId: string | null;
  // The Benevity Uploads worklist item this row was put on, once it needed review (#34).
  worklistItemId: string | null;
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
  worklistItemId?: string;
  error?: string;
  writtenAt?: string;
}

export type UpsertRowResult = 'inserted' | 'duplicate';

export interface RequeueResult {
  requeued: string[];
  purged: number;
}

// SQL status lists for requeueWhere (constants, never user input).
const PENDING_STATUSES = `'needs-review', 'ingested'`;
const PENDING_OR_SKIPPED_STATUSES = `'needs-review', 'ingested', 'skipped'`;

// What purgeWrittenRawRows/purgeUnresolvedRawRows leave in raw_row.
export const PURGED_RAW_ROW = '{}';

export interface RowStore {
  upsertRow(row: NewRow): Promise<UpsertRowResult>;
  getRow(transactionId: string): Promise<DonationRowRecord | null>;
  getRowByWorklistItemId(worklistItemId: string): Promise<DonationRowRecord | null>;
  // Replay (#34): moves the given rows from 'needs-review' back to 'ingested' (clearing the
  // error) and returns every one of them that is now 'ingested' — including rows a previous
  // replay already moved whose enqueue never went through — for the caller to (re-)enqueue.
  // 'written' rows are left alone and not returned. A pending row whose raw_row the retention
  // purge already emptied can't be re-run (the consumer would parse `{}`), so it is left as-is
  // and only counted in `purged`. Idempotent.
  // The two differ on 'skipped' rows. A row is only ever skipped as part of a whole disbursement
  // the cutoff excluded, so the block-level requeue releases them too — that is the staff
  // override of the cutoff (#40) — while the row-level one leaves them alone.
  requeueRow(transactionId: string): Promise<RequeueResult>;
  requeueDisbursementRows(disbursementId: number): Promise<RequeueResult>;
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
  worklist_item_id: string | null;
  raw_row: string;
  error: string | null;
  ingested_at: string;
  written_at: string | null;
}

const ROW_COLUMNS = `transaction_id, disbursement_id, status, monday_employee_item_id, monday_match_item_id,
                     worklist_item_id, raw_row, error, ingested_at, written_at`;

function toRow(record: D1RowRecord): DonationRowRecord {
  return {
    transactionId: record.transaction_id,
    disbursementId: record.disbursement_id,
    status: record.status,
    mondayEmployeeItemId: record.monday_employee_item_id,
    mondayMatchItemId: record.monday_match_item_id,
    worklistItemId: record.worklist_item_id,
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
      .prepare(`SELECT ${ROW_COLUMNS} FROM rows WHERE transaction_id = ?1`)
      .bind(transactionId)
      .first<D1RowRecord>();
    return record === null ? null : toRow(record);
  }

  async getRowByWorklistItemId(worklistItemId: string): Promise<DonationRowRecord | null> {
    const record = await this.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM rows WHERE worklist_item_id = ?1`)
      .bind(worklistItemId)
      .first<D1RowRecord>();
    return record === null ? null : toRow(record);
  }

  requeueRow(transactionId: string): Promise<RequeueResult> {
    return this.requeueWhere('transaction_id = ?1', transactionId, PENDING_STATUSES);
  }

  requeueDisbursementRows(disbursementId: number): Promise<RequeueResult> {
    return this.requeueWhere('disbursement_id = ?1', disbursementId, PENDING_OR_SKIPPED_STATUSES);
  }

  // One UPDATE … RETURNING, so D1 applies it atomically. Rows already 'ingested' match too (a
  // no-op set) so they're returned for re-sending.
  private async requeueWhere(predicate: string, value: string | number, statuses: string): Promise<RequeueResult> {
    const [updated, purged] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE rows SET status = 'ingested', error = NULL
           WHERE ${predicate} AND status IN (${statuses}) AND raw_row != ?2
           RETURNING transaction_id`
        )
        .bind(value, PURGED_RAW_ROW),
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM rows
           WHERE ${predicate} AND status IN (${statuses}) AND raw_row = ?2`
        )
        .bind(value, PURGED_RAW_ROW),
    ]);
    return {
      requeued: (updated!.results as { transaction_id: string }[]).map((r) => r.transaction_id).sort(),
      purged: (purged!.results as { n: number }[])[0]?.n ?? 0,
    };
  }

  async updateStatus(transactionId: string, status: RowStatus, patch: RowStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE rows SET
           status = ?2,
           monday_employee_item_id = COALESCE(?3, monday_employee_item_id),
           monday_match_item_id = COALESCE(?4, monday_match_item_id),
           error = ?5,
           written_at = COALESCE(?6, written_at),
           worklist_item_id = COALESCE(?7, worklist_item_id)
         WHERE transaction_id = ?1`
      )
      .bind(
        transactionId,
        status,
        patch.mondayEmployeeItemId ?? null,
        patch.mondayMatchItemId ?? null,
        patch.error ?? null,
        patch.writtenAt ?? null,
        patch.worklistItemId ?? null
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
