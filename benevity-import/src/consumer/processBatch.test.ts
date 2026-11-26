import { describe, it, expect, vi } from 'vitest';
import { consumeBenevityBatch, processBenevityQueueBatch, type QueueMessageLike, type BenevityQueueMessage, type ProcessBatchDeps } from './processBatch';
import type { RowStore, DonationRowRecord } from '../db/rows';
import type { DisbursementStore } from '../db/disbursements';
import type { AliasStore } from '../db/aliases';
import type { UploadStore } from '../db/uploads';
import type { BenevityImportConfig } from '../types';
import type { ParsedRow } from '../parse/report';
import { MondayApiError } from '../monday/graphql';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 111, organizations: 222, people: 333, affiliations: 444, benevityUploads: 777 } },
    benevityImport: {
      minDisbursementDate: '2026-01-01',
      donationsColumns: {
        donor: 'donor_c', matchedBy: 'matched_by_c', amount: 'amount_c', date: 'date_c',
        disbursementDate: 'disb_date_c', fiscalYearEnding: 'fy_c', status: 'status_c',
        giftType: 'gift_type_c', anonymousDonor: 'anon_c', transactionId: 'txn_c',
      },
      organizationsNameColumn: 'name',
      peopleColumns: { personalEmail: 'personal_email_c', householdEmail: 'household_email_c', employer: 'employer_c' },
      affiliationsColumns: { person: 'person_c', organization: 'org_c', workEmail: 'work_email_c', status: 'aff_status_c' },
      affiliationsCurrentLabel: 'Current',
      uploadsBoard: {
        fileColumn: 'file_c', worklistGroupId: 'review',
        worklistColumns: { reason: 'reason_c', name: 'name_c', email: 'email_c', company: 'company_c', amount: 'amount_c', date: 'date_c' },
      },
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

function fakeParsedRow(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    company: 'Acme, Inc.',
    donorFirstName: 'Jordan',
    donorLastName: 'Rivera',
    email: 'jordan@acme.example',
    donationDate: '2026-03-01',
    transactionId: 'TXN001',
    donationFrequency: 'One Time',
    currency: 'USD',
    totalDonationToBeAcknowledged: 50,
    matchAmount: 100,
    notes: '',
    ...overrides,
  };
}

function fakeRowRecord(parsed: ParsedRow, overrides: Partial<DonationRowRecord> = {}): DonationRowRecord {
  return {
    transactionId: parsed.transactionId,
    disbursementId: 1,
    status: 'ingested',
    mondayEmployeeItemId: null,
    mondayMatchItemId: null,
    worklistItemId: null,
    rawRow: JSON.stringify(parsed),
    error: null,
    ingestedAt: '2026-09-15T00:00:00Z',
    writtenAt: null,
    ...overrides,
  };
}

function message(transactionId: string, attempts?: number, writeStamp?: 'dropped'): QueueMessageLike<BenevityQueueMessage> {
  return { body: { transactionId, ...(writeStamp ? { writeStamp } : {}) }, ...(attempts === undefined ? {} : { attempts }), ack: vi.fn(), retry: vi.fn() };
}

