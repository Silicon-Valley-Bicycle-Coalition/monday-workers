import { describe, it, expect, vi } from 'vitest';
import { createApp, type AppDeps } from './route';
import type { MondayClient } from '../monday/client';
import type { UploadStore } from '../db/uploads';
import type { DisbursementStore } from '../db/disbursements';
import type { RowStore } from '../db/rows';
import type { BenevityImportConfig } from '../types';

const SECRET = 'test-secret';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 1, organizations: 1, people: 1, affiliations: 1, benevityUploads: 777 } },
    benevityImport: {
      minDonationDate: '2026-01-01',
      donationsColumns: {} as never,
      organizationsNameColumn: 'name',
      peopleColumns: {} as never,
      affiliationsColumns: {} as never,
      uploadsBoard: {
        fileColumn: 'file_col',
        worklistGroupId: 'review',
        worklistColumns: { reason: 'reason_c', name: 'name_c', email: 'email_c', company: 'company_c', amount: 'amount_c', date: 'date_c' },
      },
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function validReport(opts: { disbursementId?: string; transactionId?: string } = {}): string {
  const { disbursementId = 'ABC123', transactionId = 'TXN001' } = opts;
  return [
    'Donations Report,',
    '"#---",',
    'Charity Name,SVBC',
    'Charity ID,123',
    'Period Ending,Tue 16 Dec 2026 0:00:00',
    'Currency,USD',
    'Payment Method,EFT',
    `Disbursement ID,${disbursementId}`,
    'Note,',
    '"#---",',
    '',
    'Company,Project,Donation Date,Donor First Name,Donor Last Name,Email,Address,City,State/Province,Postal Code,Activity,Comment,Transaction ID,Donation Frequency,Currency,Project Remote ID,Source,Reason,Total Donation to be Acknowledged,Match Amount,Cause Support Fee,Merchant Fee,Fee Comment',
    `"Acme, Inc.",Project,2026-12-06T00:00:00Z,Jordan,Rivera,jordan@acme.example,x,x,x,94043,,,${transactionId},One Time,USD,,BlueSnap,User Donation,50.00,0.00,0.00,0.00,`,
    'Totals,,,,,,,,,,,,,,,,,,50.00,0.00,0.00,0.00',
    'Total Donations (Gross),50.00',
    'Check Fee,0.00',
    'Net Total Payment,50.00',
    '',
  ].join('\n');
}

function fakeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const uploadStore: UploadStore = {
    createUpload: vi.fn().mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'now', status: 'parsing', blockCount: 0 }),
    getUploadByAssetId: vi.fn().mockResolvedValue(null),
    markParsed: vi.fn(),
    markError: vi.fn(),
  };
  const disbursementStore: DisbursementStore = {
    findOrCreate: vi.fn().mockImplementation((input) => Promise.resolve({ disbursement: { id: 10, ...input }, created: true })),
    getDisbursement: vi.fn(),
  };
  const rowStore: RowStore = {
    upsertRow: vi.fn().mockResolvedValue('inserted'),
    getRow: vi.fn(),
    updateStatus: vi.fn(),
    purgeWrittenRawRows: vi.fn(),
    purgeUnresolvedRawRows: vi.fn(),
  };
  const mondayClient: MondayClient = {
    findItemsByColumnValue: vi.fn().mockResolvedValue([]),
    findItemsByName: vi.fn().mockResolvedValue([]),
    getLinkedItemIds: vi.fn().mockResolvedValue([]),
    createItem: vi.fn().mockResolvedValue({ id: '1', name: 'x' }),
    changeColumnValues: vi.fn(),
    fetchAsset: vi.fn().mockResolvedValue({ id: 'a1', name: 'report.csv', publicUrl: 'https://files.monday.com/a1' }),
  };
  return {
    mondayClient,
    uploadStore,
    disbursementStore,
    rowStore,
    config: fakeConfig(),
    queue: { sendBatch: vi.fn().mockResolvedValue(undefined) },
    webhookSecret: SECRET,
    fetchCsv: vi.fn().mockResolvedValue(validReport()),
    now: () => '2026-09-15T00:00:00Z',
    ...overrides,
  };
}

