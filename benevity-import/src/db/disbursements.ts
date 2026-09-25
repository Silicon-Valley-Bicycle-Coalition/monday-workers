export interface DisbursementRow {
  id: number;
  uploadId: number;
  // Position of this block within the upload that first produced it (0-based).
  blockIndex: number | null;
  disbursementId: string;
  periodEnding: string;
  currency: string;
  rowCount: number;
  reportedGrossTotal: number;
  reportedNetTotal: number;
  needsReview: boolean;
  reviewReason: string | null;
  // The block-level Benevity Uploads worklist item, once one was posted for it (#34).
  worklistItemId: string | null;
}

export interface NewDisbursement extends Omit<DisbursementRow, 'id' | 'blockIndex' | 'worklistItemId'> {
  blockIndex: number;
}

export interface FindOrCreateResult {
  disbursement: DisbursementRow;
  // True only when this call inserted the row. False for a resumed attempt of the same upload
  // or a re-upload of a disbursement already known.
  created: boolean;
}

export interface DisbursementStore {
  // One row per Benevity Disbursement ID (#34), plus one per block with no id (a header that
  // didn't parse). Looks up, in order: this upload's block at the same position (a resumed
  // attempt of the same asset), then the Benevity id (the same report re-uploaded as a new
  // asset); inserts only when neither exists. Migration 0002's unique indexes turn a lost
  // race into a re-read, never a duplicate.
  findOrCreate(input: NewDisbursement): Promise<FindOrCreateResult>;
  getDisbursement(id: number): Promise<DisbursementRow | null>;
  setWorklistItemId(id: number, worklistItemId: string): Promise<void>;
}

interface D1DisbursementRecord {
  id: number;
  upload_id: number;
  block_index: number | null;
  disbursement_id: string;
  period_ending: string;
  currency: string;
  row_count: number;
  reported_gross_total: number;
  reported_net_total: number;
  needs_review: number;
  review_reason: string | null;
  worklist_item_id: string | null;
}

const COLUMNS = `id, upload_id, block_index, disbursement_id, period_ending, currency, row_count,
                 reported_gross_total, reported_net_total, needs_review, review_reason, worklist_item_id`;

function toDisbursementRow(record: D1DisbursementRecord): DisbursementRow {
  return {
    id: record.id,
    uploadId: record.upload_id,
    blockIndex: record.block_index,
    disbursementId: record.disbursement_id,
    periodEnding: record.period_ending,
    currency: record.currency,
    rowCount: record.row_count,
    reportedGrossTotal: record.reported_gross_total,
    reportedNetTotal: record.reported_net_total,
    needsReview: record.needs_review === 1,
    reviewReason: record.review_reason,
    worklistItemId: record.worklist_item_id,
  };
}

export class D1DisbursementStore implements DisbursementStore {
  constructor(private db: D1Database) {}

  async findOrCreate(input: NewDisbursement): Promise<FindOrCreateResult> {
    const existing = await this.find(input);
    if (existing !== null) return { disbursement: existing, created: false };

    const inserted = await this.db
      .prepare(
        `INSERT INTO disbursements
           (upload_id, block_index, disbursement_id, period_ending, currency, row_count,
            reported_gross_total, reported_net_total, needs_review, review_reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT DO NOTHING
         RETURNING ${COLUMNS}`
      )
      .bind(
        input.uploadId,
        input.blockIndex,
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
    if (inserted !== null) return { disbursement: toDisbursementRow(inserted), created: true };

    // Another writer inserted the same block between the lookup and the insert.
    const raced = await this.find(input);
    if (raced === null) {
      throw new Error(`db: failed to create disbursement "${input.disbursementId}"`);
    }
    return { disbursement: raced, created: false };
  }

  private async find(input: NewDisbursement): Promise<DisbursementRow | null> {
    const sameBlock = await this.db
      .prepare(`SELECT ${COLUMNS} FROM disbursements WHERE upload_id = ?1 AND block_index = ?2`)
      .bind(input.uploadId, input.blockIndex)
      .first<D1DisbursementRecord>();
    if (sameBlock !== null) return toDisbursementRow(sameBlock);
    if (input.disbursementId === '') return null;
    const sameId = await this.db
      .prepare(`SELECT ${COLUMNS} FROM disbursements WHERE disbursement_id = ?1`)
      .bind(input.disbursementId)
      .first<D1DisbursementRecord>();
    return sameId === null ? null : toDisbursementRow(sameId);
  }

  async getDisbursement(id: number): Promise<DisbursementRow | null> {
    const record = await this.db
      .prepare(`SELECT ${COLUMNS} FROM disbursements WHERE id = ?1`)
      .bind(id)
      .first<D1DisbursementRecord>();
    return record === null ? null : toDisbursementRow(record);
  }

  async setWorklistItemId(id: number, worklistItemId: string): Promise<void> {
    await this.db.prepare(`UPDATE disbursements SET worklist_item_id = ?2 WHERE id = ?1`).bind(id, worklistItemId).run();
  }
}