function fakeDeps(overrides: Partial<ProcessBatchDeps> = {}): ProcessBatchDeps {
  const rowStore: RowStore = {
    upsertRows: vi.fn(),
    getRow: vi.fn(),
    getRowByWorklistItemId: vi.fn(),
    requeueRow: vi.fn(),
    requeueDisbursementRows: vi.fn(),
    updateStatus: vi.fn(),
    purgeWrittenRawRows: vi.fn(),
    purgeUnresolvedRawRows: vi.fn(),
    listDeadLetteredWithoutWorklistItem: vi.fn(),
  };
  const disbursementStore: DisbursementStore = {
    findOrCreate: vi.fn(),
    getDisbursement: vi.fn().mockResolvedValue({
      id: 1, uploadId: 1, blockIndex: 0, disbursementId: 'ABC123', periodEnding: '2026-03-16', currency: 'USD',
      rowCount: 1, reportedGrossTotal: 150, reportedNetTotal: 150, needsReview: false, reviewReason: null, worklistItemId: null,
    }),
    getByWorklistItemId: vi.fn(),
    claimWorklistItemId: vi.fn(),
  };
  const aliasStore: AliasStore = { getAlias: vi.fn().mockResolvedValue(null), learnAlias: vi.fn() };
  const mondayClient = {
    findItemsByColumnValue: vi.fn().mockResolvedValue([]),
    findItemsByName: vi.fn().mockResolvedValue([{ id: '99', name: 'Acme, Inc.' }]),
    getLinkedItemIds: vi.fn().mockResolvedValue([]),
    getStatusLabels: vi.fn().mockResolvedValue(new Map()),
    createItem: vi.fn().mockResolvedValue({ id: '501', name: 'x' }),
    changeColumnValues: vi.fn(),
    archiveItem: vi.fn(),
    fetchAsset: vi.fn(),
    fetchItemAssets: vi.fn(),
    fetchItemStatus: vi.fn(),
  };
  const uploadStore: UploadStore = {
    createUpload: vi.fn(),
    getUploadByAssetId: vi.fn().mockResolvedValue(null),
    markParsed: vi.fn(),
    markError: vi.fn(),
  };
  return {
    uploadStore,
    rowStore,
    disbursementStore,
    aliasStore,
    mondayClient: mondayClient as never,
    config: fakeConfig(),
    queue: { sendBatch: vi.fn().mockResolvedValue(undefined) },
    fetchCsv: vi.fn(),
    now: () => '2026-09-15T00:00:00Z',
    ...overrides,
  };
}

