import { describe, it, expect, vi } from 'vitest';
import { processBenevityQueueBatch, retryDelaySeconds, type QueueMessageLike, type BenevityQueueMessage, type ProcessBatchDeps } from './processBatch';
import type { RowStore, DonationRowRecord } from '../db/rows';
import type { DisbursementStore } from '../db/disbursements';
import type { AliasStore } from '../db/aliases';
import type { BenevityImportConfig } from '../types';
import type { ParsedRow } from '../parse/report';

function fakeConfig(): BenevityImportConfig {
  return {
    monday: { apiUrl: '', boards: { donations: 111, organizations: 222, people: 333, affiliations: 444, benevityUploads: 777 } },
    benevityImport: {
      minDonationDate: '2026-01-01',
      donationsColumns: {
        donor: 'donor_c', matchedBy: 'matched_by_c', amount: 'amount_c', date: 'date_c',
        disbursementDate: 'disb_date_c', fiscalYearEnding: 'fy_c', status: 'status_c',
        giftType: 'gift_type_c', anonymousDonor: 'anon_c', transactionId: 'txn_c',
      },
      organizationsNameColumn: 'name',
      peopleColumns: { personalEmail: 'personal_email_c', householdEmail: 'household_email_c', employer: 'employer_c' },
      affiliationsColumns: { person: 'person_c', organization: 'org_c', workEmail: 'work_email_c' },
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

function message(transactionId: string, attempts?: number): QueueMessageLike<BenevityQueueMessage> {
  return { body: { transactionId }, ...(attempts === undefined ? {} : { attempts }), ack: vi.fn(), retry: vi.fn() };
}

function fakeDeps(overrides: Partial<ProcessBatchDeps> = {}): ProcessBatchDeps {
  const rowStore: RowStore = {
    upsertRow: vi.fn(),
    getRow: vi.fn(),
    getRowByWorklistItemId: vi.fn(),
    requeueRow: vi.fn(),
    requeueDisbursementRows: vi.fn(),
    updateStatus: vi.fn(),
    purgeWrittenRawRows: vi.fn(),
    purgeUnresolvedRawRows: vi.fn(),
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
    createItem: vi.fn().mockResolvedValue({ id: '501', name: 'x' }),
    changeColumnValues: vi.fn(),
    archiveItem: vi.fn(),
    fetchAsset: vi.fn(),
  };
  return {
    rowStore,
    disbursementStore,
    aliasStore,
    mondayClient: mondayClient as never,
    config: fakeConfig(),
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
        createItem: vi.fn(),
        changeColumnValues: vi.fn(),
        archiveItem: vi.fn(),
        fetchAsset: vi.fn(),
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
        createItem: vi.fn().mockResolvedValue({ id: '1', name: 'x' }),
        changeColumnValues: vi.fn(),
        archiveItem: vi.fn(),
        fetchAsset: vi.fn(),
      } as never,
    });
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    await processBenevityQueueBatch([message('TXN001')], deps);

    const findItemsByColumnValue = deps.mondayClient.findItemsByColumnValue as ReturnType<typeof vi.fn>;
    expect(findItemsByColumnValue).not.toHaveBeenCalledWith(333, expect.anything(), expect.anything()); // people board never queried
    expect(deps.rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'needs-review', expect.any(Object));
  });

  it('leaves the row status alone and retries on an unexpected error', async () => {
    const parsed = fakeParsedRow();
    const deps = fakeDeps({
      mondayClient: {
        findItemsByColumnValue: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
        findItemsByName: vi.fn().mockResolvedValue([{ id: '99', name: 'Acme, Inc.' }]),
        getLinkedItemIds: vi.fn().mockResolvedValue([]),
        createItem: vi.fn(),
        changeColumnValues: vi.fn(),
        archiveItem: vi.fn(),
        fetchAsset: vi.fn(),
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
        createItem: vi.fn(),
        changeColumnValues: vi.fn(),
        archiveItem: vi.fn(),
        fetchAsset: vi.fn(),
      } as never,
    });
    (deps.rowStore.getRow as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRowRecord(parsed));

    const msg = message('TXN001', 2);
    await processBenevityQueueBatch([msg], deps);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
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
        createItem: vi.fn().mockResolvedValue({ id: '900', name: 'x' }),
        changeColumnValues: vi.fn(),
        archiveItem: vi.fn(),
        fetchAsset: vi.fn(),
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

describe('retryDelaySeconds', () => {
  it('grows 60 s x 4^(attempt-1), treating a missing or bad attempt count as the first', () => {
    expect(retryDelaySeconds(undefined)).toBe(60);
    expect(retryDelaySeconds(0)).toBe(60);
    expect(retryDelaySeconds(Number.NaN)).toBe(60);
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(240);
    expect(retryDelaySeconds(3)).toBe(960);
  });

  it('caps at the Queues maximum delay of 43200 s (12 h)', () => {
    expect(retryDelaySeconds(6)).toBe(43200);
    expect(retryDelaySeconds(50)).toBe(43200);
  });
});
