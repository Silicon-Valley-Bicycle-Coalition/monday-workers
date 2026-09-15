import { describe, it, expect, vi } from 'vitest';
import { processBenevityQueueBatch, type QueueMessageLike, type BenevityQueueMessage, type ProcessBatchDeps } from './processBatch';
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
    rawRow: JSON.stringify(parsed),
    error: null,
    ingestedAt: '2026-09-15T00:00:00Z',
    writtenAt: null,
    ...overrides,
  };
}

function message(transactionId: string): QueueMessageLike<BenevityQueueMessage> {
  return { body: { transactionId }, ack: vi.fn(), retry: vi.fn() };
}

function fakeDeps(overrides: Partial<ProcessBatchDeps> = {}): ProcessBatchDeps {
  const rowStore: RowStore = {
    upsertRow: vi.fn(),
    getRow: vi.fn(),
    updateStatus: vi.fn(),
    purgeWrittenRawRows: vi.fn(),
    purgeUnresolvedRawRows: vi.fn(),
  };
  const disbursementStore: DisbursementStore = {
    createDisbursement: vi.fn(),
    getDisbursement: vi.fn().mockResolvedValue({
      id: 1, uploadId: 1, disbursementId: 'ABC123', periodEnding: '2026-03-16', currency: 'USD',
      rowCount: 1, reportedGrossTotal: 150, reportedNetTotal: 150, needsReview: false, reviewReason: null,
    }),
  };
  const aliasStore: AliasStore = { getAlias: vi.fn().mockResolvedValue(null), learnAlias: vi.fn() };
  const mondayClient = {
    findItemsByColumnValue: vi.fn().mockImplementation(async (boardId, column, value) => {
      // Email lookup for people — match jordan@acme.example
      if (boardId === 333 && (column === 'personal_email_c' || column === 'household_email_c') && value === 'jordan@acme.example') {
        return [{ id: '100', name: 'Jordan Rivera' }];
      }
      return [];
    }),
    findItemsByName: vi.fn().mockImplementation(async (boardId, name) => {
      // Organizations board
      if (boardId === 222 && name.toLowerCase() === 'acme, inc.') {
        return [{ id: '99', name: 'Acme, Inc.' }];
      }
      return [];
    }),
    getLinkedItemIds: vi.fn().mockResolvedValue([]),
    createItem: vi.fn().mockResolvedValue({ id: '501', name: 'x' }),
    changeColumnValues: vi.fn(),
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
    const parsed = fakeParsedRow();
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
});
