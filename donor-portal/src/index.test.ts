import { env } from 'cloudflare:workers';
import { describe, it, expect, vi } from 'vitest';
import worker, { routeQueueBatch } from './index';
import type { ChangeRequestStore } from './db/changeRequests';
import type { LetterSendStore } from './db/letterSends';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { EmailSender } from './email/types';
import type { ChangeQueueMessage, Config, LetterSendQueueMessage } from './types';

// Full valid test Config shape, same fixture used in routes.test.ts / processBatch.test.ts /
// processLetterSendBatch.test.ts.
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
  eventRegistrations: {
    boardId: null,
    columns: { attendeeLink: 'connect_att', eventLink: 'connect_ev', attended: 'check_att' },
    eventDateColumnId: 'ev_date_col',
  },
};

function makeMessage<T>(body: T) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

function fakeBatch<T>(queue: string, messages: { body: T; ack: () => void; retry: () => void }[]): MessageBatch<T> {
  return {
    messages,
    queue,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  } as unknown as MessageBatch<T>;
}

// getRequest/getById resolve null on both fakes below, which drives processChangeQueueBatch /
// processLetterSendBatch down their "no row for this id" path — cheap to set up and, crucially,
// never reaches deps.monday or deps.emailSender, so no real network call is at risk even though
// routeQueueBatch is exercised for real (not mocked out).
function fakeChangeStore(): ChangeRequestStore {
  return {
    createRequest: vi.fn(),
    hasRecentDuplicate: vi.fn(),
    findRecentByDedupeHash: vi.fn(),
    getRequest: vi.fn().mockResolvedValue(null),
    markWritten: vi.fn(),
    purgeWrittenBefore: vi.fn(),
  };
}

function fakeLetterStore(): LetterSendStore {
  return {
    findByDonorYear: vi.fn(),
    createQueued: vi.fn(),
    getById: vi.fn().mockResolvedValue(null),
    markSent: vi.fn(),
    markSkipped: vi.fn(),
    requeue: vi.fn(),
  };
}

function fakeMonday(): MondayClient {
  return {
    findDonorsByEmail: vi.fn(),
    getDonorPortalData: vi.fn(),
    getDiscountOrganizations: vi.fn(),
    getDonorContactInfo: vi.fn(),
    createChangeRequestItem: vi.fn(),
    getDonorNames: vi.fn().mockResolvedValue([]),
    getEventRegistrationsForDonor: vi.fn().mockResolvedValue([]),
  } as unknown as MondayClient;
}

function fakeTokenStore(): MagicLinkTokenStore {
  return { createToken: vi.fn(), consumeToken: vi.fn() };
}

function fakeEmailSender(): EmailSender {
  return { sendLoginEmail: vi.fn(), sendLetterReadyEmail: vi.fn() };
}

describe('scaffold', () => {
  it('applies the auth tables migration', async () => {
    const tokens = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='magic_link_tokens'"
    ).first();
    const sessions = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).first();
    const attempts = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='login_attempts'"
    ).first();
    expect(tokens).not.toBeNull();
    expect(sessions).not.toBeNull();
    expect(attempts).not.toBeNull();
  });
});

describe('worker entry point', () => {
  it('exposes fetch, queue, and scheduled handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.queue).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });
});

// index.ts's queue() is a thin wrapper — build real deps from env, then delegate to
// routeQueueBatch. It can't be exercised end-to-end here: it always runs validateConfig against
// the real config/svbc.json, which ships with placeholder Monday column ids until an operator
// fills them in (see config.ts) and would throw before any routing logic ran. routeQueueBatch is
// exported specifically so the routing decision itself — which of the two source queues,
// distinguished by batch.queue, hands off to which processor — is directly testable with faked
// deps instead.
describe('routeQueueBatch', () => {
  it('routes a donor-portal-change-requests batch to the change-request store, not the letter-send store', async () => {
    const changeStore = fakeChangeStore();
    const letterStore = fakeLetterStore();
    const message = makeMessage<ChangeQueueMessage>({ requestId: 1 });
    const batch = fakeBatch<ChangeQueueMessage>('donor-portal-change-requests', [message]);

    await routeQueueBatch(batch, {
      changeStore,
      letterStore,
      monday: fakeMonday(),
      tokenStore: fakeTokenStore(),
      emailSender: fakeEmailSender(),
      config,
      now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(changeStore.getRequest).toHaveBeenCalledWith(1);
    expect(letterStore.getById).not.toHaveBeenCalled();
    // No row for id 1 (fakeChangeStore resolves null) — processChangeQueueBatch treats a missing
    // row as a bug worth surfacing via retry, not a silent ack. Confirms the real processor ran,
    // not a no-op.
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('routes a donor-portal-letter-emails batch to the letter-send store, not the change-request store', async () => {
    const changeStore = fakeChangeStore();
    const letterStore = fakeLetterStore();
    const message = makeMessage<LetterSendQueueMessage>({ sendId: 1 });
    const batch = fakeBatch<LetterSendQueueMessage>('donor-portal-letter-emails', [message]);

    await routeQueueBatch(batch, {
      changeStore,
      letterStore,
      monday: fakeMonday(),
      tokenStore: fakeTokenStore(),
      emailSender: fakeEmailSender(),
      config,
      now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(letterStore.getById).toHaveBeenCalledWith(1);
    expect(changeStore.getRequest).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('throws for an unrecognized queue name, invoking neither store', async () => {
    const changeStore = fakeChangeStore();
    const letterStore = fakeLetterStore();
    const batch = fakeBatch<ChangeQueueMessage>('not-a-real-queue', []);

    await expect(
      routeQueueBatch(batch, {
        changeStore,
        letterStore,
        monday: fakeMonday(),
        tokenStore: fakeTokenStore(),
        emailSender: fakeEmailSender(),
        config,
        now: () => new Date('2026-08-24T10:00:00.000Z'),
      })
    ).rejects.toThrow('unrecognized queue "not-a-real-queue"');
    expect(changeStore.getRequest).not.toHaveBeenCalled();
    expect(letterStore.getById).not.toHaveBeenCalled();
  });
});