describe('processBenevityQueueBatch', () => {
  it('resolves company and (absent) person, writes both gifts, and marks the row written', async () => {
    // Donor identity withheld (Benevity's "Not shared by donor" sentinel, per people.test.ts's
    // `anonymousRow`) so resolvePerson short-circuits to 'anonymous' before any Monday lookup —
    // the only production-code path where personItemId ends up null and processOne still writes
    // the gifts (an 'unresolved' person is a business failure that goes to the worklist instead;
    // see people.ts's isWithheld/hasEmail/hasName gate and processBatch.ts's status checks).
    const parsed = fakeParsedRow({
      donorFirstName: 'Not shared by donor',
      donorLastName: 'Not shared by donor',
      email: 'Not shared by donor',
    });
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    const msg = message('TXN001');
    await processBenevityQueueBatch([msg], deps);

    expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(2); // employee gift + match gift
    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith(
      'TXN001',
      'written',
      expect.objectContaining({ mondayEmployeeItemId: '501', mondayMatchItemId: '501', writtenAt: '2026-09-15T00:00:00Z' })
    );
    expect(msg.ack).toHaveBeenCalled();

    // No person resolved: no Donor link, and the Anonymous Donor checkbox is set, on both gifts.
    const createItem = deps.mondayClient.createItem as ReturnType<typeof vi.fn>;
    for (const call of createItem.mock.calls) {
      const columnValues = call[2] as Record<string, unknown>;
      expect(columnValues).not.toHaveProperty('donor_c');
      expect(columnValues.anon_c).toEqual({ checked: 'true' });
    }
  });

  it('updates an existing Donations item instead of creating a duplicate, when one is already stamped with the Transaction ID', async () => {
    const parsed = fakeParsedRow({ matchAmount: 0 }); // single gift, simpler assertion
    const deps = fakeDeps({
      mondayClient: {
        findItemsByColumnValue: vi.fn().mockResolvedValue([{ id: '900', name: 'existing' }]),
        findItemsByName: vi.fn().mockResolvedValue([{ id: '99', name: 'Acme, Inc.' }]),
        getLinkedItemIds: vi.fn().mockResolvedValue([]),
        getStatusLabels: vi.fn().mockResolvedValue(new Map()),
        createItem: vi.fn(),
        changeColumnValues: vi.fn(),
        archiveItem: vi.fn(),
        fetchAsset: vi.fn(),
        fetchItemAssets: vi.fn(),
        fetchItemStatus: vi.fn(),
      } as never,
    });
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    await processBenevityQueueBatch([message('TXN001')], deps);

    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(111, '900', expect.any(Object));
  });

  it('is a no-op for a row already written', async () => {
    const parsed = fakeParsedRow();
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed, { status: 'written' }));

    const msg = message('TXN001');
    await processBenevityQueueBatch([msg], deps);

    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
  });

  it('worklists and marks needs-review for a non-USD row, acking the message', async () => {
    const parsed = fakeParsedRow({ currency: 'EUR' });
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    const msg = message('TXN001');
    await processBenevityQueueBatch([msg], deps);

    expect(deps.mondayClient.createItem).toHaveBeenCalledWith(777, expect.any(String), expect.any(Object), 'review');
    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'needs-review', expect.objectContaining({ error: expect.stringMatching(/EUR/) }));
    expect(msg.ack).toHaveBeenCalled();
  });

  it('worklists and marks needs-review for a negative amount', async () => {
    const parsed = fakeParsedRow({ matchAmount: -10 });
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    await processBenevityQueueBatch([message('TXN001')], deps);

    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'needs-review', expect.objectContaining({ error: expect.stringMatching(/negative/) }));
  });

  it('worklists and marks needs-review when the company does not resolve, without attempting person resolution', async () => {
    const parsed = fakeParsedRow();
    const deps = fakeDeps({
      mondayClient: {
        findItemsByColumnValue: vi.fn().mockResolvedValue([]),
        findItemsByName: vi.fn().mockResolvedValue([]), // no Organization match
        getLinkedItemIds: vi.fn().mockResolvedValue([]),
        getStatusLabels: vi.fn().mockResolvedValue(new Map()),
        createItem: vi.fn().mockResolvedValue({ id: '1', name: 'x' }),
        changeColumnValues: vi.fn(),
        archiveItem: vi.fn(),
        fetchAsset: vi.fn(),
        fetchItemAssets: vi.fn(),
        fetchItemStatus: vi.fn(),
      } as never,
    });
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    await processBenevityQueueBatch([message('TXN001')], deps);

    const findItemsByColumnValue = deps.mondayClient.findItemsByColumnValue as ReturnType<typeof vi.fn>;
    expect(findItemsByColumnValue).not.toHaveBeenCalledWith(333, expect.anything(), expect.anything()); // people board never queried
    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'needs-review', expect.any(Object));
  });

  it('names the worklist item after the company when the donor withheld their name', async () => {
    const parsed = { ...fakeParsedRow(), donorFirstName: 'Not shared by donor', donorLastName: 'Not shared by donor', email: 'Not shared by donor' };
    const createItem = vi.fn().mockResolvedValue({ id: '1', name: 'x' });
    const deps = fakeDeps({
      mondayClient: {
        findItemsByColumnValue: vi.fn().mockResolvedValue([]),
        findItemsByName: vi.fn().mockResolvedValue([]), // no Organization match
        getLinkedItemIds: vi.fn().mockResolvedValue([]),
        getStatusLabels: vi.fn().mockResolvedValue(new Map()),
        createItem,
        changeColumnValues: vi.fn(),
        archiveItem: vi.fn(),
        fetchAsset: vi.fn(),
        fetchItemAssets: vi.fn(),
        fetchItemStatus: vi.fn(),
      } as never,
    });
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    await processBenevityQueueBatch([message('TXN001')], deps);

    expect(createItem).toHaveBeenCalledWith(expect.anything(), parsed.company, expect.any(Object), expect.anything());
  });

  it('leaves the row status alone and retries on an unexpected error', async () => {
    const parsed = fakeParsedRow();
    const deps = fakeDeps({
      mondayClient: {
        findItemsByColumnValue: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
        findItemsByName: vi.fn().mockResolvedValue([{ id: '99', name: 'Acme, Inc.' }]),
        getLinkedItemIds: vi.fn().mockResolvedValue([]),
        getStatusLabels: vi.fn().mockResolvedValue(new Map()),
        createItem: vi.fn(),
        changeColumnValues: vi.fn(),
        archiveItem: vi.fn(),
        fetchAsset: vi.fn(),
        fetchItemAssets: vi.fn(),
        fetchItemStatus: vi.fn(),
      } as never,
    });
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    const msg = message('TXN001');
    await processBenevityQueueBatch([msg], deps);

    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'ingested', expect.objectContaining({ error: expect.stringMatching(/HTTP 500/) }));
    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('backs a retry off by attempt instead of retrying immediately', async () => {
    const parsed = fakeParsedRow();
    const deps = fakeDeps({
      mondayClient: {
        findItemsByColumnValue: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
        findItemsByName: vi.fn().mockResolvedValue([{ id: '99', name: 'Acme, Inc.' }]),
        getLinkedItemIds: vi.fn().mockResolvedValue([]),
        getStatusLabels: vi.fn().mockResolvedValue(new Map()),
        createItem: vi.fn(),
        changeColumnValues: vi.fn(),
        archiveItem: vi.fn(),
        fetchAsset: vi.fn(),
        fetchItemAssets: vi.fn(),
        fetchItemStatus: vi.fn(),
      } as never,
    });
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    const msg = message('TXN001', 2);
    await processBenevityQueueBatch([msg], deps);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
  });

  it('still retries (with backoff) when recording the failure in D1 also fails', async () => {
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('D1 unavailable'));
    (deps.rowStore.updateStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('D1 unavailable'));

    const msg = message('TXN001', 1);
    await expect(processBenevityQueueBatch([msg], deps)).resolves.toBeUndefined();

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msg.ack).not.toHaveBeenCalled();
  });
});

