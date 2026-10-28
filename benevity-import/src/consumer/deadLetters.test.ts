import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processDeadLetters, sweepDeadLetteredRows, deadLetterReason, SWEEP_LIMIT, type DeadLetterDeps } from './deadLetters';
import type { BenevityQueueMessage, QueueMessageLike } from './processBatch';
import { DEAD_LETTER_PREFIX, type DonationRowRecord, type RowStore } from '../db/rows';
import type { BenevityImportConfig } from '../types';
import type { UploadStore } from '../db/uploads';
import type { ParsedRow } from '../parse/report';

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
      affiliationsColumns: { person: 'person_c', organization: 'org_c', workEmail: 'work_email_c' },
      uploadsBoard: {
        fileColumn: 'file_c', worklistGroupId: 'review',
        worklistColumns: { reason: 'reason_c', name: 'name_c', email: 'email_c', company: 'company_c', amount: 'amount_c', date: 'date_c' },
        worklistKeyColumn: 'key_c',
        retry: { column: 'retry_c', labels: { needsReview: 'Needs review', retry: 'Retry', queued: 'Queued', done: 'Done' } },
      },
      organizationAliases: {},
      rawRowRetentionDays: 90,
      unresolvedRowRetentionDays: 365,
    },
  };
}

const parsed: ParsedRow = {
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
};

function row(overrides: Partial<DonationRowRecord> = {}): DonationRowRecord {
  return {
    transactionId: 'TXN001',
    disbursementId: 1,
    status: 'ingested',
    mondayEmployeeItemId: null,
    mondayMatchItemId: null,
    worklistItemId: null,
    rawRow: JSON.stringify(parsed),
    error: 'monday: HTTP 503',
    ingestedAt: '2026-09-15T00:00:00Z',
    writtenAt: null,
    ...overrides,
  };
}

function message(body: unknown): QueueMessageLike<BenevityQueueMessage> {
  return { body: body as BenevityQueueMessage, ack: vi.fn(), retry: vi.fn() };
}

