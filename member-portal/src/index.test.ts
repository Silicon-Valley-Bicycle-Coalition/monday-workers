import { env } from 'cloudflare:workers';
import { describe, it, expect, vi } from 'vitest';
import worker, { routeQueueBatch, emailBindingFor } from './index';
import { parseJsonc } from '../test/jsonc';
import wranglerText from '../wrangler.jsonc?raw';
import { HttpMondayClient } from './monday/client';
import { tokenProviderFor } from './monday/graphql';
import type { LetterSendStore } from './db/letterSends';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { EmailSender } from './email/types';
import type { ChangeQueueMessage, Config, Env, LetterSendQueueMessage } from './types';
import type { WriteMode } from './flags';
import type { BatchSkipContext } from './writeSwitch';

const gate = (mode: WriteMode): BatchSkipContext => ({ worker: 'member-portal', environment: 'production', mode, logLevel: 'normal', piiKeys: [] });

// Full valid test Config shape, same fixture used in routes.test.ts / processBatch.test.ts /
// processLetterSendBatch.test.ts.
const config: Config = {
  monday: { apiUrl: 'x', donorsBoardId: 1, donationsBoardId: 2, organizationsBoardId: 3, volunteersBoardId: null, columns: {} as never },
  email: { fromAddress: 'a@example.org', fromName: 'Test', logoUrl: 'https://example.org/email/logo.png' },
  auth: { magicLinkTtlMinutes: 15, letterLinkTtlHours: 168, sessionTtlHours: 24, portalBaseUrl: 'https://portal.example.org' },
  rateLimit: { emailCooldownSeconds: 60, emailWindowSeconds: 900, emailMaxAttempts: 5, emailDailyMax: 10, codeFailuresPerAddressDaily: 10, attemptRetentionHours: 24 },
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
  home: { newMemberDays: 60, renewalWarningDays: 30, taxLetterUntil: '04-15' },
  letterCron: {
    boardId: null,
    columns: { autoSend: 'checkbox_1', startDate: 'date_2', bodyTemplate: 'long_text_1', bodyTemplatesByLocale: {} },
    settingsItemName: 'Letter emails',
    maxTriggersPerRun: 200,
  },
};

