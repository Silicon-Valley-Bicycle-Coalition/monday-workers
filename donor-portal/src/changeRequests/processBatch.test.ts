import { describe, it, expect, vi } from 'vitest';
import { processChangeQueueBatch } from './processBatch';
import type { ChangeRequestStore, ChangeRequestRow } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';
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
  monday: { apiUrl: 'x', donorsBoardId: 1, donationsBoardId: 2, organizationsBoardId: 3, columns: {} as never },
  email: { fromAddress: 'a@example.org', fromName: 'Test' },
  auth: { magicLinkTtlMinutes: 15, sessionTtlHours: 24, portalBaseUrl: 'https://portal.example.org' },
  rateLimit: { emailWindowSeconds: 900, emailMaxAttempts: 5 },
  taxLetter: {
    orgLegalName: 'SVBC',
    ein: '00-0000000',
    orgAddress: 'addr',
    signatureName: 'Alex',
    signatureTitle: 'ED',
    plainStatement: 'plain',
    benefitStatement: 'benefit',
    benefitTiers: ['Champion'],
  },
  changeRequests: {
    boardId: 99,
    columns: { donorLink: 'c1', field: 'c2', oldValue: 'c3', newValue: 'c4', submittedAt: 'c5' },
    dedupeWindowHours: 72,
    retentionDays: 180,
  },
  cardTokens: { retentionDays: 30 },
  funraise: {
    manageRecurringUrl: 'https://example.funraise.org/account',
    renewMembershipUrl: 'https://example.funraise.org/give?campaign=membership',
  },
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
};

function makeMessage(requestId: number) {
  return { body: { requestId }, ack: vi.fn(), retry: vi.fn() };
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
  return { createChangeRequestItem: vi.fn().mockResolvedValue(undefined) } as unknown as MondayClient;
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
        itemName: 'Address change — Jane Example',
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

  it('retries when the row is missing (DLQ makes it visible)', async () => {
    const message = makeMessage(999);
    await processChangeQueueBatch([message], { store: fakeStore(null), monday: fakeMonday(), config });
    expect(message.retry).toHaveBeenCalled();
  });
});
