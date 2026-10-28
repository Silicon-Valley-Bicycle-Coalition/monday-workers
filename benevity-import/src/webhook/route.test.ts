import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp, secretsMatch, type AppDeps } from './route';
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
      minDisbursementDate: '2026-01-01',
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

// validReport() plus a second, earlier-dated row; totals 50 + 30.
function twoRowReport(): string {
  return validReport()
    .replace(
      'Totals,',
      '"Acme, Inc.",Project,2026-11-20T00:00:00Z,Sam,Lee,sam@acme.example,x,x,x,94043,,,TXN002,One Time,USD,,BlueSnap,User Donation,30.00,0.00,0.00,0.00,\nTotals,'
    )
    .replaceAll('50.00,0.00,0.00,0.00\nTotal', '80.00,0.00,0.00,0.00\nTotal')
    .replace('Total Donations (Gross),50.00', 'Total Donations (Gross),80.00')
    .replace('Net Total Payment,50.00', 'Net Total Payment,80.00');
}

function gateFor(mode: 'on' | 'hold' | 'off' | 'unknown') {
  return { worker: 'benevity-import', environment: 'sandbox', mode, logLevel: 'normal', piiKeys: ['name', 'email'] } as const;
}

const UPLOAD_EVENT = { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } };

function fakeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const uploadStore: UploadStore = {
    createUpload: vi.fn().mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'now', status: 'parsing', blockCount: 0 }),
    getUploadByAssetId: vi.fn().mockResolvedValue(null),
    markParsed: vi.fn(),
    markError: vi.fn(),
  };
  const disbursementStore: DisbursementStore = {
    findOrCreate: vi
      .fn()
      .mockImplementation((input) => Promise.resolve({ disbursement: { id: 10, worklistItemId: null, ...input }, created: true })),
    getDisbursement: vi.fn(),
    getByWorklistItemId: vi.fn().mockResolvedValue(null),
    claimWorklistItemId: vi.fn().mockImplementation((_id: number, itemId: string) => Promise.resolve(itemId)),
  };
  const rowStore: RowStore = {
    upsertRow: vi.fn().mockResolvedValue('inserted'),
    getRow: vi.fn(),
    getRowByWorklistItemId: vi.fn().mockResolvedValue(null),
    requeueRow: vi.fn().mockResolvedValue({ requeued: [], purged: 0 }),
    requeueDisbursementRows: vi.fn().mockResolvedValue({ requeued: [], purged: 0 }),
    updateStatus: vi.fn(),
    purgeWrittenRawRows: vi.fn(),
    purgeUnresolvedRawRows: vi.fn(),
    listDeadLetteredWithoutWorklistItem: vi.fn(),
  };
  const mondayClient: MondayClient = {
    findItemsByColumnValue: vi.fn().mockResolvedValue([]),
    findItemsByName: vi.fn().mockResolvedValue([]),
    getLinkedItemIds: vi.fn().mockResolvedValue([]),
    createItem: vi.fn().mockResolvedValue({ id: '1', name: 'x' }),
    changeColumnValues: vi.fn(),
    archiveItem: vi.fn().mockResolvedValue(undefined),
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
    gate: async () => gateFor('on'),
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

  it('rejects every request, including an empty ?secret=, when the configured secret is empty', async () => {
    const deps = fakeDeps({ webhookSecret: '' });
    const app = createApp(deps);
    expect((await post(app, { challenge: 'x' }, '')).status).toBe(401);
    expect((await post(app, { challenge: 'x' }, null)).status).toBe(401);
    const retry = await app.request('/webhooks/monday/benevity-retry?secret=', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: 'x' }),
    });
    expect(retry.status).toBe(401);
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

  // #40: the cutoff gates on the disbursement's Period Ending, never on a row's Donation Date.
  // Benevity pays out weeks after the gift, so the first report after the data freeze is full of
  // earlier-dated rows that were never keyed into Salesforce and are in no migrated history.
  describe('disbursement cutoff (#40)', () => {
    it('imports a row donated before the cutoff when its disbursement ended on or after it', async () => {
      const deps = fakeDeps();
      deps.config.benevityImport.minDisbursementDate = '2026-12-10'; // row 2026-12-06 < cutoff <= Period Ending 2026-12-16
      await post(createApp(deps), UPLOAD_EVENT);
      expect(deps.rowStore.upsertRow).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 'TXN001', status: 'ingested' }));
      expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }]);
      expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    });

    it('imports a disbursement whose Period Ending is the cutoff date itself', async () => {
      const deps = fakeDeps();
      deps.config.benevityImport.minDisbursementDate = '2026-12-16';
      await post(createApp(deps), UPLOAD_EVENT);
      expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }]);
    });

    it('skips every row of a disbursement that ended before the cutoff, enqueues nothing, and says what it skipped on the worklist', async () => {
      const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(twoRowReport()) });
      deps.config.benevityImport.minDisbursementDate = '2026-12-17';
      const res = await post(createApp(deps), UPLOAD_EVENT);

      expect(res.status).toBe(200);
      const upserts = (deps.rowStore.upsertRow as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
      expect(upserts.map((row) => [row.transactionId, row.status, row.disbursementId])).toEqual([
        ['TXN001', 'skipped', 10],
        ['TXN002', 'skipped', 10],
      ]);
      expect(deps.queue.sendBatch).not.toHaveBeenCalled();
      // Not held for review: a skipped block is a decision, not a parse problem.
      expect(deps.disbursementStore.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({ needsReview: false, reviewReason: null }));

      expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(1);
      const [boardId, name, columnValues, groupId] = (deps.mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect([boardId, name, groupId]).toEqual([777, 'Disbursement ABC123', 'review']);
      expect(columnValues.amount_c).toBe(80);
      expect(columnValues.date_c).toEqual({ date: '2026-12-16' });
      const reason = columnValues.reason_c as string;
      expect(reason).toMatch(/^Skipped, not imported/);
      expect(reason).toContain('Period Ending 2026-12-16');
      expect(reason).toContain('cutoff 2026-12-17');
      expect(reason).toContain('2 rows');
      expect(reason).toContain('donation dates 2026-11-20 to 2026-12-06');
      expect(reason).toContain('$80.00 gross');
      expect(deps.disbursementStore.claimWorklistItemId).toHaveBeenCalledWith(10, '1');
      expect(deps.uploadStore.markParsed).toHaveBeenCalledWith(1, 1);
    });

    it('tells staff to set Retry to import a skipped disbursement only when a Retry column is configured', async () => {
      const reasonFor = async (retry: boolean) => {
        const deps = fakeDeps();
        deps.config.benevityImport.minDisbursementDate = '2026-12-17';
        if (retry) {
          deps.config.benevityImport.uploadsBoard.retry = {
            column: 'retry_col',
            labels: { needsReview: 'Needs review', retry: 'Retry', queued: 'Queued', done: 'Done' },
          };
        }
        await post(createApp(deps), UPLOAD_EVENT);
        return (deps.mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]![2].reason_c as string;
      };
      expect(await reasonFor(true)).toContain('set Retry to import it');
      expect(await reasonFor(false)).not.toContain('set Retry');
      // One row, one date: no range.
      expect(await reasonFor(false)).toContain('1 row, donation date 2026-12-06');
    });

    it('does not re-post the notice for a skipped disbursement that already has one, but still records its rows', async () => {
      const deps = fakeDeps({
        disbursementStore: {
          ...fakeDeps().disbursementStore,
          findOrCreate: vi.fn().mockResolvedValue({
            disbursement: { id: 10, uploadId: 1, blockIndex: 0, disbursementId: 'ABC123', periodEnding: '2026-12-16', currency: 'USD',
              rowCount: 1, reportedGrossTotal: 50, reportedNetTotal: 50, needsReview: false, reviewReason: null, worklistItemId: '555' },
            created: false,
          }),
        },
      });
      deps.config.benevityImport.minDisbursementDate = '2026-12-17';
      await post(createApp(deps), UPLOAD_EVENT);
      expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
      expect(deps.rowStore.upsertRow).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 'TXN001', status: 'skipped' }));
    });

    it('skips a pre-cutoff block whose totals do not match instead of holding it for review, and mentions the mismatch', async () => {
      const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
      const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(mismatched) });
      deps.config.benevityImport.minDisbursementDate = '2026-12-17';
      await post(createApp(deps), UPLOAD_EVENT);
      expect(deps.rowStore.upsertRow).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
      expect(deps.rowStore.upsertRow).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'needs-review' }));
      const reason = (deps.mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]![2].reason_c as string;
      expect(reason).toMatch(/^Skipped, not imported/);
      expect(reason).toContain('row totals');
    });

    it('still holds a block whose header did not parse for review, whatever the cutoff (it has no Period Ending to gate on)', async () => {
      const badCsv = validReport().replace('Transaction ID,', 'Txn Id Renamed,');
      const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(badCsv) });
      deps.config.benevityImport.minDisbursementDate = '2099-01-01';
      await post(createApp(deps), UPLOAD_EVENT);
      expect(deps.disbursementStore.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({ needsReview: true }));
      const reason = (deps.mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]![2].reason_c as string;
      expect(reason).not.toMatch(/^Skipped/);
    });
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
            reportedGrossTotal: 0, reportedNetTotal: 0, needsReview: true, reviewReason: 'x', worklistItemId: '555' },
          created: false,
        }),
      },
    });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    // Reused the existing row — never re-posted the worklist item.
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    // A header-error block has zero rows to upsert, so this only proves the code path taken
    // (worklistItemId recorded -> skip worklist post) without needing row-level fixtures;
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
            rowCount: 1, reportedGrossTotal: 999, reportedNetTotal: 999, needsReview: true, reviewReason: 'x', worklistItemId: '555' },
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

  it('records the block-level worklist item id on the disbursement', async () => {
    const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(mismatched) });
    (deps.mondayClient.createItem as ReturnType<typeof vi.fn>).mockResolvedValue({ id: '321', name: 'x' });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(deps.disbursementStore.claimWorklistItemId).toHaveBeenCalledWith(10, '321');
    expect(deps.mondayClient.archiveItem).not.toHaveBeenCalled();
  });

  it('posts the worklist item for a known needs-review block that has none recorded yet (a prior attempt died before posting it)', async () => {
    const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
    const deps = fakeDeps({
      fetchCsv: vi.fn().mockResolvedValue(mismatched),
      disbursementStore: {
        ...fakeDeps().disbursementStore,
        findOrCreate: vi.fn().mockResolvedValue({
          disbursement: { id: 10, uploadId: 1, blockIndex: 0, disbursementId: 'ABC123', periodEnding: '2026-12-16', currency: 'USD',
            rowCount: 1, reportedGrossTotal: 999, reportedNetTotal: 999, needsReview: true, reviewReason: 'x', worklistItemId: null },
          created: false,
        }),
      },
    });
    const app = createApp(deps);
    await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });
    expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(deps.disbursementStore.claimWorklistItemId).toHaveBeenCalledWith(10, '1');
  });

  it('keeps the worklist item another concurrent delivery recorded first, and archives its own duplicate', async () => {
    const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
    const deps = fakeDeps({
      fetchCsv: vi.fn().mockResolvedValue(mismatched),
      disbursementStore: {
        ...fakeDeps().disbursementStore,
        claimWorklistItemId: vi.fn().mockResolvedValue('900'), // the other delivery won
      },
    });
    (deps.mondayClient.createItem as ReturnType<typeof vi.fn>).mockResolvedValue({ id: '321', name: 'x' });
    const app = createApp(deps);

    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });

    expect(res.status).toBe(200);
    expect(deps.mondayClient.archiveItem).toHaveBeenCalledWith('321');
  });

  it('still completes the upload when archiving the duplicate worklist item fails', async () => {
    const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
    const deps = fakeDeps({
      fetchCsv: vi.fn().mockResolvedValue(mismatched),
      disbursementStore: { ...fakeDeps().disbursementStore, claimWorklistItemId: vi.fn().mockResolvedValue('900') },
    });
    (deps.mondayClient.archiveItem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday API: HTTP 500'));
    const app = createApp(deps);

    const res = await post(app, { event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 'a1' }] } } });

    expect(res.status).toBe(200);
    expect(deps.uploadStore.markParsed).toHaveBeenCalled();
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