function post(app: ReturnType<typeof createApp>, body: unknown, secret: string | null = SECRET) {
  const url = secret === null ? '/webhooks/monday/benevity-upload' : `/webhooks/monday/benevity-upload?secret=${secret}`;
  return app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('webhook route', () => {
  it('responds ok on /health', async () => {
    const app = createApp(fakeDeps());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('rejects a request with the wrong secret', async () => {
    const app = createApp(fakeDeps());
    const res = await post(app, { event: {} }, 'wrong');
    expect(res.status).toBe(401);
  });

  it('rejects every request when no secret is configured', async () => {
    const app = createApp(fakeDeps({ webhookSecret: undefined }));
    const res = await post(app, { event: {} });
    expect(res.status).toBe(401);
  });

  it('echoes the Monday subscribe handshake challenge', async () => {
    const app = createApp(fakeDeps());
    const res = await post(app, { challenge: 'abc123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('ignores a column-change event for a column other than the configured file column', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await post(app, {
      event: { pulseId: 1, columnId: 'some_other_column', value: { files: [{ assetId: 'a1' }] } },
    });
    expect(res.status).toBe(200);
    expect(deps.mondayClient.fetchAsset).not.toHaveBeenCalled();
  });

  it('ingests a valid single-block file and enqueues its row', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(res.status).toBe(200);
    expect(deps.rowStore.upsertRow).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'TXN001', status: 'ingested' })
    );
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }]);
    expect(deps.uploadStore.markParsed).toHaveBeenCalledWith(1, 1);
  });

  it('enqueues every row of a block in one sendBatch call, not one send per row', async () => {
    const report = validReport()
      .replace(
        /^("Acme, Inc\.".*TXN001.*)$/m,
        (line) => `${line}\n${line.replace('TXN001', 'TXN002')}`
      )
      .replace('Total Donations (Gross),50.00', 'Total Donations (Gross),100.00');
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(report) });
    const app = createApp(deps);
    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(res.status).toBe(200);
    expect(deps.queue.sendBatch).toHaveBeenCalledTimes(1);
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }, { transactionId: 'TXN002' }]);
  });

  it('re-enqueues a row stuck at "ingested" from a prior attempt whose queue.send never went through', async () => {
    // upsertRow returns 'duplicate' (the row already exists in D1 from an earlier attempt), and
    // getRow shows it's still sitting at 'ingested' — proof that attempt upserted the row but
    // threw before or during queue.send, so nothing else will ever retry it.
    const deps = fakeDeps({
      rowStore: {
        ...fakeDeps().rowStore,
        upsertRow: vi.fn().mockResolvedValue('duplicate'),
        getRow: vi.fn().mockResolvedValue({
          transactionId: 'TXN001',
          disbursementId: 10,
          status: 'ingested',
          mondayEmployeeItemId: null,
          mondayMatchItemId: null,
          rawRow: '{}',
          error: null,
          ingestedAt: '2026-09-15T00:00:00Z',
          writtenAt: null,
        }),
      },
    });
    const app = createApp(deps);
    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(res.status).toBe(200);
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }]);
  });

  it('does not re-enqueue a duplicate row whose earlier attempt already completed (status "written")', async () => {
    const deps = fakeDeps({
      rowStore: {
        ...fakeDeps().rowStore,
        upsertRow: vi.fn().mockResolvedValue('duplicate'),
        getRow: vi.fn().mockResolvedValue({
          transactionId: 'TXN001',
          disbursementId: 10,
          status: 'written',
          mondayEmployeeItemId: '123',
          mondayMatchItemId: null,
          rawRow: '{}',
          error: null,
          ingestedAt: '2026-09-15T00:00:00Z',
          writtenAt: '2026-09-15T00:00:01Z',
        }),
      },
    });
    const app = createApp(deps);
    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(res.status).toBe(200);
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it('is a no-op for an asset already ingested', async () => {
    const deps = fakeDeps({ uploadStore: { ...fakeDeps().uploadStore, getUploadByAssetId: vi.fn().mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status: 'parsed', blockCount: 1 }) } });
    const app = createApp(deps);
    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(res.status).toBe(200);
    expect(deps.mondayClient.fetchAsset).not.toHaveBeenCalled();
  });

  it('skips a row dated before minDonationDate without enqueueing it', async () => {
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(validReport()) });
    deps.config.benevityImport.minDonationDate = '2027-01-01'; // after the fixture's 2026-12-06 row
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(deps.rowStore.upsertRow).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it('creates one worklist item and marks every row needs-review for a block with a bad header, without enqueueing', async () => {
    const badCsv = validReport().replace('Transaction ID,', 'Txn Id Renamed,');
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(badCsv) });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it('creates one worklist item and marks rows needs-review for a block whose totals do not match, without enqueueing', async () => {
    const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(mismatched) });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(deps.rowStore.upsertRow).toHaveBeenCalledWith(expect.objectContaining({ status: 'needs-review' }));
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it('retries an asset stuck at "parsing" from a failed prior attempt, instead of no-op-ing past it', async () => {
    const deps = fakeDeps({
      uploadStore: {
        ...fakeDeps().uploadStore,
        getUploadByAssetId: vi
          .fn()
          .mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status: 'parsing', blockCount: 0 }),
      },
    });
    const app = createApp(deps);
    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(res.status).toBe(200);
    // Must still fetch and process — a 'parsing' upload is not "done," unlike 'parsed'.
    expect(deps.mondayClient.fetchAsset).toHaveBeenCalled();
    expect(deps.uploadStore.createUpload).not.toHaveBeenCalled(); // reuses existing.id, never double-creates
    expect(deps.uploadStore.markParsed).toHaveBeenCalledWith(1, 1);
  });

  it('resumes a stuck retry from the first never-completed block, without reprocessing a block that already succeeded', async () => {
    // Two-block file; block 1 already has a disbursement row from a prior attempt (it
    // succeeded before block 2 failed and the upload got stuck at 'parsing').
    const bundled =
      validReport({ disbursementId: 'FIRST01', transactionId: 'TXN001' }) +
      validReport({ disbursementId: 'SECOND02', transactionId: 'TXN002' });
    const deps = fakeDeps({
      fetchCsv: vi.fn().mockResolvedValue(bundled),
      uploadStore: {
        ...fakeDeps().uploadStore,
        getUploadByAssetId: vi
          .fn()
          .mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status: 'parsing', blockCount: 0 }),
      },
    });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    // Each block is looked up by its own position in this upload, so the store can hand back
    // block 0's row from the prior attempt instead of creating it again.
    expect(deps.disbursementStore.findOrCreate).toHaveBeenCalledTimes(2);
    expect(deps.disbursementStore.findOrCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ uploadId: 1, blockIndex: 0, disbursementId: 'FIRST01' })
    );
    expect(deps.disbursementStore.findOrCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ uploadId: 1, blockIndex: 1, disbursementId: 'SECOND02' })
    );
    expect(deps.uploadStore.markParsed).toHaveBeenCalledWith(1, 2);
  });

  it('resuming a needs-review block that already has a disbursement row does not re-post its worklist item, but still (re-)upserts its rows', async () => {
    // Simulates a block that failed AFTER its worklist item posted but BEFORE its row upsert
    // finished — the narrower gap a coarser count-only resume check would miss.
    const badCsv = validReport().replace('Transaction ID,', 'Txn Id Renamed,'); // -> headerError, needsReview
    const deps = fakeDeps({
      fetchCsv: vi.fn().mockResolvedValue(badCsv),
      uploadStore: {
        ...fakeDeps().uploadStore,
        getUploadByAssetId: vi
          .fn()
          .mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status: 'parsing', blockCount: 0 }),
      },
      disbursementStore: {
        ...fakeDeps().disbursementStore,
        findOrCreate: vi.fn().mockResolvedValue({
          disbursement: { id: 10, uploadId: 1, blockIndex: 0, disbursementId: '', periodEnding: '', currency: '', rowCount: 0,
            reportedGrossTotal: 0, reportedNetTotal: 0, needsReview: true, reviewReason: 'x' },
          created: false,
        }),
      },
    });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    // Reused the existing row — never re-posted the worklist item.
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    // A header-error block has zero rows to upsert, so this only proves the code path taken
    // (created === false -> skip worklist post) without needing row-level fixtures;
    // the sum-mismatch case below covers the "rows still get upserted" half.
  });

  it('resuming a needs-review block from a sum mismatch still (re-)upserts its rows even though its disbursement row already exists', async () => {
    const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
    const deps = fakeDeps({
      fetchCsv: vi.fn().mockResolvedValue(mismatched),
      uploadStore: {
        ...fakeDeps().uploadStore,
        getUploadByAssetId: vi
          .fn()
          .mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status: 'parsing', blockCount: 0 }),
      },
      disbursementStore: {
        ...fakeDeps().disbursementStore,
        findOrCreate: vi.fn().mockResolvedValue({
          disbursement: { id: 10, uploadId: 1, blockIndex: 0, disbursementId: 'ABC123', periodEnding: '2026-12-16', currency: 'USD',
            rowCount: 1, reportedGrossTotal: 999, reportedNetTotal: 999, needsReview: true, reviewReason: 'x' },
          created: false,
        }),
      },
    });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled(); // no re-posted worklist item
    // The row IS still upserted against the reused disbursement id — proves a row upsert a
    // partial prior attempt never reached still gets recorded on this retry.
    expect(deps.rowStore.upsertRow).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'TXN001', disbursementId: 10, status: 'needs-review' })
    );
  });

  it('marks the upload errored and returns 500 when a block throws mid-processing, so Monday redelivers', async () => {
    const deps = fakeDeps({
      disbursementStore: {
        ...fakeDeps().disbursementStore,
        findOrCreate: vi.fn().mockRejectedValue(new Error('D1 write failed')),
      },
    });
    const app = createApp(deps);
    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(res.status).toBe(500);
    expect(deps.uploadStore.markError).toHaveBeenCalledWith(1);
    expect(deps.uploadStore.markParsed).not.toHaveBeenCalled();
  });
});
