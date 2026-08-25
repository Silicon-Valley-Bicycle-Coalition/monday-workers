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
  monday: { apiUrl: 'x', donorsBoardId: 1, donationsBoardId: 2, organizationsBoardId: 3, columns: {} as never },
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
});
