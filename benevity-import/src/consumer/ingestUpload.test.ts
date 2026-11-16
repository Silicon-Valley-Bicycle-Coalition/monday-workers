import { describe, it, expect, vi } from 'vitest';
import { ingestUpload, MAX_REPORT_LENGTH, readReportText, ReportTooLargeError, type IngestDeps } from './ingestUpload';
import type { MondayClient } from '../monday/client';
import type { UploadStore } from '../db/uploads';
import type { DisbursementStore } from '../db/disbursements';
import type { NewRow, RowStatus, RowStore } from '../db/rows';
import type { BenevityImportConfig } from '../types';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 1, organizations: 1, people: 1, affiliations: 1, benevityUploads: 777 } },
    benevityImport: {
      minDisbursementDate: '2026-01-01',
      donationsColumns: {} as never,
      organizationsNameColumn: 'name',
      peopleColumns: {} as never,
      affiliationsColumns: {} as never,
      affiliationsCurrentLabel: 'Current',
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

function fakeDeps(overrides: Partial<IngestDeps> = {}): IngestDeps {
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
    // Every row new: each comes back at the status it was upserted with.
    upsertRows: vi.fn().mockImplementation(async (rows: NewRow[]) => new Map(rows.map((row) => [row.transactionId, row.status]))),
    getRow: vi.fn(),
    getRowByWorklistItemId: vi.fn().mockResolvedValue(null),
    requeueRow: vi.fn().mockResolvedValue({ requeued: [], purged: 0 }),
    requeueDisbursementRows: vi.fn().mockResolvedValue({ requeued: [], purged: 0 }),
    updateStatus: vi.fn(),
    purgeWrittenRawRows: vi.fn(),
    purgeUnresolvedRawRows: vi.fn(),
    listDeadLetteredWithoutWorklistItem: vi.fn().mockResolvedValue([]),
  };
  const mondayClient: MondayClient = {
    findItemsByColumnValue: vi.fn().mockResolvedValue([]),
    findItemsByName: vi.fn().mockResolvedValue([]),
    getLinkedItemIds: vi.fn().mockResolvedValue([]),
    getStatusLabels: vi.fn().mockResolvedValue(new Map()),
    createItem: vi.fn().mockResolvedValue({ id: '1', name: 'x' }),
    changeColumnValues: vi.fn(),
    archiveItem: vi.fn().mockResolvedValue(undefined),
    fetchAsset: vi.fn().mockResolvedValue({ id: 'a1', name: 'report.csv', publicUrl: 'https://files.monday.com/a1' }),
    fetchItemAssets: vi.fn(),
  };
  return {
    mondayClient,
    uploadStore,
    disbursementStore,
    rowStore,
    config: fakeConfig(),
    queue: { sendBatch: vi.fn().mockResolvedValue(undefined) },
    fetchCsv: vi.fn().mockResolvedValue(validReport()),
    now: () => '2026-09-15T00:00:00Z',
    ...overrides,
  };
}

// Every row passed to rowStore.upsertRows, across all its calls.
function upserted(deps: IngestDeps): NewRow[] {
  return (deps.rowStore.upsertRows as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[0] as NewRow[]);
}

// A store in which TXN001 is already known at `status` from an earlier attempt or upload.
function knownRow(status: RowStatus): Partial<IngestDeps> {
  return {
    rowStore: {
      ...fakeDeps().rowStore,
      upsertRows: vi.fn().mockResolvedValue(new Map([['TXN001', status]])),
    },
  };
}

