import { describe, it, expect, vi } from 'vitest';
import { runLetterCron } from './runLetterCron';
import type { LetterSendStore } from '../db/letterSends';
import type { MondayClient } from '../monday/client';
import type { Config } from '../types';

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
  letterCron: {
    boardId: 456,
    columns: { autoSend: 'checkbox_1', startDate: 'date_2', bodyTemplate: 'long_text_1', bodyTemplatesByLocale: {} },
    maxTriggersPerRun: 200,
  },
};

// 2027-01-15 → the cron targets letters for 2026.
const now = () => new Date('2027-01-15T10:00:00.000Z');

function fakeMonday(overrides: Partial<Record<keyof MondayClient, unknown>> = {}): MondayClient {
  return {
    getLetterSettings: vi.fn().mockResolvedValue({ autoSend: true, startDate: '2027-01-10', bodyTemplate: '' }),
    listDonorIdsWithDonationsInYear: vi.fn().mockResolvedValue(['d1', 'd2']),
    getDonorPortalData: vi.fn().mockImplementation(async (id: string) => ({
      id,
      name: `Donor ${id}`,
      membershipStatus: 'Active',
      membershipTier: 'Champion',
      totalDonated: '$50.00',
      donations: [{ date: '2026-03-01', amount: '$50.00', description: 'Gift' }],
      membershipExpiry: '',
    })),
    ...overrides,
  } as unknown as MondayClient;
}

function fakeStore(existingForYear: Set<string> = new Set()): LetterSendStore {
  let nextId = 1;
  return {
    findByDonorYear: vi.fn().mockResolvedValue(null),
    createQueued: vi.fn().mockImplementation(async () => nextId++),
    getById: vi.fn(),
    markSent: vi.fn(),
    markSkipped: vi.fn(),
    requeue: vi.fn(),
    listDonorItemIdsForYear: vi.fn().mockResolvedValue(existingForYear),
  };
}

function fakeQueue() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

