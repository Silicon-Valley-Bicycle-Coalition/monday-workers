import { describe, it, expect, vi } from 'vitest';
import { consumeLetterSendBatch, processLetterSendBatch } from './processLetterSendBatch';
import type { WriteMode } from '../flags';
import { MEMBER_PORTAL_PII_KEYS, type BatchSkipContext } from '../writeSwitch';
import type { LetterSendStore, LetterSendRow } from '../db/letterSends';
import type { MondayClient } from '../monday/client';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/types';
import type { Config } from '../types';

const row: LetterSendRow = {
  id: 42,
  donorItemId: 'donor-1',
  year: 2025,
  status: 'queued',
  createdAt: '2026-08-24T09:00:00.000Z',
  sentAt: null,
};

const config: Config = {
  monday: { apiUrl: 'x', donorsBoardId: 1, donationsBoardId: 2, organizationsBoardId: 3, volunteersBoardId: null, columns: {} as never },
  email: { fromAddress: 'a@example.org', fromName: 'Test', logoUrl: 'https://example.org/email/logo.png' },
  auth: {
    magicLinkTtlMinutes: 15,
    letterLinkTtlHours: 168,
    sessionTtlHours: 24,
    portalBaseUrl: 'https://portal.example.org',
    loginCodeEnabled: false,
    displayTimeZone: 'America/Los_Angeles',
  },
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

const configWithLetterCron: Config = {
  ...config,
  letterCron: { ...config.letterCron, boardId: 456 },
};

function makeMessage(sendId: number, attempts = 1) {
  return { body: { sendId }, attempts, ack: vi.fn(), retry: vi.fn() };
}

function fakeStore(getResult: LetterSendRow | null): LetterSendStore {
  return {
    findByDonorYear: vi.fn(),
    createQueued: vi.fn(),
    getById: vi.fn().mockResolvedValue(getResult),
    markSent: vi.fn().mockResolvedValue(undefined),
    markSkipped: vi.fn().mockResolvedValue(undefined),
    requeue: vi.fn().mockResolvedValue(undefined),
    listDonorItemIdsForYear: vi.fn().mockResolvedValue(new Set()),
    claimForSending: vi.fn().mockResolvedValue(true),
    releaseClaim: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeMonday(): MondayClient {
  return {
    getMemberPortalData: vi.fn().mockResolvedValue({
      id: 'donor-1',
      name: 'Jane Example',
      membershipStatus: 'Active',
      membershipTier: 'Champion',
      totalDonated: '$50.00',
      donations: [{ date: '2025-03-01', amount: '$50.00', description: 'Gift' }],
    }),
    getDonorContactInfo: vi.fn().mockResolvedValue({
      id: 'donor-1', name: 'Jane Example', email: 'jane@example.org', address: '1 Old St', phone: '555-0100',
    }),
    getLetterSettings: vi.fn().mockResolvedValue(null),
  } as unknown as MondayClient;
}

function fakeTokenStore(): MagicLinkTokenStore {
  return { createToken: vi.fn().mockResolvedValue(undefined), consumeToken: vi.fn() };
}

function fakeEmailSender(): EmailSender {
  return { sendLoginEmail: vi.fn(), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
}

describe('processLetterSendBatch', () => {
  it('sends the email, marks sent, and acks', async () => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);

    await processLetterSendBatch([message], { store, monday, tokenStore, emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z') });

    expect(tokenStore.createToken).toHaveBeenCalledWith(
      expect.objectContaining({ donorItemIds: ['donor-1'] })
    );
    expect(emailSender.sendLetterReadyEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'jane@example.org', donorName: 'Jane Example', year: 2025 })
    );
    const sentEmailUrl = (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0]!.loginUrl;
    expect(sentEmailUrl).toMatch(/^https:\/\/portal\.example\.org\/auth\/callback\?lang=[a-zA-Z-]+#token=[0-9a-f]{64}$/);
    expect(store.markSent).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  // Issue GL#127: the letter email invites the donor to add their employer, but only when the
  // portal's Employer field is actually live.
  it('passes the locale-prefixed Employer field URL when employer answers are enabled', async () => {
    const emailSender = fakeEmailSender();
    const employerConfig: Config = {
      ...config,
      changeRequests: {
        ...config.changeRequests,
        employer: {
          affiliationsBoardId: 555,
          affiliationColumns: { personLink: 'connect_p', organizationLink: 'connect_o', status: 'status_a', primary: 'check_p' },
          currentStatusLabel: 'Current',
          personAffiliationsLink: 'connect_pa',
        },
      },
      monday: { ...config.monday, columns: { donorEmployer: 'text_employer' } as never },
    };
    await processLetterSendBatch([makeMessage(42)], {
      store: fakeStore(row), monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config: employerConfig, now: () => new Date('2026-08-24T10:00:00.000Z'),
    });
    const params = (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0]!;
    expect(params.employerUrl).toBe(`https://portal.example.org/${params.locale}/portal/change-request?field=employer`);
  });

  it('passes no employer URL while employer answers are off', async () => {
    const emailSender = fakeEmailSender();
    await processLetterSendBatch([makeMessage(42)], {
      store: fakeStore(row), monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z'),
    });
    expect((emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0]!.employerUrl).toBeUndefined();
  });

  // Issue GL#31: the letter email sits in an inbox until the donor gets to it — the login link
  // must outlive the 15-minute interactive magic-link TTL, using its own letterLinkTtlHours.
  it('mints the letter link token with auth.letterLinkTtlHours, not the magic-link minutes', async () => {
    const tokenStore = fakeTokenStore();
    await processLetterSendBatch([makeMessage(42)], {
      store: fakeStore(row),
      monday: fakeMonday(),
      tokenStore,
      emailSender: fakeEmailSender(),
      config: { ...config, auth: { ...config.auth, letterLinkTtlHours: 72 } },
      now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(tokenStore.createToken).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: '2026-08-27T10:00:00.000Z' }));
  });

  // Issue GL#31: same backoff as the change-request consumer — see queueRetry.ts.
  it('retries a failed send with exponential backoff', async () => {
    const emailSender = fakeEmailSender();
    (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('send failed'));
    const message = makeMessage(42, 2);

    await processLetterSendBatch([message], {
      store: fakeStore(row),
      monday: fakeMonday(),
      tokenStore: fakeTokenStore(),
      emailSender,
      config,
      now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  // Issue GL#31: the send and the markSent are two systems; if markSent failed after a successful
  // send, the retry used to see 'queued' and email the donor again.
  it('claims the row before sending the email', async () => {
    const store = fakeStore(row);
    const emailSender = fakeEmailSender();
    await processLetterSendBatch([makeMessage(42)], {
      store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(store.claimForSending).toHaveBeenCalledWith(42, '2026-08-24T10:00:00.000Z');
    const claimOrder = (store.claimForSending as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const sendOrder = (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(sendOrder);
  });

  it('acks without retrying when markSent fails after a successful send (no duplicate email)', async () => {
    const store = fakeStore(row);
    (store.markSent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('D1 write failed'));
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await processLetterSendBatch([message], {
      store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(emailSender.sendLetterReadyEmail).toHaveBeenCalledTimes(1);
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('never re-sends a row already claimed by an earlier attempt', async () => {
    const store = fakeStore({ ...row, status: 'sending' });
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await processLetterSendBatch([message], {
      store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(emailSender.sendLetterReadyEmail).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('skips the send when another consumer won the claim', async () => {
    const store = fakeStore(row);
    (store.claimForSending as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);

    await processLetterSendBatch([message], {
      store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(emailSender.sendLetterReadyEmail).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it('releases the claim and retries when the send itself fails', async () => {
    const store = fakeStore(row);
    const emailSender = fakeEmailSender();
    (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('E_DELIVERY_FAILED'));
    const message = makeMessage(42);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await processLetterSendBatch([message], {
      store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(store.releaseClaim).toHaveBeenCalledWith(42);
    expect(store.markSent).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // Review of GL#31: a D1 failure minting the token after the claim left the row 'sending' with no
  // email sent — and 'sending' is never resent, so it was stranded for good. The token is now
  // minted before the claim, so its failure retries a still-'queued' row.
  it('mints the token before claiming, so a token-store failure leaves the row unclaimed', async () => {
    const store = fakeStore(row);
    const tokenStore = fakeTokenStore();
    (tokenStore.createToken as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('D1 insert failed'));
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await processLetterSendBatch([message], {
      store, monday: fakeMonday(), tokenStore, emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(store.claimForSending).not.toHaveBeenCalled();
    expect(emailSender.sendLetterReadyEmail).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('still surfaces the send error (and retries) when releasing the claim also fails', async () => {
    const store = fakeStore(row);
    (store.releaseClaim as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('D1 update failed'));
    const emailSender = fakeEmailSender();
    (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('E_DELIVERY_FAILED'));
    const message = makeMessage(42);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await processLetterSendBatch([message], {
      store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(message.retry).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('D1 update failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('E_DELIVERY_FAILED'));
    errorSpy.mockRestore();
  });

  it('acks an already-sent row without re-sending (redelivery idempotency)', async () => {
    const store = fakeStore({ ...row, status: 'sent' });
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);

    await processLetterSendBatch([message], { store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date() });

    expect(emailSender.sendLetterReadyEmail).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it('marks skipped and acks when taxLetter is not signed off', async () => {
    const unsignedConfig: Config = { ...config, taxLetter: { ...config.taxLetter, ein: 'REPLACE_AFTER_SIGNOFF' } };
    const store = fakeStore(row);
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);

    await processLetterSendBatch([message], { store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config: unsignedConfig, now: () => new Date('2026-08-24T10:00:00.000Z') });

    expect(emailSender.sendLetterReadyEmail).not.toHaveBeenCalled();
    expect(store.markSkipped).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
  });

  it('marks skipped and acks when the donor has no gifts in that year after all', async () => {
    const monday = { ...fakeMonday(), getMemberPortalData: vi.fn().mockResolvedValue({
      id: 'donor-1', name: 'Jane Example', membershipStatus: 'Active', membershipTier: 'Champion', totalDonated: '$0.00', donations: [],
    }) } as unknown as MondayClient;
    const store = fakeStore(row);
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);

    await processLetterSendBatch([message], { store, monday, tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z') });

    expect(emailSender.sendLetterReadyEmail).not.toHaveBeenCalled();
    expect(store.markSkipped).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
  });

  it('marks skipped and acks when the donor has no email on file, without attempting a send', async () => {
    const monday = { ...fakeMonday(), getDonorContactInfo: vi.fn().mockResolvedValue({
      id: 'donor-1', name: 'Jane Example', email: '', address: '1 Old St', phone: '555-0100',
    }) } as unknown as MondayClient;
    const store = fakeStore(row);
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);

    await processLetterSendBatch([message], { store, monday, tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z') });

    expect(emailSender.sendLetterReadyEmail).not.toHaveBeenCalled();
    expect(store.markSkipped).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries when the row is missing (DLQ makes it visible)', async () => {
    const message = makeMessage(999);
    await processLetterSendBatch([message], { store: fakeStore(null), monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender: fakeEmailSender(), config, now: () => new Date() });
    expect(message.retry).toHaveBeenCalled();
  });

  it('retries on an email-send failure without marking sent', async () => {
    const store = fakeStore(row);
    const emailSender = fakeEmailSender();
    (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cloudflare email: send failed'));
    const message = makeMessage(42);

    await processLetterSendBatch([message], { store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z') });

    expect(store.markSent).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('fetches the Letter Settings template once per batch and passes it to the email sender', async () => {
    const monday = fakeMonday();
    (monday.getLetterSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      autoSend: true,
      startDate: '2027-01-05',
      bodyTemplate: 'Hi {{donorName}}',
    });
    const secondRow: LetterSendRow = { ...row, id: 43, donorItemId: 'donor-2' };
    const store = fakeStore(row);
    (store.getById as ReturnType<typeof vi.fn>).mockImplementation(async (id: number) => (id === 42 ? row : secondRow));
    const emailSender = fakeEmailSender();

    await processLetterSendBatch([makeMessage(42), makeMessage(43)], {
      store,
      monday,
      tokenStore: fakeTokenStore(),
      emailSender,
      config: configWithLetterCron,
      now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(monday.getLetterSettings).toHaveBeenCalledTimes(1);
    expect(emailSender.sendLetterReadyEmail).toHaveBeenCalledTimes(2);
    for (const call of (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0].bodyTemplate).toBe('Hi {{donorName}}');
    }
  });

  it('sends with the built-in copy when fetching the Letter Settings board fails', async () => {
    const monday = fakeMonday();
    (monday.getLetterSettings as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday: HTTP 500'));
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);

    await processLetterSendBatch([message], {
      store: fakeStore(row),
      monday,
      tokenStore: fakeTokenStore(),
      emailSender,
      config: configWithLetterCron,
      now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    expect(emailSender.sendLetterReadyEmail).toHaveBeenCalledTimes(1);
    expect((emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0].bodyTemplate).toBeUndefined();
    expect(message.ack).toHaveBeenCalled();
  });

  it('resolves the donor locale from Monday and localizes the email and portal link', async () => {
    const monday = fakeMonday();
    (monday.getDonorContactInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'donor-1', name: 'Juana Ejemplo', email: 'juana@example.org', address: '', phone: '', preferredLanguage: 'Spanish',
    });
    const emailSender = fakeEmailSender();

    await processLetterSendBatch([makeMessage(42)], {
      store: fakeStore(row),
      monday,
      tokenStore: fakeTokenStore(),
      emailSender,
      config,
      now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    const sent = (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.locale).toBe('es');
    expect(sent.loginUrl).toContain('?lang=es#');
  });

  it('defaults to English when the preferred language is unset or unrecognized', async () => {
    const monday = fakeMonday();
    (monday.getDonorContactInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'donor-1', name: 'Jane', email: 'jane@example.org', address: '', phone: '', preferredLanguage: 'Klingon',
    });
    const emailSender = fakeEmailSender();

    await processLetterSendBatch([makeMessage(42)], {
      store: fakeStore(row),
      monday,
      tokenStore: fakeTokenStore(),
      emailSender,
      config,
      now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    const sent = (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.locale).toBe('en');
    expect(sent.loginUrl).toContain('?lang=en#');
  });

  it('picks the donor locale’s template, falling back to the default template', async () => {
    const monday = fakeMonday();
    (monday.getLetterSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      autoSend: true,
      startDate: '2027-01-05',
      bodyTemplate: 'Default {{donorName}}',
      bodyTemplatesByLocale: { es: 'Hola {{donorName}}' },
    });
    (monday.getDonorContactInfo as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => ({
      id,
      name: id === 'donor-1' ? 'Juana' : 'Jane',
      email: `${id}@example.org`,
      address: '',
      phone: '',
      preferredLanguage: id === 'donor-1' ? 'Spanish' : 'Japanese',
    }));
    const secondRow: LetterSendRow = { ...row, id: 43, donorItemId: 'donor-2' };
    const store = fakeStore(row);
    (store.getById as ReturnType<typeof vi.fn>).mockImplementation(async (id: number) => (id === 42 ? row : secondRow));
    const emailSender = fakeEmailSender();

    await processLetterSendBatch([makeMessage(42), makeMessage(43)], {
      store,
      monday,
      tokenStore: fakeTokenStore(),
      emailSender,
      config: configWithLetterCron,
      now: () => new Date('2026-08-24T10:00:00.000Z'),
    });

    const calls = (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mock.calls;
    const spanish = calls.find((c) => c[0].locale === 'es')![0];
    const japanese = calls.find((c) => c[0].locale === 'ja')![0];
    expect(spanish.bodyTemplate).toBe('Hola {{donorName}}');
    expect(japanese.bodyTemplate).toBe('Default {{donorName}}'); // no ja column → default template
  });

  it('never reads the Letter Settings board while letterCron is unconfigured', async () => {
    const monday = fakeMonday();
    await processLetterSendBatch([makeMessage(42)], {
      store: fakeStore(row),
      monday,
      tokenStore: fakeTokenStore(),
      emailSender: fakeEmailSender(),
      config,
      now: () => new Date('2026-08-24T10:00:00.000Z'),
    });
    expect(monday.getLetterSettings).not.toHaveBeenCalled();
  });
});

describe('consumeLetterSendBatch (write switch)', () => {
  const gate = (mode: WriteMode): BatchSkipContext => ({ worker: 'member-portal', environment: 'production', mode, logLevel: 'normal', piiKeys: [] });
  const now = () => new Date('2026-08-24T10:00:00.000Z');

  it('under off sends no email, mints no token, changes no row, and acks', async () => {
    const store = fakeStore(row);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await consumeLetterSendBatch([message], { store, monday: fakeMonday(), tokenStore, emailSender, config, now }, gate('off'));

    expect(emailSender.sendLetterReadyEmail).not.toHaveBeenCalled();
    expect(tokenStore.createToken).not.toHaveBeenCalled();
    expect(store.claimForSending).not.toHaveBeenCalled();
    expect(store.markSent).not.toHaveBeenCalled();
    expect(store.releaseClaim).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    const skips = log.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((line) => line.writeSwitch === 'skipped');
    // The email is the one recorded sink: the claim is stood in for, so the dry run reaches it.
    expect(skips).toEqual([expect.objectContaining({ sink: 'Email', operation: 'sendLetterReadyEmail', deliveryId: 'letter-send:42' })]);
    log.mockRestore();
  });

  it('under off with debug logging masks the address, name and login link', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await consumeLetterSendBatch([makeMessage(42)], { store: fakeStore(row), monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender: fakeEmailSender(), config, now }, { ...gate('off'), logLevel: 'debug', piiKeys: MEMBER_PORTAL_PII_KEYS });

    const text = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('sendLetterReadyEmail');
    expect(text).not.toContain('jane@example.org');
    expect(text).not.toContain('Jane Example');
    expect(text).not.toContain('token=');
    log.mockRestore();
  });

  it('under off drops the deliberate skip too (letters not signed off)', async () => {
    const store = fakeStore(row);
    const unsignedConfig: Config = { ...config, taxLetter: { ...config.taxLetter, ein: 'REPLACE_AFTER_SIGNOFF' } };
    const message = makeMessage(42);

    await consumeLetterSendBatch([message], { store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender: fakeEmailSender(), config: unsignedConfig, now }, gate('off'));

    expect(store.markSkipped).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it.each<WriteMode>(['hold', 'unknown'])('under %s retries at 60 s without reading Monday', async (mode) => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    const message = makeMessage(42);

    await consumeLetterSendBatch([message], { store, monday, tokenStore: fakeTokenStore(), emailSender: fakeEmailSender(), config: configWithLetterCron, now }, gate(mode));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(store.getById).not.toHaveBeenCalled();
    expect(monday.getLetterSettings).not.toHaveBeenCalled();
  });

  it('sends an unstamped (pre-deploy) message under on', async () => {
    const store = fakeStore(row);
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);

    await consumeLetterSendBatch([message], { store, monday: fakeMonday(), tokenStore, emailSender, config, now }, gate('on'));

    expect(tokenStore.createToken).toHaveBeenCalledOnce();
    expect(emailSender.sendLetterReadyEmail).toHaveBeenCalledOnce();
    expect(store.markSent).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
  });

  it('dry-runs a message stamped dropped even under on', async () => {
    const emailSender = fakeEmailSender();
    const message = { ...makeMessage(42), body: { sendId: 42, writeStamp: 'dropped' as const } };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await consumeLetterSendBatch([message], { store: fakeStore(row), monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config, now }, gate('on'));

    expect(emailSender.sendLetterReadyEmail).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