describe('processBenevityQueueBatch worklist idempotency (#34)', () => {
  function unresolvedCompanyDeps() {
    return fakeDeps({
      mondayClient: {
        findItemsByColumnValue: vi.fn().mockResolvedValue([]),
        findItemsByName: vi.fn().mockResolvedValue([]), // no Organization match
        getLinkedItemIds: vi.fn().mockResolvedValue([]),
        getStatusLabels: vi.fn().mockResolvedValue(new Map()),
        createItem: vi.fn().mockResolvedValue({ id: '900', name: 'x' }),
        changeColumnValues: vi.fn(),
        archiveItem: vi.fn(),
        fetchAsset: vi.fn(),
        fetchItemAssets: vi.fn(),
        fetchItemStatus: vi.fn(),
      } as never,
    });
  }

  it('records the new worklist item id in the same write that marks the row needs-review', async () => {
    const parsed = fakeParsedRow();
    const deps = unresolvedCompanyDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    await processBenevityQueueBatch([message('TXN001')], deps);

    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'needs-review', expect.objectContaining({ worklistItemId: '900' }));
  });

  it("reuses the row's recorded worklist item instead of posting another", async () => {
    const parsed = fakeParsedRow();
    const deps = unresolvedCompanyDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed, { worklistItemId: '77' }));

    await processBenevityQueueBatch([message('TXN001')], deps);

    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '77', { reason_c: expect.any(String) });
    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'needs-review', expect.objectContaining({ worklistItemId: '77' }));
  });

  it("marks a replayed row's worklist item Done once its gifts are written", async () => {
    const withheld = 'Not shared by donor'; // anonymous, so the row resolves and is written
    const parsed = fakeParsedRow({ donorFirstName: withheld, donorLastName: withheld, email: withheld });
    const deps = fakeDeps();
    deps.config.benevityImport.uploadsBoard.retry = {
      column: 'retry_c',
      labels: { needsReview: 'Needs review', retry: 'Retry', queued: 'Queued', done: 'Done' },
    };
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed, { worklistItemId: '77' }));

    await processBenevityQueueBatch([message('TXN001')], deps);

    expect(deps.mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '77', { retry_c: { label: 'Done' } });
    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'written', expect.any(Object));
  });

  it.each(['needs-review', 'skipped', 'written'] as const)('is a no-op for a stale message whose row is already %s', async (status) => {
    const parsed = fakeParsedRow();
    const deps = unresolvedCompanyDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed, { status }));

    const msg = message('TXN001');
    await processBenevityQueueBatch([msg], deps);

    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    expect(deps.rowStore.updateStatus).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
  });
});

