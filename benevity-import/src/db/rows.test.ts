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
    const result = await store.upsertRows([{
      transactionId: 'TXN001',
      disbursementId,
      rawRow: '{"company":"Acme"}',
      status: 'ingested',
      ingestedAt: '2026-09-15T00:00:00Z',
    }]);
    expect(result).toEqual(new Map([['TXN001', 'ingested']]));

    const found = await store.getRow('TXN001');
    expect(found).toMatchObject({ transactionId: 'TXN001', status: 'ingested', disbursementId });
  });

  it('leaves a re-upserted Transaction ID untouched and reports the status it already had', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRows([{
      transactionId: 'TXN001',
      disbursementId,
      rawRow: '{"company":"Acme"}',
      status: 'ingested',
      ingestedAt: '2026-09-15T00:00:00Z',
    }]);
    await store.updateStatus('TXN001', 'written', { writtenAt: '2026-09-15T01:00:00Z' });

    const result = await store.upsertRows([{
      transactionId: 'TXN001',
      disbursementId,
      rawRow: '{"company":"Acme"}',
      status: 'ingested',
      ingestedAt: '2026-09-15T02:00:00Z',
    }]);
    expect(result).toEqual(new Map([['TXN001', 'written']]));

    const found = await store.getRow('TXN001');
    expect(found?.status).toBe('written'); // untouched by the duplicate upsert
  });

  it('upserts a block larger than one statement and one IN list in a single call, keeping known rows as they were', async () => {
    const store = new D1RowStore(env.DB);
    const row = (n: number) => ({
      transactionId: `BIG${String(n).padStart(3, '0')}`, disbursementId, rawRow: `{"n":${n}}`, status: 'ingested' as const, ingestedAt: 't',
    });
    await store.upsertRows([row(7)]);
    await store.updateStatus('BIG007', 'written', { writtenAt: 't2' });

    const rows = Array.from({ length: 250 }, (_, n) => row(n)); // 13 INSERTs (20 rows each), 3 SELECTs (100 ids each)
    const result = await store.upsertRows(rows);

    expect(result.size).toBe(250);
    expect(result.get('BIG007')).toBe('written');
    expect([...result.values()].filter((status) => status === 'ingested')).toHaveLength(249);
    expect(await store.getRow('BIG249')).toMatchObject({ rawRow: '{"n":249}', status: 'ingested', disbursementId });
  });

  it('upserts nothing for an empty block', async () => {
    expect(await new D1RowStore(env.DB).upsertRows([])).toEqual(new Map());
  });

  it('updates status and patch fields', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRows([{
      transactionId: 'TXN002',
      disbursementId,
      rawRow: '{}',
      status: 'ingested',
      ingestedAt: '2026-09-15T00:00:00Z',
    }]);
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

  it('records the worklist item id with a needs-review status, and keeps it through later updates', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRows([{ transactionId: 'TXN003', disbursementId, rawRow: '{}', status: 'ingested', ingestedAt: 't' }]);
    expect((await store.getRow('TXN003'))?.worklistItemId).toBeNull();

    await store.updateStatus('TXN003', 'needs-review', { error: 'no match', worklistItemId: '900' });
    expect(await store.getRow('TXN003')).toMatchObject({ status: 'needs-review', error: 'no match', worklistItemId: '900' });

    await store.updateStatus('TXN003', 'ingested', { error: 'HTTP 500' });
    expect((await store.getRow('TXN003'))?.worklistItemId).toBe('900');
  });

  it('finds a row by its worklist item id', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRows([{ transactionId: 'WL1', disbursementId, rawRow: '{}', status: 'ingested', ingestedAt: 't' }]);
    await store.updateStatus('WL1', 'needs-review', { error: 'x', worklistItemId: '8001' });
    expect((await store.getRowByWorklistItemId('8001'))?.transactionId).toBe('WL1');
    expect(await store.getRowByWorklistItemId('nope')).toBeNull();
  });

  it('requeues a needs-review row once, returns it again while still ingested, never touches written rows, and releases skipped rows only for a whole disbursement (#40)', async () => {
    const store = new D1RowStore(env.DB);
    const add = (transactionId: string, status: 'needs-review' | 'written' | 'skipped' | 'ingested') =>
      store.upsertRows([{ transactionId, disbursementId, rawRow: '{"x":1}', status, ingestedAt: 't' }]);
    await add('RQ-REVIEW', 'needs-review');
    await store.updateStatus('RQ-REVIEW', 'needs-review', { error: 'no match' });
    await add('RQ-WRITTEN', 'written');
    await add('RQ-SKIPPED', 'skipped');

    const none = { requeued: [], purged: 0 };
    expect(await store.requeueRow('RQ-REVIEW')).toEqual({ requeued: ['RQ-REVIEW'], purged: 0 });
    expect(await store.getRow('RQ-REVIEW')).toMatchObject({ status: 'ingested', error: null });
    // Repeating it is safe: the row is still pending, so it is handed back for re-sending.
    expect(await store.requeueRow('RQ-REVIEW')).toEqual({ requeued: ['RQ-REVIEW'], purged: 0 });
    expect(await store.requeueRow('RQ-WRITTEN')).toEqual(none);
    expect(await store.requeueRow('RQ-SKIPPED')).toEqual(none);
    expect((await store.getRow('RQ-WRITTEN'))?.status).toBe('written');

    await add('RQ-REVIEW-2', 'needs-review');
    // A row-level requeue left the skipped row alone (above). A block-level one is the staff
    // override of the disbursement cutoff (#40), so it releases skipped rows too.
    expect((await store.getRow('RQ-SKIPPED'))?.status).toBe('skipped');
    expect(await store.requeueDisbursementRows(disbursementId)).toEqual({ requeued: ['RQ-REVIEW', 'RQ-REVIEW-2', 'RQ-SKIPPED'], purged: 0 });
    expect((await store.getRow('RQ-SKIPPED'))?.status).toBe('ingested');
    expect((await store.getRow('RQ-WRITTEN'))?.status).toBe('written');
    expect(await store.requeueDisbursementRows(disbursementId + 1000)).toEqual(none);
  });

  it('does not requeue a pending row whose raw data the retention purge emptied, and counts it', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRows([{ transactionId: 'PURGED', disbursementId, rawRow: '{"x":1}', status: 'needs-review', ingestedAt: '2020-01-01T00:00:00Z' }]);
    await store.upsertRows([{ transactionId: 'FRESH', disbursementId, rawRow: '{"x":1}', status: 'needs-review', ingestedAt: '2026-09-01T00:00:00Z' }]);
    await store.purgeUnresolvedRawRows('2021-01-01T00:00:00Z');

    expect(await store.requeueRow('PURGED')).toEqual({ requeued: [], purged: 1 });
    expect((await store.getRow('PURGED'))?.status).toBe('needs-review');
    expect(await store.requeueDisbursementRows(disbursementId)).toEqual({ requeued: ['FRESH'], purged: 1 });
  });

  it('purges raw_row for written rows older than the cutoff, and leaves newer ones alone', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRows([{
      transactionId: 'OLD',
      disbursementId,
      rawRow: '{"x":1}',
      status: 'ingested',
      ingestedAt: '2026-01-01T00:00:00Z',
    }]);
    await store.updateStatus('OLD', 'written', { writtenAt: '2026-01-01T00:00:00Z' });
    await store.upsertRows([{
      transactionId: 'NEW',
      disbursementId,
      rawRow: '{"x":2}',
      status: 'ingested',
      ingestedAt: '2026-09-01T00:00:00Z',
    }]);
    await store.updateStatus('NEW', 'written', { writtenAt: '2026-09-01T00:00:00Z' });

    const purged = await store.purgeWrittenRawRows('2026-06-01T00:00:00Z');
    expect(purged).toBe(1);
    expect((await store.getRow('OLD'))?.rawRow).toBe('{}');
    expect((await store.getRow('NEW'))?.rawRow).toBe('{"x":2}');
  });

  it('purges raw_row for unresolved rows older than the cutoff', async () => {
    const store = new D1RowStore(env.DB);
    await store.upsertRows([{
      transactionId: 'STALE',
      disbursementId,
      rawRow: '{"x":1}',
      status: 'needs-review',
      ingestedAt: '2025-01-01T00:00:00Z',
    }]);
    const purged = await store.purgeUnresolvedRawRows('2026-01-01T00:00:00Z');
    expect(purged).toBe(1);
    expect((await store.getRow('STALE'))?.rawRow).toBe('{}');
  });
});