describe('ingestUpload', () => {
  it('ingests a valid single-block file and enqueues its row', async () => {
    const deps = fakeDeps();
    await ingestUpload('a1', deps);
    expect(upserted(deps)).toContainEqual(
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
    await ingestUpload('a1', deps);
    expect(deps.queue.sendBatch).toHaveBeenCalledTimes(1);
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }, { transactionId: 'TXN002' }]);
  });

  it('re-enqueues a row stuck at "ingested" from a prior attempt whose queue send never went through', async () => {
    // The row already exists in D1 from an earlier attempt and is still sitting at 'ingested' —
    // proof that attempt upserted the row but threw before or during the send, so nothing else
    // will ever retry it.
    const deps = fakeDeps(knownRow('ingested'));
    await ingestUpload('a1', deps);
    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }]);
  });

  it.each(['written', 'needs-review', 'skipped'] as const)('does not re-enqueue a known row whose outcome is already settled (%s)', async (status) => {
    const deps = fakeDeps(knownRow(status));
    await ingestUpload('a1', deps);
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it('upserts a block\'s rows in one batched store call, not one per row', async () => {
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(twoRowReport()) });
    await ingestUpload('a1', deps);
    expect(deps.rowStore.upsertRows).toHaveBeenCalledTimes(1);
    expect(upserted(deps).map((row) => row.transactionId)).toEqual(['TXN001', 'TXN002']);
  });

  it('creates the upload record if the webhook never got to (the consumer is the one that ingests it)', async () => {
    const deps = fakeDeps();
    await ingestUpload('a1', deps);
    expect(deps.uploadStore.createUpload).toHaveBeenCalledWith('a1', '2026-09-15T00:00:00Z');
  });

  it('throws on a failed fetch so the message is retried, without marking the upload errored', async () => {
    const deps = fakeDeps({ fetchCsv: vi.fn().mockRejectedValue(new Error('benevity report fetch: HTTP 503')) });
    await expect(ingestUpload('a1', deps)).rejects.toThrow('HTTP 503');
    expect(deps.uploadStore.markError).not.toHaveBeenCalled();
    expect(deps.uploadStore.markParsed).not.toHaveBeenCalled();
  });

  it('marks a file that is not a Benevity report errored and returns, so it is not retried', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue('Name,Amount\nJordan,50\n') });
    await ingestUpload('a1', deps);
    expect(deps.uploadStore.markError).toHaveBeenCalledWith(1);
    expect(deps.uploadStore.markParsed).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('refuses a file far too large to be a report: marks it errored and returns, so it is not retried', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue('x'.repeat(MAX_REPORT_LENGTH + 1)) });
    await ingestUpload('a1', deps);
    expect(deps.uploadStore.markError).toHaveBeenCalledWith(1);
    expect(deps.disbursementStore.findOrCreate).not.toHaveBeenCalled();
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('is a no-op for an asset already ingested', async () => {
    const deps = fakeDeps({ uploadStore: { ...fakeDeps().uploadStore, getUploadByAssetId: vi.fn().mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 'x', status: 'parsed', blockCount: 1 }) } });
    await ingestUpload('a1', deps);
    expect(deps.mondayClient.fetchAsset).not.toHaveBeenCalled();
  });

  // #40: the cutoff gates on the disbursement's Period Ending, never on a row's Donation Date.
  // Benevity pays out weeks after the gift, so the first report after the data freeze is full of
  // earlier-dated rows that were never keyed into Salesforce and are in no migrated history.
  describe('disbursement cutoff (#40)', () => {
    it('imports a row donated before the cutoff when its disbursement ended on or after it', async () => {
      const deps = fakeDeps();
      deps.config.benevityImport.minDisbursementDate = '2026-12-10'; // row 2026-12-06 < cutoff <= Period Ending 2026-12-16
      await ingestUpload('a1', deps);
      expect(upserted(deps)).toContainEqual(expect.objectContaining({ transactionId: 'TXN001', status: 'ingested' }));
      expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }]);
      expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    });

    it('imports a disbursement whose Period Ending is the cutoff date itself', async () => {
      const deps = fakeDeps();
      deps.config.benevityImport.minDisbursementDate = '2026-12-16';
      await ingestUpload('a1', deps);
      expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001' }]);
    });

    it('skips every row of a disbursement that ended before the cutoff, enqueues nothing, and says what it skipped on the worklist', async () => {
      const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(twoRowReport()) });
      deps.config.benevityImport.minDisbursementDate = '2026-12-17';
      await ingestUpload('a1', deps);

        const upserts = upserted(deps);
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
        await ingestUpload('a1', deps);
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
      await ingestUpload('a1', deps);
      expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
      expect(upserted(deps)).toContainEqual(expect.objectContaining({ transactionId: 'TXN001', status: 'skipped' }));
    });

    it('skips a pre-cutoff block whose totals do not match instead of holding it for review, and mentions the mismatch', async () => {
      const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
      const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(mismatched) });
      deps.config.benevityImport.minDisbursementDate = '2026-12-17';
      await ingestUpload('a1', deps);
      expect(upserted(deps)).toContainEqual(expect.objectContaining({ status: 'skipped' }));
      expect(upserted(deps)).not.toContainEqual(expect.objectContaining({ status: 'needs-review' }));
      const reason = (deps.mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]![2].reason_c as string;
      expect(reason).toMatch(/^Skipped, not imported/);
      expect(reason).toContain('row totals');
    });

    it('still holds a block whose header did not parse for review, whatever the cutoff (it has no Period Ending to gate on)', async () => {
      const badCsv = validReport().replace('Transaction ID,', 'Txn Id Renamed,');
      const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(badCsv) });
      deps.config.benevityImport.minDisbursementDate = '2099-01-01';
      await ingestUpload('a1', deps);
      expect(deps.disbursementStore.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({ needsReview: true }));
      const reason = (deps.mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]![2].reason_c as string;
      expect(reason).not.toMatch(/^Skipped/);
    });
  });

  it('creates one worklist item and marks every row needs-review for a block with a bad header, without enqueueing', async () => {
    const badCsv = validReport().replace('Transaction ID,', 'Txn Id Renamed,');
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(badCsv) });
    await ingestUpload('a1', deps);
    expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(deps.queue.sendBatch).not.toHaveBeenCalled();
  });

  it('creates one worklist item and marks rows needs-review for a block whose totals do not match, without enqueueing', async () => {
    const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(mismatched) });
    await ingestUpload('a1', deps);
    expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(upserted(deps)).toContainEqual(expect.objectContaining({ status: 'needs-review' }));
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
    await ingestUpload('a1', deps);
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
    await ingestUpload('a1', deps);
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
    await ingestUpload('a1', deps);
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
    await ingestUpload('a1', deps);
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled(); // no re-posted worklist item
    // The row IS still upserted against the reused disbursement id — proves a row upsert a
    // partial prior attempt never reached still gets recorded on this retry.
    expect(upserted(deps)).toContainEqual(
      expect.objectContaining({ transactionId: 'TXN001', disbursementId: 10, status: 'needs-review' })
    );
  });

  it('records the block-level worklist item id on the disbursement', async () => {
    const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
    const deps = fakeDeps({ fetchCsv: vi.fn().mockResolvedValue(mismatched) });
    (deps.mondayClient.createItem as ReturnType<typeof vi.fn>).mockResolvedValue({ id: '321', name: 'x' });
    await ingestUpload('a1', deps);
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
    await ingestUpload('a1', deps);
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
    await ingestUpload('a1', deps);

    expect(deps.mondayClient.archiveItem).toHaveBeenCalledWith('321');
  });

  it('still completes the upload when archiving the duplicate worklist item fails', async () => {
    const mismatched = validReport().replace('Total Donations (Gross),50.00', 'Total Donations (Gross),999.00');
    const deps = fakeDeps({
      fetchCsv: vi.fn().mockResolvedValue(mismatched),
      disbursementStore: { ...fakeDeps().disbursementStore, claimWorklistItemId: vi.fn().mockResolvedValue('900') },
    });
    (deps.mondayClient.archiveItem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday API: HTTP 500'));
    await ingestUpload('a1', deps);

    expect(deps.uploadStore.markParsed).toHaveBeenCalled();
  });

  it('marks the upload errored and throws when a block fails mid-processing, so the message is retried', async () => {
    const deps = fakeDeps({
      disbursementStore: {
        ...fakeDeps().disbursementStore,
        findOrCreate: vi.fn().mockRejectedValue(new Error('D1 write failed')),
      },
    });
    await expect(ingestUpload('a1', deps)).rejects.toThrow('D1 write failed');
    expect(deps.uploadStore.markError).toHaveBeenCalledWith(1);
    expect(deps.uploadStore.markParsed).not.toHaveBeenCalled();
  });
});