function makeMessage<T>(body: T) {
  return { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
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

// getById resolves null, which drives processLetterSendBatch down its "no row for this id" path —
// cheap to set up and never reaches deps.monday or deps.emailSender, so no real network call is
// at risk even though routeQueueBatch is exercised for real (not mocked out).
function fakeLetterStore(): LetterSendStore {
  return {
    findByDonorYear: vi.fn(),
    createQueued: vi.fn(),
    getById: vi.fn().mockResolvedValue(null),
    markSent: vi.fn(),
    markSkipped: vi.fn(),
    requeue: vi.fn(),
    listDonorItemIdsForYear: vi.fn().mockResolvedValue(new Set()),
    claimForSending: vi.fn().mockResolvedValue(true),
    releaseClaim: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeMonday(): MondayClient {
  return {
    findDonorsByEmail: vi.fn(),
    getMemberPortalData: vi.fn(),
    getDiscountOrganizations: vi.fn(),
    getDonorContactInfo: vi.fn(),
    findChangeRequestItem: vi.fn().mockResolvedValue(null),
    createChangeRequestItem: vi.fn(),
    getDonorNames: vi.fn().mockResolvedValue([]),
    getEventRegistrationsForDonor: vi.fn().mockResolvedValue([]),
  } as unknown as MondayClient;
}

function fakeTokenStore(): MagicLinkTokenStore {
  return { createToken: vi.fn(), consumeToken: vi.fn(), takeCodeAttempt: vi.fn(), claimByRequest: vi.fn() };
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
// exported specifically so the routing decision itself is directly testable with faked deps.
// The portal consumes only the letter-emails queue; change requests belong to
// member-portal-writer (src/writer.ts, tested in writer.test.ts).
describe('routeQueueBatch', () => {
  const deps = (mode: WriteMode = 'on') => ({
    letterStore: fakeLetterStore(),
    monday: fakeMonday(),
    tokenStore: fakeTokenStore(),
    emailSender: fakeEmailSender(),
    config,
    now: () => new Date('2026-08-24T10:00:00.000Z'),
    gate: gate(mode),
  });

  it('routes a member-portal-letter-emails batch to the letter-send store', async () => {
    const d = deps();
    const message = makeMessage<LetterSendQueueMessage>({ sendId: 1 });

    await routeQueueBatch(fakeBatch<LetterSendQueueMessage>('member-portal-letter-emails', [message]), d);

    expect(d.letterStore.getById).toHaveBeenCalledWith(1);
    // No row for id 1 (fakeLetterStore resolves null) — surfaced via retry, not a silent ack.
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('throws for an unrecognized queue name, invoking no store', async () => {
    const d = deps();
    await expect(routeQueueBatch(fakeBatch<LetterSendQueueMessage>('not-a-real-queue', []), d)).rejects.toThrow(
      'unrecognized queue "not-a-real-queue"'
    );
    expect(d.letterStore.getById).not.toHaveBeenCalled();
  });

  it.each(['member-portal-change-requests', 'member-portal-change-requests-sandbox'])(
    'refuses a %s batch: the portal no longer consumes change requests',
    async (queue) => {
      const d = deps();
      const message = makeMessage<ChangeQueueMessage>({ requestId: 1 });
      await expect(
        routeQueueBatch(fakeBatch<ChangeQueueMessage>(queue, [message]) as unknown as MessageBatch<LetterSendQueueMessage>, d)
      ).rejects.toThrow(`unrecognized queue "${queue}"`);
      expect(message.ack).not.toHaveBeenCalled();
      expect(d.monday.createChangeRequestItem).not.toHaveBeenCalled();
    }
  );

  it('routes the sandbox-suffixed letter-emails queue to the letter-send store', async () => {
    const d = deps();
    const message = makeMessage<LetterSendQueueMessage>({ sendId: 7 });

    await routeQueueBatch(fakeBatch<LetterSendQueueMessage>('member-portal-letter-emails-sandbox', [message]), d);

    expect(d.letterStore.getById).toHaveBeenCalledWith(7);
  });

  it('still rejects a dead-letter queue name, sandbox or not', async () => {
    await expect(
      routeQueueBatch(fakeBatch<LetterSendQueueMessage>('member-portal-letter-emails-sandbox-dlq', []), deps())
    ).rejects.toThrow('unrecognized queue "member-portal-letter-emails-sandbox-dlq"');
  });
});

describe('routeQueueBatch (write switch)', () => {
  it('holds a letter-emails batch: retry at 60 s, no store read', async () => {
    const letterStore = fakeLetterStore();
    const message = makeMessage({ sendId: 1 });

    await routeQueueBatch(fakeBatch('member-portal-letter-emails', [message]) as MessageBatch<LetterSendQueueMessage>, {
      letterStore,
      monday: fakeMonday(),
      tokenStore: fakeTokenStore(),
      emailSender: fakeEmailSender(),
      config,
      now: () => new Date('2026-08-24T10:00:00.000Z'),
      gate: gate('hold'),
    });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(letterStore.getById).not.toHaveBeenCalled();
  });
});

describe('the portal never calls a Monday mutation', () => {
  type Services = { binding: string; entrypoint: string }[];
  const wrangler = parseJsonc(wranglerText) as {
    queues: { consumers: { queue: string }[] };
    services: Services;
    env: { sandbox: { queues: { consumers: { queue: string }[] }; services: Services } };
  };

  it('has no change-requests consumer in either environment', () => {
    for (const consumers of [wrangler.queues.consumers, wrangler.env.sandbox.queues.consumers]) {
      expect(consumers.map((c) => c.queue).filter((q) => q.startsWith('member-portal-change-requests'))).toEqual([]);
    }
  });

  it('binds the broker read-only (PortalToken) in both environments', () => {
    expect(wrangler.services).toEqual([expect.objectContaining({ binding: 'MONDAY_AUTH', entrypoint: 'PortalToken' })]);
    expect(wrangler.env.sandbox.services).toEqual([expect.objectContaining({ binding: 'MONDAY_AUTH', entrypoint: 'PortalToken' })]);
  });

  it('builds its Monday client from the MONDAY_AUTH binding when bound', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { items_page_by_column_values: { items: [] } } }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const auth = { token: vi.fn().mockResolvedValue('brokered') };
      // queue() and fetch() both run validateConfig against the placeholder production config, so
      // drive the client the way they build it: tokenProviderFor(env) as the token argument.
      const client = new HttpMondayClient('https://api.monday.test/v2', tokenProviderFor({ MONDAY_AUTH: auth }), {} as never, 1, 2, 3, config.donations);
      await client.findChangeRequestItem({ boardId: 1, itemName: 'x' });
      expect(auth.token).toHaveBeenCalled();
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe('brokered');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('emailBindingFor', () => {
  const inner = { send: vi.fn().mockResolvedValue({ messageId: 'id' }) } as unknown as SendEmail;

  it('returns the raw EMAIL binding in production', () => {
    const env = { EMAIL: inner } as unknown as Env;
    expect(emailBindingFor(env)).toBe(inner);
  });

  it('returns a rewriting wrapper in the sandbox', async () => {
    const env = { EMAIL: inner, ENVIRONMENT: 'sandbox', SANDBOX_EMAIL_SINK: 'sandbox@example.org' } as unknown as Env;
    const binding = emailBindingFor(env);
    expect(binding).not.toBe(inner);

    await binding.send({ to: 'donor@example.org', from: 'login@example.org', subject: 'Hi', text: 'x' });
    const sent = (inner.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as EmailMessageBuilder;
    expect(sent.to).toBe('sandbox@example.org');
  });

  it('throws in the sandbox when SANDBOX_EMAIL_SINK is missing rather than sending unwrapped', () => {
    const env = { EMAIL: inner, ENVIRONMENT: 'sandbox' } as unknown as Env;
    expect(() => emailBindingFor(env)).toThrow('SANDBOX_EMAIL_SINK');
  });
});