describe('runLetterCron', () => {
  it('skips without touching Monday while letterCron is unconfigured', async () => {
    const monday = fakeMonday();
    const unconfigured: Config = { ...config, letterCron: { ...config.letterCron, boardId: null } };

    const result = await runLetterCron({ monday, letterStore: fakeStore(), queue: fakeQueue(), config: unconfigured, now });

    expect(result).toEqual({ kind: 'skipped', reason: 'unconfigured' });
    expect(monday.getLetterSettings).not.toHaveBeenCalled();
  });

  it('skips while the taxLetter language is not signed off', async () => {
    const monday = fakeMonday();
    const unsigned: Config = { ...config, taxLetter: { ...config.taxLetter, ein: 'REPLACE_AFTER_SIGNOFF' } };

    const result = await runLetterCron({ monday, letterStore: fakeStore(), queue: fakeQueue(), config: unsigned, now });

    expect(result).toEqual({ kind: 'skipped', reason: 'letters-not-signed-off' });
    expect(monday.getLetterSettings).not.toHaveBeenCalled();
  });

  it('skips when the settings board has no settings item', async () => {
    const monday = fakeMonday({ getLetterSettings: vi.fn().mockResolvedValue(null) });
    const result = await runLetterCron({ monday, letterStore: fakeStore(), queue: fakeQueue(), config, now });
    expect(result).toEqual({ kind: 'skipped', reason: 'no-settings' });
    expect(monday.listDonorIdsWithDonationsInYear).not.toHaveBeenCalled();
  });

  it('skips while the Auto-send checkbox is unchecked', async () => {
    const monday = fakeMonday({
      getLetterSettings: vi.fn().mockResolvedValue({ autoSend: false, startDate: '2027-01-10', bodyTemplate: '' }),
    });
    const result = await runLetterCron({ monday, letterStore: fakeStore(), queue: fakeQueue(), config, now });
    expect(result).toEqual({ kind: 'skipped', reason: 'auto-send-off' });
    expect(monday.listDonorIdsWithDonationsInYear).not.toHaveBeenCalled();
  });

  it('skips while the start date is unset', async () => {
    const monday = fakeMonday({
      getLetterSettings: vi.fn().mockResolvedValue({ autoSend: true, startDate: '', bodyTemplate: '' }),
    });
    const result = await runLetterCron({ monday, letterStore: fakeStore(), queue: fakeQueue(), config, now });
    expect(result).toEqual({ kind: 'skipped', reason: 'before-start-date' });
  });

  it('skips while today is before the start date', async () => {
    const monday = fakeMonday({
      getLetterSettings: vi.fn().mockResolvedValue({ autoSend: true, startDate: '2027-02-01', bodyTemplate: '' }),
    });
    const result = await runLetterCron({ monday, letterStore: fakeStore(), queue: fakeQueue(), config, now });
    expect(result).toEqual({ kind: 'skipped', reason: 'before-start-date' });
  });

  it('runs on the start date itself and queues a letter for every prior-year donor', async () => {
    const monday = fakeMonday({
      getLetterSettings: vi.fn().mockResolvedValue({ autoSend: true, startDate: '2027-01-15', bodyTemplate: '' }),
    });
    const store = fakeStore();
    const queue = fakeQueue();

    const result = await runLetterCron({ monday, letterStore: store, queue, config, now });

    expect(monday.listDonorIdsWithDonationsInYear).toHaveBeenCalledWith(2026);
    expect(result).toEqual({ kind: 'ran', year: 2026, eligible: 2, alreadyHandled: 0, triggered: 2, failed: 0, deferred: 0 });
    expect(queue.send).toHaveBeenCalledTimes(2);
  });

  it('spends no Monday calls on donors that already have a letter_sends row for the year', async () => {
    const monday = fakeMonday();
    const store = fakeStore(new Set(['d1']));
    const queue = fakeQueue();

    const result = await runLetterCron({ monday, letterStore: store, queue, config, now });

    expect(result).toEqual({ kind: 'ran', year: 2026, eligible: 2, alreadyHandled: 1, triggered: 1, failed: 0, deferred: 0 });
    expect(monday.getDonorPortalData).toHaveBeenCalledTimes(1);
    expect(monday.getDonorPortalData).toHaveBeenCalledWith('d2');
  });

  it('defers donors beyond maxTriggersPerRun to the next daily run', async () => {
    const monday = fakeMonday({
      listDonorIdsWithDonationsInYear: vi.fn().mockResolvedValue(['d1', 'd2', 'd3']),
    });
    const capped: Config = { ...config, letterCron: { ...config.letterCron, maxTriggersPerRun: 2 } };
    const result = await runLetterCron({ monday, letterStore: fakeStore(), queue: fakeQueue(), config: capped, now });

    expect(result).toEqual({ kind: 'ran', year: 2026, eligible: 3, alreadyHandled: 0, triggered: 2, failed: 0, deferred: 1 });
    expect(monday.getDonorPortalData).toHaveBeenCalledTimes(2);
  });

  it('logs and continues past a donor whose trigger throws', async () => {
    const monday = fakeMonday();
    (monday.getDonorPortalData as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === 'd1') throw new Error('monday: HTTP 500');
      return {
        id,
        name: `Donor ${id}`,
        membershipStatus: 'Active',
        membershipTier: 'Champion',
        totalDonated: '$50.00',
        donations: [{ date: '2026-03-01', amount: '$50.00', description: 'Gift' }],
        membershipExpiry: '',
      };
    });
    const queue = fakeQueue();

    const result = await runLetterCron({ monday, letterStore: fakeStore(), queue, config, now });

    expect(result).toEqual({ kind: 'ran', year: 2026, eligible: 2, alreadyHandled: 0, triggered: 1, failed: 1, deferred: 0 });
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it('skips while monday.donationsBoardId is unset, even with letterCron filled in', async () => {
    const monday = fakeMonday();
    const noBoard: Config = { ...config, monday: { ...config.monday, donationsBoardId: null } };

    const result = await runLetterCron({ monday, letterStore: fakeStore(), queue: fakeQueue(), config: noBoard, now });

    expect(result).toEqual({ kind: 'skipped', reason: 'unconfigured' });
    expect(monday.getLetterSettings).not.toHaveBeenCalled();
  });

  it('returns an error result instead of throwing when the settings read fails', async () => {
    const monday = fakeMonday({ getLetterSettings: vi.fn().mockRejectedValue(new Error('monday: HTTP 500')) });

    const result = await runLetterCron({ monday, letterStore: fakeStore(), queue: fakeQueue(), config, now });

    expect(result).toEqual({ kind: 'error', message: 'monday: HTTP 500' });
  });

  it('returns an error result instead of throwing when the donations sweep fails', async () => {
    const monday = fakeMonday({
      listDonorIdsWithDonationsInYear: vi.fn().mockRejectedValue(new Error('monday: HTTP 429')),
    });

    const result = await runLetterCron({ monday, letterStore: fakeStore(), queue: fakeQueue(), config, now });

    expect(result).toEqual({ kind: 'error', message: 'monday: HTTP 429' });
  });

  it('counts a donor whose gifts vanished since the sweep as triggered work, not a failure', async () => {
    // listLetterYears sees no completed prior year → triggerLetterSend returns 'no-eligible-year'.
    const monday = fakeMonday({
      listDonorIdsWithDonationsInYear: vi.fn().mockResolvedValue(['d1']),
    });
    (monday.getDonorPortalData as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'd1',
      name: 'Donor d1',
      membershipStatus: 'Active',
      membershipTier: 'Champion',
      totalDonated: '$0.00',
      donations: [],
      membershipExpiry: '',
    });
    const queue = fakeQueue();

    const result = await runLetterCron({ monday, letterStore: fakeStore(), queue, config, now });

    expect(result).toEqual({ kind: 'ran', year: 2026, eligible: 1, alreadyHandled: 0, triggered: 0, failed: 0, deferred: 0 });
    expect(queue.send).not.toHaveBeenCalled();
  });
});