describe('readReportText', () => {
  // A body with no Content-Length, delivered in chunks, counting how much of it was ever pulled.
  function streamed(chunks: Uint8Array[]) {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[pulled++];
        if (next === undefined) controller.close();
        else controller.enqueue(next);
      },
      cancel() {
        cancelled = true;
      },
    });
    return { response: new Response(body), pulled: () => pulled, cancelled: () => cancelled };
  }

  it('stops reading and cancels a body with no Content-Length as soon as it passes the cap', async () => {
    const chunk = new Uint8Array(512 * 1024);
    const { response, pulled, cancelled } = streamed(Array.from({ length: 100 }, () => chunk)); // 50 MB offered
    await expect(readReportText(response)).rejects.toBeInstanceOf(ReportTooLargeError);
    expect(pulled()).toBeLessThanOrEqual(Math.ceil(MAX_REPORT_LENGTH / chunk.byteLength) + 2);
    expect(cancelled()).toBe(true);
  });

  it('refuses up front when Content-Length is over the cap', async () => {
    const response = new Response('small', { headers: { 'Content-Length': String(MAX_REPORT_LENGTH + 1) } });
    await expect(readReportText(response)).rejects.toThrow('Content-Length');
  });

  it('decodes a body under the cap, including a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('Company,Café\n');
    const split = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    const { response } = streamed([bytes.slice(0, split), bytes.slice(split)]);
    expect(await readReportText(response)).toBe('Company,Café\n');
  });
});
