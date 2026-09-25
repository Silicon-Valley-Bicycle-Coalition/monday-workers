import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1UploadStore } from './uploads';
import { D1DisbursementStore } from './disbursements';
import { D1RowStore } from './rows';
import { applyMigrations } from '../../test/apply-migrations';

describe('D1RowStore', () => {
  let disbursementId: number;
  let testIndex = 0;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    const uploads = new D1UploadStore(env.DB);
    const uploadId = (await uploads.createUpload(`asset-${testIndex}`, '2026-09-15T00:00:00Z')).id;
    const disbursements = new D1DisbursementStore(env.DB);
    disbursementId = (
      await disbursements.findOrCreate({
        uploadId,
        blockIndex: 0,
        disbursementId: `ABC${testIndex++}`,
        periodEnding: '2025-12-16',
        currency: 'USD',
        rowCount: 1,
        reportedGrossTotal: 150,
        reportedNetTotal: 150,
        needsReview: false,
        reviewReason: null,
      })
    ).disbursement.id;
  });

  it('inserts a new row as ingested', async () => {
    const store = new D1RowStore(env.DB);
    const result = await store.upsertRow({
      transactionId: 'TXN001',
      disbursementId,
      rawRow: '{"company":"Acme"}',
      status: 'ingested',
      ingestedAt: '2026-09-15T00:00:00Z',
    });
    expect(result).toBe('inserted');

    const found = await store.getRow('TXN001');
    expect(found).toMatchObject({ transactionId: 'TXN001', status: 'ingested', disbursementId });
  });

  it('reports a re-upsert of the same Transaction ID as a duplicate and leaves the row untouched', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRow({
      transactionId: 'TXN001',
      disbursementId,
      rawRow: '{"company":"Acme"}',
      status: 'ingested',
      ingestedAt: '2026-09-15T00:00:00Z',
    });
    await store.updateStatus('TXN001', 'written', { writtenAt: '2026-09-15T01:00:00Z' });

    const result = await store.upsertRow({
      transactionId: 'TXN001',
      disbursementId,
      rawRow: '{"company":"Acme"}',
      status: 'ingested',
      ingestedAt: '2026-09-15T02:00:00Z',
    });
    expect(result).toBe('duplicate');

    const found = await store.getRow('TXN001');
    expect(found?.status).toBe('written'); // untouched by the duplicate upsert
  });

  it('updates status and patch fields', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRow({
      transactionId: 'TXN002',
      disbursementId,
      rawRow: '{}',
      status: 'ingested',
      ingestedAt: '2026-09-15T00:00:00Z',
    });
    await store.updateStatus('TXN002', 'written', {
      mondayEmployeeItemId: '111',
      mondayMatchItemId: '222',
      writtenAt: '2026-09-15T03:00:00Z',
    });
    const found = await store.getRow('TXN002');
    expect(found).toMatchObject({
      status: 'written',
      mondayEmployeeItemId: '111',
      mondayMatchItemId: '222',
      writtenAt: '2026-09-15T03:00:00Z',
    });
  });

  it('purges raw_row for written rows older than the cutoff, and leaves newer ones alone', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRow({
      transactionId: 'OLD',
      disbursementId,
      rawRow: '{"x":1}',
      status: 'ingested',
      ingestedAt: '2026-01-01T00:00:00Z',
    });
    await store.updateStatus('OLD', 'written', { writtenAt: '2026-01-01T00:00:00Z' });
    await store.upsertRow({
      transactionId: 'NEW',
      disbursementId,
      rawRow: '{"x":2}',
      status: 'ingested',
      ingestedAt: '2026-09-01T00:00:00Z',
    });
    await store.updateStatus('NEW', 'written', { writtenAt: '2026-09-01T00:00:00Z' });

    const purged = await store.purgeWrittenRawRows('2026-06-01T00:00:00Z');
    expect(purged).toBe(1);
    expect((await store.getRow('OLD'))?.rawRow).toBe('{}');
    expect((await store.getRow('NEW'))?.rawRow).toBe('{"x":2}');
  });

  it('purges raw_row for unresolved rows older than the cutoff', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRow({
      transactionId: 'STALE',
      disbursementId,
      rawRow: '{"x":1}',
      status: 'needs-review',
      ingestedAt: '2025-01-01T00:00:00Z',
    });
    const purged = await store.purgeUnresolvedRawRows('2026-01-01T00:00:00Z');
    expect(purged).toBe(1);
    expect((await store.getRow('STALE'))?.rawRow).toBe('{}');
  });
});
