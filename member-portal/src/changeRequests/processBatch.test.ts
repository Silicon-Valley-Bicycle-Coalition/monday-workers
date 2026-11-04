import { describe, it, expect, vi } from 'vitest';
import { consumeChangeQueueBatch, processChangeQueueBatch } from './processBatch';
import type { WriteMode, WriteStamp } from '../flags';
import { MEMBER_PORTAL_PII_KEYS, type BatchSkipContext } from '../writeSwitch';
import type { ChangeRequestStore, ChangeRequestRow } from '../db/changeRequests';
import { AmbiguousWriteError, type MondayClient } from '../monday/client';
import type { Config } from '../types';

const row: ChangeRequestRow = {
  id: 42,
  donorItemId: 'donor-1',
  donorName: 'Jane Example',
  field: 'address',
  oldValue: '1 Old St',
  newValue: '2 New Ave',
  status: 'queued',
  createdAt: '2026-08-24T09:00:00.000Z',
};

// Full valid test Config shape, copied from the Task 1 fixture in routes.test.ts — only
// changeRequests matters here.
const config: Config = {
  monday: { apiUrl: 'x', donorsBoardId: 1, donationsBoardId: 2, organizationsBoardId: 3, volunteersBoardId: null, columns: {} as never },
  email: { fromAddress: 'a@example.org', fromName: 'Test', logoUrl: 'https://example.org/email/logo.png' },
  auth: { magicLinkTtlMinutes: 15, letterLinkTtlHours: 168, sessionTtlHours: 24, portalBaseUrl: 'https://portal.example.org' },
  rateLimit: { emailCooldownSeconds: 60, emailWindowSeconds: 900, emailMaxAttempts: 5, emailDailyMax: 10, attemptRetentionHours: 24 },
  taxLetter: {
    orgLegalName: 'SVBC',
    ein: '00-0000000',
    officeAddress: 'addr',
    signatureName: 'Alex',
    signatureTitle: 'ED',
    plainStatement: 'plain',
    benefitStatement: 'benefit',
    benefitTiers: ['Champion'],
    excludedGiftTypes: [],
    separateGiftTypes: [],
    separateGiftsStatement: 'SEPARATE-STATEMENT',
  },
  changeRequests: {
    boardId: 99,
    columns: { donorLink: 'c1', field: 'c2', oldValue: 'c3', newValue: 'c4', submittedAt: 'c5' },
    dedupeWindowHours: 72,
    retentionDays: 180,
  },
  cardTokens: { retentionDays: 30 },
  volunteerHistory: { completedStatuses: ['Completed'] },
  donations: { countableStatuses: ['Received', 'Received (Historical)'], historyStartISO: null, historyVisibleFromISO: null },
  eventRegistrations: {
    boardId: null,
    columns: { attendeeLink: 'connect_att', eventLink: 'connect_ev', attended: 'check_att' },
    eventDateColumnId: 'ev_date_col',
  },
  funraise: {
    manageRecurringUrl: 'https://example.funraise.org/account',
    renewMembershipUrl: 'https://example.funraise.org/give?campaign=membership',
  },
  getInvolved: { links: [] },
  pledges: {
    boardId: null,
    columns: {
      donorLink: 'REPLACE_WITH_COLUMN_ID',
      pledgedAmount: 'REPLACE_WITH_COLUMN_ID',
      fulfilledAmount: 'REPLACE_WITH_COLUMN_ID',
      status: 'REPLACE_WITH_COLUMN_ID',
      dueDate: 'REPLACE_WITH_COLUMN_ID',
    },
  },
  matchingGifts: { doubleTheDonationPublicKey: null },
  impact: { statementsByYear: {} },
  letterCron: {
    boardId: null,
    columns: { autoSend: 'checkbox_1', startDate: 'date_2', bodyTemplate: 'long_text_1', bodyTemplatesByLocale: {} },
    settingsItemName: 'Letter emails',
    maxTriggersPerRun: 200,
  },
};

function makeMessage(requestId: number, attempts = 1) {
  return { body: { requestId }, attempts, ack: vi.fn(), retry: vi.fn() };
}