describe('retry webhook (#34)', () => {
  const RETRY = { column: 'retry_col', labels: { needsReview: 'Needs review', retry: 'Retry', queued: 'Queued', done: 'Done' } };

  function retryDeps(overrides: Partial<AppDeps> = {}): AppDeps {
    const deps = fakeDeps(overrides);
    deps.config.benevityImport.uploadsBoard.retry = RETRY;
    return deps;
  }

  function postRetry(app: ReturnType<typeof createApp>, body: unknown, secret: string | null = SECRET) {
    const url = secret === null ? '/webhooks/monday/benevity-retry' : `/webhooks/monday/benevity-retry?secret=${secret}`;
    return app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  const retryEvent = (itemId: number, label = 'Retry', columnId = 'retry_col') => ({
    event: { pulseId: itemId, columnId, value: { label: { index: 1, text: label } } },
  });

  function rowRecord(status: 'needs-review' | 'written' | 'skipped' | 'ingested') {
    return {
      transactionId: 'TXN001', disbursementId: 10, status, mondayEmployeeItemId: null, mondayMatchItemId: null,
      worklistItemId: '4242', rawRow: '{}', error: 'no match', ingestedAt: 't', writtenAt: null,
    };
  }

  it('rejects a request with the wrong secret, and echoes the subscribe challenge', async () => {
    const app = createApp(retryDeps());
    expect((await postRetry(app, retryEvent(1), 'wrong')).status).toBe(401);
    const res = await postRetry(app, { challenge: 'xyz' });
    expect(await res.json()).toEqual({ challenge: 'xyz' });
  });

  it('ignores every event while no retry column is configured', async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await postRetry(app, retryEvent(4242));
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(deps.rowStore.getRowByWorklistItemId).not.toHaveBeenCalled();
  });

  it.each([
    ['another label (including the Worker\'s own Queued write)', retryEvent(4242, 'Queued')],
    ['a cleared column', { event: { pulseId: 4242, columnId: 'retry_col', value: null } }],
    ['another column', retryEvent(4242, 'Retry', 'other_col')],
  ])('ignores %s', async (_name, body) => {
    const deps = retryDeps();
    const app = createApp(deps);
    const res = await postRetry(app, body);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(deps.rowStore.getRowByWorklistItemId).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it('moves a needs-review row back to ingested, enqueues it, and marks the item Queued', async () => {
    const deps = retryDeps();
    (deps.rowStore.getRowByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue(rowRecord('needs-review'));
    (deps.rowStore.requeueRow as ReturnType<typeof vi.fn>).mockResolvedValue({ requeued: ['TXN001'], purged: 0 });
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(4242));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: 'row', enqueued: 1 });
    expect(deps.rowStore.getRowByWorklistItemId).toHaveBeenCalledWith('4242');
    expect(deps.rowStore.requeueRow).toHaveBeenCalledWith('TXN001');
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }]);
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '4242', { retry_col: { label: 'Queued' } });
  });

  it('does not re-enqueue a row that is already written, and marks its item Done', async () => {
    const deps = retryDeps();
    (deps.rowStore.getRowByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue(rowRecord('written'));
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(4242));

    expect(await res.json()).toEqual({ ok: true, outcome: 'row already written', enqueued: 0 });
    expect(deps.rowStore.requeueRow).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '4242', { retry_col: { label: 'Done' } });
  });

  it('releases every held-back row of a block-level item', async () => {
    const deps = retryDeps();
    (deps.disbursementStore.getByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 10 });
    (deps.rowStore.requeueDisbursementRows as ReturnType<typeof vi.fn>).mockResolvedValue({ requeued: ['TXN001', 'TXN002'], purged: 0 });
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(5000));

    expect(await res.json()).toEqual({ ok: true, outcome: 'block', enqueued: 2 });
    expect(deps.rowStore.requeueDisbursementRows).toHaveBeenCalledWith(10);
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }, { transactionId: 'TXN002' }]);
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '5000', { retry_col: { label: 'Queued' } });
  });

  it('does not re-run a row whose raw data was purged, and says why on the item', async () => {
    const deps = retryDeps();
    (deps.rowStore.getRowByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue({ ...rowRecord('needs-review'), rawRow: '{}' });
    (deps.rowStore.requeueRow as ReturnType<typeof vi.fn>).mockResolvedValue({ requeued: [], purged: 1 });
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(4242));

    expect(await res.json()).toEqual({ ok: true, outcome: 'row purged', enqueued: 0, purged: 1 });
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '4242', {
      reason_c: expect.stringMatching(/deletes a row's Benevity details 365 days after import.*by hand/),
      retry_col: { label: 'Needs review' },
    });
  });

  it('on a block Retry, releases the rows it still can and notes the purged ones on the item', async () => {
    const deps = retryDeps();
    (deps.disbursementStore.getByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 10 });
    (deps.rowStore.requeueDisbursementRows as ReturnType<typeof vi.fn>).mockResolvedValue({ requeued: ['TXN001'], purged: 2 });
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(5000));

    expect(await res.json()).toEqual({ ok: true, outcome: 'block', enqueued: 1 });
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }]);
    const calls = (deps.mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![2]).toMatchObject({ reason_c: expect.stringMatching(/^Can't retry 2 row\(s\) in this block/) });
    expect(calls.at(-1)![2]).toEqual({ retry_col: { label: 'Queued' } });
  });

  it('says so on a block item with nothing left to release', async () => {
    const deps = retryDeps();
    (deps.disbursementStore.getByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 10 });
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(5000));

    expect(await res.json()).toEqual({ ok: true, outcome: 'nothing to retry', enqueued: 0, purged: 0 });
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '5000', {
      reason_c: expect.stringMatching(/^Nothing to retry/),
      retry_col: { label: 'Needs review' },
    });
  });

  it('enqueues nothing for an item with no D1 record (pre-0003 or hand-made), and says why on it', async () => {
    const deps = retryDeps();
    const app = createApp(deps);
    const res = await postRetry(app, retryEvent(9999));
    expect(await res.json()).toEqual({ ok: true, outcome: 'unknown item', enqueued: 0 });
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '9999', {
      reason_c: expect.stringMatching(/^Can't retry this item: the Worker has no record/),
      retry_col: { label: 'Needs review' },
    });
  });

  it('marks the item Queued before enqueueing, so the consumer\'s Done/Needs review always lands last', async () => {
    const order: string[] = [];
    const deps = retryDeps({
      queue: { sendBatch: vi.fn().mockImplementation(async () => { order.push('send'); }) },
    });
    (deps.mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('label'); });
    (deps.rowStore.getRowByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue(rowRecord('needs-review'));
    (deps.rowStore.requeueRow as ReturnType<typeof vi.fn>).mockResolvedValue({ requeued: ['TXN001'], purged: 0 });
    const app = createApp(deps);

    await postRetry(app, retryEvent(4242));

    expect(order).toEqual(['label', 'send']);
  });

  it('returns 500 so Monday redelivers when the enqueue fails', async () => {
    const deps = retryDeps({ queue: { sendBatch: vi.fn().mockRejectedValue(new Error('queue down')) } });
    (deps.rowStore.getRowByWorklistItemId as ReturnType<typeof vi.fn>).mockResolvedValue(rowRecord('needs-review'));
    (deps.rowStore.requeueRow as ReturnType<typeof vi.fn>).mockResolvedValue({ requeued: ['TXN001'], purged: 0 });
    const app = createApp(deps);

    const res = await postRetry(app, retryEvent(4242));

    expect(res.status).toBe(500);
  });
});

