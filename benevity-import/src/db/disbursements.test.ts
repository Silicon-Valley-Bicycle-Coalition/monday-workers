import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1UploadStore } from './uploads';
import { D1DisbursementStore } from './disbursements';
import { applyMigrations } from '../../test/apply-migrations';

describe('D1DisbursementStore', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('creates a disbursement and reads it back', async () => {
    const uploads = new D1UploadStore(env.DB);
    const uploadId = (await uploads.createUpload('asset-1', '2026-09-15T00:00:00Z')).id;

    const store = new D1DisbursementStore(env.DB);
    const created = await store.createDisbursement({
      uploadId,
      disbursementId: 'ABC123',
      periodEnding: '2025-12-16',
      currency: 'USD',
      rowCount: 1,
      reportedGrossTotal: 150,
      reportedNetTotal: 150,
      needsReview: false,
      reviewReason: null,
    });
    expect(created.id).toBeGreaterThan(0);

    const found = await store.getDisbursement(created.id);
    expect(found).toMatchObject({
      uploadId,
      disbursementId: 'ABC123',
      periodEnding: '2025-12-16',
      needsReview: false,
    });
  });

  it('persists a needs-review disbursement with its reason', async () => {
    const uploads = new D1UploadStore(env.DB);
    const uploadId = (await uploads.createUpload('asset-2', '2026-09-15T00:00:00Z')).id;

    const store = new D1DisbursementStore(env.DB);
    const created = await store.createDisbursement({
      uploadId,
      disbursementId: 'BAD01',
      periodEnding: '2025-12-16',
      currency: 'USD',
      rowCount: 0,
      reportedGrossTotal: 0,
      reportedNetTotal: 0,
      needsReview: true,
      reviewReason: 'row totals do not match the reported gross total',
    });
    const found = await store.getDisbursement(created.id);
    expect(found?.needsReview).toBe(true);
    expect(found?.reviewReason).toBe('row totals do not match the reported gross total');
  });

  it('returns null for an id with no disbursement', async () => {
    const store = new D1DisbursementStore(env.DB);
    expect(await store.getDisbursement(999999)).toBeNull();
  });

  it('lists disbursements for an upload in creation order, empty for an upload with none', async () => {
    const uploads = new D1UploadStore(env.DB);
    const uploadId = (await uploads.createUpload('asset-3', '2026-09-15T00:00:00Z')).id;

    const store = new D1DisbursementStore(env.DB);
    const first = await store.createDisbursement({
      uploadId, disbursementId: 'FIRST', periodEnding: '2025-12-16', currency: 'USD',
      rowCount: 1, reportedGrossTotal: 50, reportedNetTotal: 50, needsReview: false, reviewReason: null,
    });
    const second = await store.createDisbursement({
      uploadId, disbursementId: 'SECOND', periodEnding: '2025-12-16', currency: 'USD',
      rowCount: 1, reportedGrossTotal: 60, reportedNetTotal: 60, needsReview: false, reviewReason: null,
    });
    expect((await store.listByUpload(uploadId)).map((d) => d.id)).toEqual([first.id, second.id]);
    expect(await store.listByUpload(999999)).toEqual([]);
  });
});