function fakeStore(getResult: ChangeRequestRow | null): ChangeRequestStore {
  return {
    createRequest: vi.fn(),
    hasRecentDuplicate: vi.fn(),
    findRecentByDedupeHash: vi.fn(),
    getRequest: vi.fn().mockResolvedValue(getResult),
    markWritten: vi.fn().mockResolvedValue(undefined),
    purgeWrittenBefore: vi.fn().mockResolvedValue(0),
  };
}

function fakeMonday(): MondayClient {
  return {
    findChangeRequestItem: vi.fn().mockResolvedValue(null),
    createChangeRequestItem: vi.fn().mockResolvedValue(undefined),
  } as unknown as MondayClient;
}

describe('processChangeQueueBatch', () => {
  it('creates the Monday item, marks written, and acks', async () => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    const message = makeMessage(42);

    await processChangeQueueBatch([message], { store, monday, config });

    expect(monday.createChangeRequestItem).toHaveBeenCalledWith(
      expect.objectContaining({
        boardId: config.changeRequests.boardId,
        itemName: 'Address change — Jane Example (#42)',
        donorItemId: 'donor-1',
        fieldLabel: 'Address',
        oldValue: '1 Old St',
        newValue: '2 New Ave',
        // Finding 2: the consumer must stamp the row's original submission time, not the
        // time the consumer happens to process it — otherwise a retry or DLQ replay hours
        // later would report the wrong submittedAt.
        submittedAtISO: row.createdAt,
      })
    );
    expect(store.markWritten).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('acks an already-written row without a second Monday write (redelivery idempotency)', async () => {
    const store = fakeStore({ ...row, status: 'written' });
    const monday = fakeMonday();
    const message = makeMessage(42);

    await processChangeQueueBatch([message], { store, monday, config });

    expect(monday.createChangeRequestItem).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it('looks the item up by its request-id-stamped name before creating it', async () => {
    const monday = fakeMonday();

    await processChangeQueueBatch([makeMessage(42)], { store: fakeStore(row), monday, config });

    expect(monday.findChangeRequestItem).toHaveBeenCalledWith({
      boardId: config.changeRequests.boardId,
      itemName: 'Address change — Jane Example (#42)',
    });
    expect(monday.createChangeRequestItem).toHaveBeenCalledTimes(1);
  });

  // #35 follow-up: a create that failed ambiguously (5xx/timeout after Monday committed it) left
  // the row unwritten, and the queue retry created a second item. The retry must adopt the first.
  it('adopts an item an earlier ambiguous create already committed, without creating a duplicate', async () => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    (monday.findChangeRequestItem as ReturnType<typeof vi.fn>).mockResolvedValue('item-777');
    const message = makeMessage(42, 2);

    await processChangeQueueBatch([message], { store, monday, config });

    expect(monday.createChangeRequestItem).not.toHaveBeenCalled();
    expect(store.markWritten).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('end to end: an AmbiguousWriteError then a retry leaves exactly one item', async () => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    const board: string[] = [];
    (monday.findChangeRequestItem as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ itemName }: { itemName: string }) => (board.includes(itemName) ? 'item-1' : null)
    );
    (monday.createChangeRequestItem as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async ({ itemName }: { itemName: string }) => {
        board.push(itemName); // Monday committed the create...
        throw new AmbiguousWriteError('monday API: HTTP 502: bad gateway'); // ...but the response was lost
      }
    );

    const first = makeMessage(42, 1);
    await processChangeQueueBatch([first], { store, monday, config });
    expect(first.retry).toHaveBeenCalled();
    expect(store.markWritten).not.toHaveBeenCalled();

    const retry = makeMessage(42, 2);
    await processChangeQueueBatch([retry], { store, monday, config });

    expect(monday.createChangeRequestItem).toHaveBeenCalledTimes(1);
    expect(board).toHaveLength(1);
    expect(store.markWritten).toHaveBeenCalledWith(42, expect.any(String));
    expect(retry.ack).toHaveBeenCalled();
  });

  it('retries without creating when the lookup itself fails', async () => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    (monday.findChangeRequestItem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));
    const message = makeMessage(42);

    await processChangeQueueBatch([message], { store, monday, config });

    expect(monday.createChangeRequestItem).not.toHaveBeenCalled();
    expect(store.markWritten).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
  });

  it('retries on a Monday failure without marking written', async () => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    (monday.createChangeRequestItem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));
    const message = makeMessage(42);

    await processChangeQueueBatch([message], { store, monday, config });

    expect(store.markWritten).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  // Issue #31: an immediate retry during a Monday rate-limit window (60s) burns every attempt
  // inside the same window and lands a January backlog in the DLQ. Back off exponentially.
  // The shared write-switch backoff (src/flags.ts): 1, 2, 4 … minutes, capped at an hour, so 100
  // retries cover a multi-day outage.
  it.each([
    [1, 60],
    [2, 120],
    [3, 240],
    [8, 3600],
  ])('backs off exponentially on attempt %i (delaySeconds %i)', async (attempts, delaySeconds) => {
    const monday = fakeMonday();
    (monday.createChangeRequestItem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 429'));
    const message = makeMessage(42, attempts);

    await processChangeQueueBatch([message], { store: fakeStore(row), monday, config });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds });
  });

  it('retries when the row is missing (DLQ makes it visible)', async () => {
    const message = makeMessage(999);
    await processChangeQueueBatch([message], { store: fakeStore(null), monday: fakeMonday(), config });
    expect(message.retry).toHaveBeenCalled();
  });
});

