import { describe, it, expect, vi } from 'vitest';
import { processLetterSendBatch } from './processLetterSendBatch';
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
  email: { fromAddress: 'a@example.org', fromName: 'Test' },
  auth: { magicLinkTtlMinutes: 15, sessionTtlHours: 24, portalBaseUrl: 'https://portal.example.org' },
  rateLimit: { emailWindowSeconds: 900, emailMaxAttempts: 5 },
  taxLetter: {
    orgLegalName: 'SVBC',
    ein: '00-0000000',
    officeAddress: 'addr',
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
  volunteerHistory: { completedStatuses: ['Completed'] },
  donations: { countableStatuses: ['Received', 'Received (Historical)'] },
  eventRegistrations: {
    boardId: null,
    columns: { attendeeLink: 'connect_att', eventLink: 'connect_ev', attended: 'check_att' },
    eventDateColumnId: 'ev_date_col',
  },
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

function makeMessage(sendId: number) {
  return { body: { sendId }, ack: vi.fn(), retry: vi.fn() };
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
  };
}

function fakeMonday(): MondayClient {
  return {
    getDonorPortalData: vi.fn().mockResolvedValue({
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
    expect(sentEmailUrl).toContain('https://portal.example.org/auth/callback?token=');
    expect(store.markSent).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
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
    const monday = { ...fakeMonday(), getDonorPortalData: vi.fn().mockResolvedValue({
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
    expect(sent.loginUrl).toContain('&lang=es');
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
    expect(sent.loginUrl).toContain('&lang=en');
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
