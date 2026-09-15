export type UploadStatus = 'parsing' | 'parsed' | 'error';

export interface UploadRow {
  id: number;
  mondayAssetId: string;
  uploadedAt: string;
  status: UploadStatus;
  blockCount: number;
}

export interface UploadStore {
  createUpload(mondayAssetId: string, uploadedAt: string): Promise<UploadRow>;
  getUploadByAssetId(mondayAssetId: string): Promise<UploadRow | null>;
  markParsed(id: number, blockCount: number): Promise<void>;
  markError(id: number): Promise<void>;
}

interface D1UploadRecord {
  id: number;
  monday_asset_id: string;
  uploaded_at: string;
  status: UploadStatus;
  block_count: number;
}

function toUploadRow(record: D1UploadRecord): UploadRow {
  return {
    id: record.id,
    mondayAssetId: record.monday_asset_id,
    uploadedAt: record.uploaded_at,
    status: record.status,
    blockCount: record.block_count,
  };
}

export class D1UploadStore implements UploadStore {
  constructor(private db: D1Database) {}

  async createUpload(mondayAssetId: string, uploadedAt: string): Promise<UploadRow> {
    const result = await this.db
      .prepare(
        `INSERT INTO uploads (monday_asset_id, uploaded_at, status, block_count)
         VALUES (?1, ?2, 'parsing', 0)
         RETURNING id, monday_asset_id, uploaded_at, status, block_count`
      )
      .bind(mondayAssetId, uploadedAt)
      .first<D1UploadRecord>();
    if (result === null) {
      throw new Error(`db: failed to create upload for asset "${mondayAssetId}"`);
    }
    return toUploadRow(result);
  }

  async getUploadByAssetId(mondayAssetId: string): Promise<UploadRow | null> {
    const record = await this.db
      .prepare(`SELECT id, monday_asset_id, uploaded_at, status, block_count FROM uploads WHERE monday_asset_id = ?1`)
      .bind(mondayAssetId)
      .first<D1UploadRecord>();
    return record === null ? null : toUploadRow(record);
  }

  async markParsed(id: number, blockCount: number): Promise<void> {
    await this.db
      .prepare(`UPDATE uploads SET status = 'parsed', block_count = ?2 WHERE id = ?1`)
      .bind(id, blockCount)
      .run();
  }

  async markError(id: number): Promise<void> {
    await this.db.prepare(`UPDATE uploads SET status = 'error' WHERE id = ?1`).bind(id).run();
  }
}