describe('consumeChangeQueueBatch (write switch)', () => {
  const gate = (mode: WriteMode): BatchSkipContext => ({ worker: 'member-portal', environment: 'production', mode, logLevel: 'normal', piiKeys: [] });

  function stamped(requestId: number, stamp: WriteStamp, attempts = 1) {
    return { body: { requestId, ...stamp }, attempts, ack: vi.fn(), retry: vi.fn() };
  }

  it('under off records the Monday create as a skip line, writes nothing and acks', async () => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    const message = makeMessage(42);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await consumeChangeQueueBatch([message], { store, monday, config }, gate('off'));

    expect(monday.createChangeRequestItem).not.toHaveBeenCalled();
    expect(store.markWritten).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    const skips = log.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((line) => line.writeSwitch === 'skipped');
    expect(skips).toEqual([expect.objectContaining({ sink: 'Monday', operation: 'createChangeRequestItem', deliveryId: 'change-request:42' })]);
    log.mockRestore();
  });

  it('under off with debug logging masks the donor PII in the skip payload', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await consumeChangeQueueBatch([makeMessage(42)], { store: fakeStore(row), monday: fakeMonday(), config }, { ...gate('off'), logLevel: 'debug', piiKeys: MEMBER_PORTAL_PII_KEYS });

    const text = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('createChangeRequestItem');
    expect(text).not.toContain('Jane Example');
    expect(text).not.toContain('1 Old St');
    expect(text).not.toContain('2 New Ave');
    log.mockRestore();
  });

  it.each<WriteMode>(['hold', 'unknown'])('under %s retries at 60 s without reading the row', async (mode) => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    const message = makeMessage(42);

    await consumeChangeQueueBatch([message], { store, monday, config }, gate(mode));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(store.getRequest).not.toHaveBeenCalled();
    expect(monday.createChangeRequestItem).not.toHaveBeenCalled();
  });

  it('writes an unstamped (pre-deploy) message under on', async () => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    const message = makeMessage(42);

    await consumeChangeQueueBatch([message], { store, monday, config }, gate('on'));

    expect(monday.createChangeRequestItem).toHaveBeenCalledOnce();
    expect(store.markWritten).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
  });

  it('dry-runs a message stamped dropped even under on', async () => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    const message = stamped(42, { writeStamp: 'dropped' });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await consumeChangeQueueBatch([message], { store, monday, config }, gate('on'));

    expect(monday.createChangeRequestItem).not.toHaveBeenCalled();
    expect(store.markWritten).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