describe('secretsMatch', () => {
  it('matches only the exact configured secret, and never an unset or empty one', async () => {
    expect(await secretsMatch('s3cret', 's3cret')).toBe(true);
    expect(await secretsMatch('s3cre', 's3cret')).toBe(false);
    expect(await secretsMatch('s3cretX', 's3cret')).toBe(false);
    expect(await secretsMatch(undefined, 's3cret')).toBe(false);
    expect(await secretsMatch('', '')).toBe(false);
    expect(await secretsMatch('anything', undefined)).toBe(false);
  });
});

// The write switch (src/flags.ts): hold/unknown refuse before any store or Monday call; off runs
// the upload route against recording deps and answers the retry route with a skip.
describe('write switch', () => {
  const RETRY = { column: 'retry_col', labels: { retry: 'Retry', queued: 'Queued', done: 'Done', needsReview: 'Needs review' } };
  const retryEvent = { event: { pulseId: 4242, columnId: 'retry_col', value: { label: { index: 1, text: 'Retry' } } } };
  const postRetry = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request(`/webhooks/monday/benevity-retry?secret=${SECRET}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

  function reviewReport(): string {
    // Totals don't match, so the block is held for review and a worklist item is created.
    return validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),60.00');
  }

  afterEach(() => vi.restoreAllMocks());

  it.each(['hold', 'unknown'] as const)('answers the upload route 503 under %s, before any store or Monday call', async (mode) => {
    const deps = fakeDeps({ gate: async () => gateFor(mode) });
    const res = await post(createApp(deps), UPLOAD_EVENT);
    expect(res.status).toBe(503);
    expect(deps.uploadStore.getUploadByAssetId).not.toHaveBeenCalled();
    expect(deps.uploadStore.createUpload).not.toHaveBeenCalled();
    expect(deps.mondayClient.fetchAsset).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it.each(['hold', 'unknown'] as const)('answers the retry route 503 under %s, before any store or Monday call', async (mode) => {
    const deps = fakeDeps({ gate: async () => gateFor(mode) });
    deps.config.benevityImport.uploadsBoard.retry = RETRY;
    const res = await postRetry(createApp(deps), retryEvent);
    expect(res.status).toBe(503);
    expect(deps.rowStore.getRowByWorklistItemId).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).not.toHaveBeenCalled();
  });

  it.each(['hold', 'off'] as const)('still echoes the subscribe challenge under %s', async (mode) => {
    const deps = fakeDeps({ gate: async () => gateFor(mode) });
    const app = createApp(deps);
    const upload = await post(app, { challenge: 'xyz' });
    expect(upload.status).toBe(200);
    expect(await upload.json()).toEqual({ challenge: 'xyz' });
    expect(await (await postRetry(app, { challenge: 'abc' })).json()).toEqual({ challenge: 'abc' });
  });

  it('under off records the rows and stamps the messages, but does not call Monday writes or claim the worklist item', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps = fakeDeps({ gate: async () => gateFor('off') });
    (deps.fetchCsv as ReturnType<typeof vi.fn>).mockResolvedValue(twoRowReport());
    const res = await post(createApp(deps), UPLOAD_EVENT);
    expect(res.status).toBe(200);
    expect(deps.rowStore.upsertRow).toHaveBeenCalledTimes(2);
    expect(deps.uploadStore.markParsed).toHaveBeenCalled();
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([
      { transactionId: 'TXN001', writeStamp: 'dropped' },
      { transactionId: 'TXN002', writeStamp: 'dropped' },
    ]);
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('under off logs the worklist createItem instead of calling it, never claims or archives', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps = fakeDeps({ gate: async () => gateFor('off') });
    (deps.fetchCsv as ReturnType<typeof vi.fn>).mockResolvedValue(reviewReport());
    const res = await post(createApp(deps), UPLOAD_EVENT);
    expect(res.status).toBe(200);
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    expect(deps.mondayClient.archiveItem).not.toHaveBeenCalled();
    expect(deps.disbursementStore.claimWorklistItemId).not.toHaveBeenCalled();
    // The review block's rows are still recorded, and nothing is enqueued.
    expect(deps.rowStore.upsertRow).toHaveBeenCalledWith(expect.objectContaining({ status: 'needs-review' }));
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    const lines = (log.mock.calls as unknown[][]).map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.writeSwitch === 'skipped');
    expect(lines).toEqual([expect.objectContaining({ sink: 'Monday', operation: 'createItem', mode: 'off' })]);
    log.mockRestore();
  });

  it('under on stamps nothing and calls the real writes', async () => {
    const deps = fakeDeps();
    (deps.fetchCsv as ReturnType<typeof vi.fn>).mockResolvedValue(reviewReport());
    await post(createApp(deps), UPLOAD_EVENT);
    expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(deps.disbursementStore.claimWorklistItemId).toHaveBeenCalledTimes(1);

    const sent = fakeDeps();
    await post(createApp(sent), UPLOAD_EVENT);
    expect(sent.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }]);
  });

  it('under off the retry route logs a skip and returns 200, doing nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps = fakeDeps({ gate: async () => gateFor('off') });
    deps.config.benevityImport.uploadsBoard.retry = RETRY;
    const res = await postRetry(createApp(deps), retryEvent);
    expect(res.status).toBe(200);
    expect(deps.rowStore.getRowByWorklistItemId).not.toHaveBeenCalled();
    expect(deps.rowStore.requeueRow).not.toHaveBeenCalled();
    expect(deps.rowStore.requeueDisbursementRows).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    const lines = (log.mock.calls as unknown[][]).map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.writeSwitch === 'skipped');
    expect(lines).toHaveLength(1);
    log.mockRestore();
  });
});