function fakeDeps(overrides: Partial<DeadLetterDeps> = {}) {
  const rowStore = {
    upsertRows: vi.fn(),
    getRow: vi.fn().mockResolvedValue(row()),
    getRowByWorklistItemId: vi.fn(),
    requeueRow: vi.fn(),
    requeueDisbursementRows: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    purgeWrittenRawRows: vi.fn(),
    purgeUnresolvedRawRows: vi.fn(),
    listDeadLetteredWithoutWorklistItem: vi.fn().mockResolvedValue([]),
  } satisfies RowStore;
  const mondayClient = {
    findItemsByColumnValue: vi.fn().mockResolvedValue([]),
    findItemsByName: vi.fn(),
    getLinkedItemIds: vi.fn(),
    createItem: vi.fn().mockResolvedValue({ id: '901', name: 'x' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    archiveItem: vi.fn(),
    fetchAsset: vi.fn(),
  };
  const uploadStore = {
    createUpload: vi.fn(),
    getUploadByAssetId: vi.fn().mockResolvedValue({ id: 3, mondayAssetId: 'a1', uploadedAt: 't', status: 'parsing', blockCount: 0 }),
    markParsed: vi.fn(),
    markError: vi.fn().mockResolvedValue(undefined),
  } satisfies UploadStore;
  const deps = { rowStore, uploadStore, mondayClient: mondayClient as never, config: fakeConfig(), writesOn: true, ...overrides };
  return { deps, rowStore, uploadStore, mondayClient };
}

const stamped = `${DEAD_LETTER_PREFIX}monday: HTTP 503`;

describe('processDeadLetters', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('marks an ingested row needs-review with the dead-letter prefix, posts a worklist item, and records it', async () => {
    const { deps, rowStore, mondayClient } = fakeDeps();
    const msg = message({ transactionId: 'TXN001' });

    const summary = await processDeadLetters([msg], deps);

    expect(rowStore.updateStatus).toHaveBeenNthCalledWith(1, 'TXN001', 'needs-review', { error: stamped });
    expect(mondayClient.findItemsByColumnValue).toHaveBeenCalledWith(777, 'key_c', 'TXN001');
    expect(mondayClient.createItem).toHaveBeenCalledWith(
      777,
      'Jordan Rivera',
      expect.objectContaining({
        reason_c: deadLetterReason(stamped),
        company_c: 'Acme, Inc.',
        amount_c: 150,
        key_c: 'TXN001',
        retry_c: { label: 'Needs review' },
      }),
      'review'
    );
    expect(rowStore.updateStatus).toHaveBeenNthCalledWith(2, 'TXN001', 'needs-review', { error: stamped, worklistItemId: '901' });
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(summary).toEqual({ marked: ['TXN001'], uploads: [], awaitingWorklist: [] });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1 gift dead-lettered'));
  });

  it('marks D1 but leaves the worklist item to the sweep while writes are not on', async () => {
    const { deps, rowStore, mondayClient } = fakeDeps({ writesOn: false });
    const msg = message({ transactionId: 'TXN001' });

    const summary = await processDeadLetters([msg], deps);

    expect(rowStore.updateStatus).toHaveBeenCalledTimes(1);
    expect(rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'needs-review', { error: stamped });
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
    expect(summary.awaitingWorklist).toEqual(['TXN001']);
  });

  it('acks after marking even when the worklist post fails (the sweep retries it)', async () => {
    const { deps, rowStore, mondayClient } = fakeDeps();
    mondayClient.createItem.mockRejectedValue(new Error('monday: HTTP 503'));
    const msg = message({ transactionId: 'TXN001' });

    const summary = await processDeadLetters([msg], deps);

    expect(rowStore.updateStatus).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(summary).toEqual({ marked: ['TXN001'], uploads: [], awaitingWorklist: ['TXN001'] });
  });

  it('re-reports on the item a replayed row already has instead of posting another', async () => {
    const { deps, rowStore, mondayClient } = fakeDeps();
    rowStore.getRow.mockResolvedValue(row({ worklistItemId: '555' }));

    await processDeadLetters([message({ transactionId: 'TXN001' })], deps);

    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(777, '555', { reason_c: deadLetterReason(stamped), retry_c: { label: 'Needs review' } });
    expect(rowStore.updateStatus).toHaveBeenLastCalledWith('TXN001', 'needs-review', { error: stamped, worklistItemId: '555' });
  });

  it('never doubles the prefix', async () => {
    const { deps, rowStore } = fakeDeps({ writesOn: false });
    rowStore.getRow.mockResolvedValue(row({ error: stamped }));

    await processDeadLetters([message({ transactionId: 'TXN001' })], deps);

    expect(rowStore.updateStatus).toHaveBeenCalledWith('TXN001', 'needs-review', { error: stamped });
  });

  it.each(['written', 'needs-review', 'skipped'] as const)('leaves a row that is %s since the message was sent alone', async (status) => {
    const { deps, rowStore, mondayClient } = fakeDeps();
    rowStore.getRow.mockResolvedValue(row({ status }));
    const msg = message({ transactionId: 'TXN001' });

    const summary = await processDeadLetters([msg], deps);

    expect(rowStore.updateStatus).not.toHaveBeenCalled();
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
    expect(summary.marked).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('acks a message whose row no longer exists', async () => {
    const { deps, rowStore } = fakeDeps();
    rowStore.getRow.mockResolvedValue(null);
    const msg = message({ transactionId: 'TXN404' });

    await processDeadLetters([msg], deps);

    expect(rowStore.updateStatus).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
  });

  it('acks a malformed letter on its own without failing the rest of the batch', async () => {
    const { deps, rowStore } = fakeDeps({ writesOn: false });
    const bad = message({});
    const nullBody = message(null);
    const good = message({ transactionId: 'TXN001' });

    const summary = await processDeadLetters([bad, nullBody, good], deps);

    expect(bad.ack).toHaveBeenCalled();
    expect(nullBody.ack).toHaveBeenCalled();
    expect(good.ack).toHaveBeenCalled();
    expect(rowStore.updateStatus).toHaveBeenCalledTimes(1);
    expect(summary.marked).toEqual(['TXN001']);
  });

  it('retries only the message whose D1 mark failed', async () => {
    const { deps, rowStore } = fakeDeps({ writesOn: false });
    rowStore.updateStatus.mockRejectedValueOnce(new Error('D1_ERROR')).mockResolvedValue(undefined);
    rowStore.getRow.mockImplementation(async (id: string) => row({ transactionId: id }));
    const first = message({ transactionId: 'TXN001' });
    const second = message({ transactionId: 'TXN002' });

    const summary = await processDeadLetters([first, second], deps);

    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalled();
    expect(summary.marked).toEqual(['TXN002']);
  });

  it('builds a usable worklist item from a row whose raw_row was purged', async () => {
    const { deps, rowStore, mondayClient } = fakeDeps();
    rowStore.getRow.mockResolvedValue(row({ rawRow: '{}' }));

    await processDeadLetters([message({ transactionId: 'TXN001' })], deps);

    expect(mondayClient.createItem).toHaveBeenCalledWith(
      777,
      'Benevity transaction TXN001',
      expect.objectContaining({ amount_c: 0, date_c: { date: '2026-09-15' }, key_c: 'TXN001' }),
      'review'
    );
  });

  it('never logs the donor email', async () => {
    const { deps } = fakeDeps();
    await processDeadLetters([message({ transactionId: 'TXN001' })], deps);
    for (const call of errorSpy.mock.calls) {
      expect(String(call[0])).not.toContain('jordan@acme.example');
    }
  });
});

describe('sweepDeadLetteredRows', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('posts the missing worklist item for each dead-lettered row, carrying on past a failure', async () => {
    const { deps, rowStore, mondayClient } = fakeDeps();
    rowStore.listDeadLetteredWithoutWorklistItem.mockResolvedValue([
      row({ transactionId: 'TXN001', status: 'needs-review', error: stamped }),
      row({ transactionId: 'TXN002', status: 'needs-review', error: stamped }),
    ]);
    mondayClient.createItem.mockRejectedValueOnce(new Error('monday: HTTP 503')).mockResolvedValue({ id: '902', name: 'x' });

    const result = await sweepDeadLetteredRows(deps);

    expect(rowStore.listDeadLetteredWithoutWorklistItem).toHaveBeenCalledWith(SWEEP_LIMIT);
    expect(result).toEqual({ posted: ['TXN002'], failed: ['TXN001'] });
    expect(rowStore.updateStatus).toHaveBeenCalledTimes(1);
    expect(rowStore.updateStatus).toHaveBeenCalledWith('TXN002', 'needs-review', { error: stamped, worklistItemId: '902' });
  });
});

// #74: the write queue also carries uploaded reports to ingest, and one can die too.
describe('processDeadLetters — upload messages', () => {
  const upload = (assetId: unknown): QueueMessageLike<BenevityQueueMessage> =>
    ({ body: { assetId } as BenevityQueueMessage, ack: vi.fn(), retry: vi.fn() });

  it('marks a dead upload errored and reports the asset, without touching rows or Monday', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps, rowStore, uploadStore, mondayClient } = fakeDeps();
    const message = upload('a1');
    const summary = await processDeadLetters([message], deps);
    expect(uploadStore.markError).toHaveBeenCalledWith(3);
    expect(summary).toEqual({ marked: [], uploads: ['a1'], awaitingWorklist: [] });
    expect(message.ack).toHaveBeenCalled();
    expect(rowStore.getRow).not.toHaveBeenCalled();
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/asset "a1".*upload the same file again/);
    err.mockRestore();
  });

  it('leaves an upload that has since finished as it is', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps, uploadStore } = fakeDeps();
    uploadStore.getUploadByAssetId.mockResolvedValue({ id: 3, mondayAssetId: 'a1', uploadedAt: 't', status: 'parsed', blockCount: 1 });
    await processDeadLetters([upload('a1')], deps);
    expect(uploadStore.markError).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('retries when D1 is down, rather than losing the record', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps, uploadStore } = fakeDeps();
    uploadStore.getUploadByAssetId.mockRejectedValue(new Error('D1 down'));
    const message = upload('a1');
    await processDeadLetters([message], deps);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