describe('consumeBenevityBatch — write switch', () => {
  const gate = (mode: 'on' | 'hold' | 'off' | 'unknown') =>
    ({ worker: 'benevity-import', environment: 'sandbox', mode, logLevel: 'normal', piiKeys: ['name', 'email'] }) as const;

  // An anonymous donor, so the row resolves with no Person and writes both gifts.
  const anonymous = () =>
    fakeParsedRow({ donorFirstName: 'Not shared by donor', donorLastName: 'Not shared by donor', email: 'Not shared by donor' });

  function readyDeps(parsed = anonymous()) {
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));
    return deps;
  }

  const skipLines = (log: { mock: { calls: unknown[][] } }) =>
    log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.writeSwitch === 'skipped');

  it('under on writes, and an unstamped legacy message (enqueued before the switch) is live', async () => {
    const deps = readyDeps();
    const msg = message('TXN001'); // no writeStamp field at all
    await consumeBenevityBatch([msg], deps, gate('on'));
    expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(2);
    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'written', expect.anything());
    expect(msg.ack).toHaveBeenCalled();
  });

  it('under off makes no real Monday write and no row-status write, logs each skip, and acks', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps = readyDeps();
    const msg = message('TXN001');
    await consumeBenevityBatch([msg], deps, gate('off'));
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    expect(deps.mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(deps.rowStore.updateStatus).not.toHaveBeenCalled();
    expect(skipLines(log).map((l) => l.operation)).toEqual(['createItem', 'createItem']);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('under off the worklist path logs the Monday write and leaves the row alone', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps = readyDeps(fakeParsedRow({ currency: 'EUR' }));
    const msg = message('TXN001');
    await consumeBenevityBatch([msg], deps, gate('off'));
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    expect(deps.rowStore.updateStatus).not.toHaveBeenCalled();
    expect(skipLines(log).map((l) => l.operation)).toEqual(['createItem']);
    expect(msg.ack).toHaveBeenCalled();
    log.mockRestore();
  });

  it('a message stamped dropped stays a dry run even once the mode is on', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps = readyDeps();
    const msg = message('TXN001', undefined, 'dropped');
    await consumeBenevityBatch([msg], deps, gate('on'));
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
    expect(deps.rowStore.updateStatus).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
    log.mockRestore();
  });

  it('a failure under off does not write the error back to the row', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = readyDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await consumeBenevityBatch([message('TXN001')], deps, gate('off'));
    expect(deps.rowStore.updateStatus).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });

  it.each(['hold', 'unknown'] as const)('under %s retries at 60 s without reading the row or touching Monday', async (mode) => {
    const deps = readyDeps();
    const msg = message('TXN001', 1);
    await consumeBenevityBatch([msg], deps, gate(mode));
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(deps.rowStore.getRow).not.toHaveBeenCalled();
    expect(deps.mondayClient.createItem).not.toHaveBeenCalled();
  });

  it('retries on the shared backoff: attempt 8 waits 3600 s', async () => {
    const deps = readyDeps();
    const held = message('TXN001', 8);
    await consumeBenevityBatch([held], deps, gate('hold'));
    expect(held.retry).toHaveBeenCalledWith({ delaySeconds: 3600 });

    // And a real failure under on backs off the same way.
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('D1 down'));
    const failed = message('TXN001', 8);
    await consumeBenevityBatch([failed], deps, gate('on'));
    expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
    err.mockRestore();
  });
});

// Upload messages (GL#74): the webhook only records and enqueues a report; the consumer ingests it.
// ingestUpload itself is covered in ingestUpload.test.ts — these cover the dispatch around it.
describe('consumeBenevityBatch — upload messages', () => {
  const gate = (mode: 'on' | 'off' | 'hold') =>
    ({ worker: 'benevity-import', environment: 'sandbox', mode, logLevel: 'normal', piiKeys: ['name', 'email'] }) as const;

  function uploadMessage(writeStamp?: 'dropped', attempts?: number): QueueMessageLike<BenevityQueueMessage> {
    return { body: { assetId: 'a1', ...(writeStamp ? { writeStamp } : {}) }, ...(attempts === undefined ? {} : { attempts }), ack: vi.fn(), retry: vi.fn() };
  }

  // An already-parsed upload: ingestUpload returns at once, so these tests see only the dispatch.
  function parsedDeps() {
    const deps = fakeDeps();
    (deps.uploadStore.getUploadByAssetId as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 't', status: 'parsed', blockCount: 1 });
    return deps;
  }

  it('ingests the upload and acks, without treating it as a row', async () => {
    const deps = parsedDeps();
    const msg = uploadMessage();
    await consumeBenevityBatch([msg], deps, gate('on'));
    expect(deps.uploadStore.getUploadByAssetId).toHaveBeenCalledWith('a1');
    expect(deps.rowStore.getRow).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
  });

  it('retries on the shared backoff when ingesting fails, and leaves no row status behind', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = fakeDeps();
    (deps.mondayClient.fetchAsset as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday API: HTTP 500'));
    const msg = uploadMessage(undefined, 3);
    await consumeBenevityBatch([msg], deps, gate('on'));
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(deps.rowStore.updateStatus).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('under hold retries without touching the upload', async () => {
    const deps = parsedDeps();
    const msg = uploadMessage(undefined, 1);
    await consumeBenevityBatch([msg], deps, gate('hold'));
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(deps.uploadStore.getUploadByAssetId).not.toHaveBeenCalled();
  });

  it('a dropped upload stays a dry run under on: its rows are stamped dropped and no worklist item is posted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const deps = fakeDeps();
    (deps.uploadStore.createUpload as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, mondayAssetId: 'a1', uploadedAt: 't', status: 'parsing', blockCount: 0 });
    (deps.mondayClient.fetchAsset as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'a1', name: 'r.csv', publicUrl: 'https://files.monday.com/a1' });
    (deps.fetchCsv as ReturnType<typeof vi.fn>).mockResolvedValue(REPORT);
    (deps.disbursementStore.findOrCreate as ReturnType<typeof vi.fn>).mockImplementation(async (input) => ({ disbursement: { id: 10, worklistItemId: null, ...input }, created: true }));
    (deps.rowStore.upsertRows as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['TXN001', 'ingested']]));
    const msg = uploadMessage('dropped');

    await consumeBenevityBatch([msg], deps, gate('on'));

    expect(deps.queue.sendBatch).toHaveBeenCalledWith([{ transactionId: 'TXN001', writeStamp: 'dropped' }]);
    expect(deps.uploadStore.markParsed).toHaveBeenCalledWith(1, 1); // still recorded as seen
    expect(msg.ack).toHaveBeenCalled();
    log.mockRestore();
  });
});

