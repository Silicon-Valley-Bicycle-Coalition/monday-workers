export interface DisbursementRow {
  id: number;
  uploadId: number;
  disbursementId: string;
  periodEnding: string;
  currency: string;
  rowCount: number;
  reportedGrossTotal: number;
  reportedNetTotal: number;
  needsReview: boolean;
  reviewReason: string | null;
}

export type NewDisbursement = Omit<DisbursementRow, 'id'>;

export interface DisbursementStore {
  createDisbursement(input: NewDisbursement): Promise<DisbursementRow>;
  getDisbursement(id: number): Promise<DisbursementRow | null>;
  // Added during Task 16's fix round 1: lets a webhook redelivery resume a stuck upload from
  // the first block that was never fully processed, instead of reprocessing blocks that
  // already ran to completion (which would otherwise insert a duplicate disbursement row, and
  // for a needs-review block, a duplicate worklist item).
  listByUpload(uploadId: number): Promise<DisbursementRow[]>;
}

interface D1DisbursementRecord {
  id: number;
  upload_id: number;
  disbursement_id: string;
  period_ending: string;
  currency: string;
  row_count: number;
  reported_gross_total: number;
  reported_net_total: number;
  needs_review: number;
  review_reason: string | null;
}

function toDisbursementRow(record: D1DisbursementRecord): DisbursementRow {
  return {
    id: record.id,
    uploadId: record.upload_id,
    disbursementId: record.disbursement_id,
    periodEnding: record.period_ending,
    currency: record.currency,
    rowCount: record.row_count,
    reportedGrossTotal: record.reported_gross_total,
    reportedNetTotal: record.reported_net_total,
    needsReview: record.needs_review === 1,
    reviewReason: record.review_reason,
  };
}

export class D1DisbursementStore implements DisbursementStore {
  constructor(private db: D1Database) {}

  async createDisbursement(input: NewDisbursement): Promise<DisbursementRow> {
    const result = await this.db
      .prepare(
        `INSERT INTO disbursements
           (upload_id, disbursement_id, period_ending, currency, row_count,
            reported_gross_total, reported_net_total, needs_review, review_reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         RETURNING id, upload_id, disbursement_id, period_ending, currency, row_count,
                   reported_gross_total, reported_net_total, needs_review, review_reason`
      )
      .bind(
        input.uploadId,
        input.disbursementId,
        input.periodEnding,
        input.currency,
        input.rowCount,
        input.reportedGrossTotal,
        input.reportedNetTotal,
        input.needsReview ? 1 : 0,
        input.reviewReason
      )
      .first<D1DisbursementRecord>();
    if (result === null) {
      throw new Error(`db: failed to create disbursement "${input.disbursementId}"`);
    }
    return toDisbursementRow(result);
  }

  async getDisbursement(id: number): Promise<DisbursementRow | null> {
    const record = await this.db
      .prepare(
        `SELECT id, upload_id, disbursement_id, period_ending, currency, row_count,
                reported_gross_total, reported_net_total, needs_review, review_reason
         FROM disbursements WHERE id = ?1`
      )
      .bind(id)
      .first<D1DisbursementRecord>();
    return record === null ? null : toDisbursementRow(record);
  }

  async listByUpload(uploadId: number): Promise<DisbursementRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, upload_id, disbursement_id, period_ending, currency, row_count,
                reported_gross_total, reported_net_total, needs_review, review_reason
         FROM disbursements WHERE upload_id = ?1 ORDER BY id ASC`
      )
      .bind(uploadId)
      .all<D1DisbursementRecord>();
    return results.map(toDisbursementRow);
  }
}
