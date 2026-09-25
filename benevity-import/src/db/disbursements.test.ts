import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1UploadStore } from './uploads';
import { D1DisbursementStore, type NewDisbursement } from './disbursements';
import { applyMigrations } from '../../test/apply-migrations';

function block(uploadId: number, overrides: Partial<NewDisbursement> = {}): NewDisbursement {
  return {
    uploadId,
    blockIndex: 0,
    disbursementId: 'ABC123',
    periodEnding: '2025-12-16',
    currency: 'USD',
    rowCount: 1,
    reportedGrossTotal: 150,
    reportedNetTotal: 150,
    needsReview: false,
    reviewReason: null,
    ...overrides,
  };
}

describe('D1DisbursementStore', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('creates a disbursement and reads it back', async () => {
    const uploadId = (await new D1UploadStore(env.DB).createUpload('asset-1', '2026-09-15T00:00:00Z')).id;
    const store = new D1DisbursementStore(env.DB);

    const { disbursement, created } = await store.findOrCreate(block(uploadId));
    expect(created).toBe(true);
    expect(disbursement.id).toBeGreaterThan(0);

    expect(await store.getDisbursement(disbursement.id)).toMatchObject({
      uploadId,
      blockIndex: 0,
      disbursementId: 'ABC123',
      periodEnding: '2025-12-16',
      needsReview: false,
    });
  });

  it('persists a needs-review disbursement with its reason', async () => {
    const uploadId = (await new D1UploadStore(env.DB).createUpload('asset-2', '2026-09-15T00:00:00Z')).id;
    const store = new D1DisbursementStore(env.DB);
    const { disbursement } = await store.findOrCreate(
      block(uploadId, { disbursementId: 'BAD01', needsReview: true, reviewReason: 'row totals do not match the reported gross total' })
    );
    const found = await store.getDisbursement(disbursement.id);
    expect(found?.needsReview).toBe(true);
    expect(found?.reviewReason).toBe('row totals do not match the reported gross total');
  });

  it('returns null for an id with no disbursement', async () => {
    const store = new D1DisbursementStore(env.DB);
    expect(await store.getDisbursement(999999)).toBeNull();
  });

  it('finds the same block again on a resumed attempt of the same upload', async () => {
    const uploadId = (await new D1UploadStore(env.DB).createUpload('asset-3', '2026-09-15T00:00:00Z')).id;
    const store = new D1DisbursementStore(env.DB);
    const first = await store.findOrCreate(block(uploadId, { disbursementId: '', blockIndex: 1 }));
    const again = await store.findOrCreate(block(uploadId, { disbursementId: '', blockIndex: 1 }));
    expect(again).toEqual({ disbursement: first.disbursement, created: false });
    // A different position in the same upload with no Benevity id is a different block.
    const other = await store.findOrCreate(block(uploadId, { disbursementId: '', blockIndex: 2 }));
    expect(other.created).toBe(true);
  });

  it('reuses the existing row when the same Benevity disbursement arrives in a new upload', async () => {
    const uploads = new D1UploadStore(env.DB);
    const firstUpload = (await uploads.createUpload('asset-4', '2026-09-15T00:00:00Z')).id;
    const reUpload = (await uploads.createUpload('asset-5', '2026-09-16T00:00:00Z')).id;
    const store = new D1DisbursementStore(env.DB);

    const first = await store.findOrCreate(block(firstUpload, { disbursementId: 'REUP01' }));
    const second = await store.findOrCreate(block(reUpload, { disbursementId: 'REUP01', blockIndex: 3 }));
    expect(second).toEqual({ disbursement: first.disbursement, created: false });
  });
});