const REPORT = [
  'Donations Report,',
  '"#---",',
  'Charity Name,SVBC',
  'Charity ID,123',
  'Period Ending,Tue 16 Mar 2026 0:00:00',
  'Currency,USD',
  'Payment Method,EFT',
  'Disbursement ID,ABC123',
  'Note,',
  '"#---",',
  '',
  'Company,Project,Donation Date,Donor First Name,Donor Last Name,Email,Address,City,State/Province,Postal Code,Activity,Comment,Transaction ID,Donation Frequency,Currency,Project Remote ID,Source,Reason,Total Donation to be Acknowledged,Match Amount,Cause Support Fee,Merchant Fee,Fee Comment',
  '"Acme, Inc.",Project,2026-03-06T00:00:00Z,Jordan,Rivera,jordan@acme.example,x,x,x,94043,,,TXN001,One Time,USD,,BlueSnap,User Donation,50.00,0.00,0.00,0.00,',
  'Totals,,,,,,,,,,,,,,,,,,50.00,0.00,0.00,0.00',
  'Total Donations (Gross),50.00',
  'Check Fee,0.00',
  'Net Total Payment,50.00',
  '',
].join('\n');

// GL#101: once one message hits a Monday outage, the rest of the batch is retried with backoff
// without calling Monday, instead of each repeating the transport's in-process attempts.
describe('consumeBenevityBatch — outage breaker', () => {
  const gate = (mode: 'on' | 'hold' | 'off') =>
    ({ worker: 'benevity-import', environment: 'sandbox', mode, logLevel: 'normal', piiKeys: ['name', 'email'] }) as const;
  const anonymous = () =>
    fakeParsedRow({ donorFirstName: 'Not shared by donor', donorLastName: 'Not shared by donor', email: 'Not shared by donor', matchAmount: 0 });

  function outageDeps(err: Error) {
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(anonymous()));
    (deps.mondayClient.createItem as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    return deps;
  }

  it('stops calling Monday after an outage and retries the rest of the batch with backoff', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = outageDeps(new MondayApiError('monday API: HTTP 503', { httpStatus: 503 }));
    const msgs = [message('TXN001', 2), message('TXN002', 1), { body: { assetId: 'a1' }, attempts: 4, ack: vi.fn(), retry: vi.fn() }];

    await consumeBenevityBatch(msgs, deps, gate('on'));

    expect(deps.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(deps.rowStore.getRow).toHaveBeenCalledTimes(1);
    expect(deps.uploadStore.getUploadByAssetId).not.toHaveBeenCalled();
    expect(msgs.map((m) => (m.retry as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toEqual([{ delaySeconds: 120 }, { delaySeconds: 60 }, { delaySeconds: 480 }]);
    for (const m of msgs) expect(m.ack).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("raises the deferral to Monday's Retry-After hint", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = outageDeps(new MondayApiError('monday API: HTTP 429', { httpStatus: 429, retryAfterSeconds: 700 }));
    const msgs = [message('TXN001', 1), message('TXN002', 1)];

    await processBenevityQueueBatch(msgs, deps);

    expect(msgs[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 700 });
    expect(msgs[1]!.retry).toHaveBeenCalledWith({ delaySeconds: 700 });
    errors.mockRestore();
  });

  it('an ordinary failure stays per-message: the next row still runs', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('D1_ERROR: overloaded'))
      .mockResolvedValue(fakeRowRecord(anonymous()));
    const msgs = [message('TXN001', 1), message('TXN002', 1)];

    await consumeBenevityBatch(msgs, deps, gate('on'));

    expect(msgs[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msgs[1]!.ack).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('hold is unchanged: every message backs off and nothing is read', async () => {
    const deps = fakeDeps();
    const msgs = [message('TXN001', 3), message('TXN002', 1)];

    await consumeBenevityBatch(msgs, deps, gate('hold'));

    expect(msgs.map((m) => (m.retry as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toEqual([{ delaySeconds: 240 }, { delaySeconds: 60 }]);
    expect(deps.rowStore.getRow).not.toHaveBeenCalled();
  });
});

// A disbursement's rows share one company and one disbursement; read each once per batch (GL#101).
describe('consumeBenevityBatch — per-batch lookups', () => {
  const gate = (mode: 'on' | 'off') =>
    ({ worker: 'benevity-import', environment: 'sandbox', mode, logLevel: 'normal', piiKeys: ['name', 'email'] }) as const;

  function threeRowDeps() {
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockImplementation(async (transactionId: string) =>
      // Name only, no email: each row walks the Affiliation and Employer lookups for the Organization.
      fakeRowRecord(fakeParsedRow({ transactionId, email: 'Not shared by donor', matchAmount: 0 }))
    );
    return deps;
  }

  it('resolves the Organization, the disbursement and its Affiliations once for rows that share them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = threeRowDeps();
    const findItemsByName = deps.mondayClient.findItemsByName as ReturnType<typeof vi.fn>;
    const findItemsByColumnValue = deps.mondayClient.findItemsByColumnValue as ReturnType<typeof vi.fn>;

    await consumeBenevityBatch([message('TXN001'), message('TXN002'), message('TXN003')], deps, gate('on'));

    expect(findItemsByName.mock.calls.filter(([boardId]) => boardId === 222)).toHaveLength(1); // Organizations
    expect(findItemsByName.mock.calls.filter(([boardId]) => boardId === 333)).toHaveLength(3); // People, per donor
    expect(findItemsByColumnValue.mock.calls.filter(([, columnId]) => columnId === 'org_c')).toHaveLength(1);
    expect(findItemsByColumnValue.mock.calls.filter(([, columnId]) => columnId === 'employer_c')).toHaveLength(1);
  });

  it('reads a shared disbursement once', async () => {
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockImplementation(async (transactionId: string) =>
      fakeRowRecord(fakeParsedRow({ transactionId, donorFirstName: 'Not shared by donor', donorLastName: 'Not shared by donor', email: 'Not shared by donor' }))
    );
    const msgs = [message('TXN001'), message('TXN002')];

    await consumeBenevityBatch(msgs, deps, gate('on'));

    expect(deps.disbursementStore.getDisbursement).toHaveBeenCalledTimes(1);
    for (const m of msgs) expect(m.ack).toHaveBeenCalled();
  });

  it('reads a missing disbursement again for the next row rather than remembering the miss', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = fakeDeps();
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockImplementation(async (transactionId: string) =>
      fakeRowRecord(fakeParsedRow({ transactionId, donorFirstName: 'Not shared by donor', donorLastName: 'Not shared by donor', email: 'Not shared by donor' }))
    );
    (deps.disbursementStore.getDisbursement as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const msgs = [message('TXN001'), message('TXN002')];

    await consumeBenevityBatch(msgs, deps, gate('on'));

    expect(deps.disbursementStore.getDisbursement).toHaveBeenCalledTimes(2);
    for (const m of msgs) expect(m.retry).toHaveBeenCalled();
  });
});
